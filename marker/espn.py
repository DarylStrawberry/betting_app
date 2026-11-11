"""Schedules and results from ESPN's public scoreboard.

These are the same endpoints the ESPN site uses. They are unofficial, so a
sport can come back empty. The ledger still works with custom events.
"""

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from marker.util import normalize_time

log = logging.getLogger("marker")

SPORTS = [
    {"id": "nfl", "label": "NFL", "group": "Football", "path": "football/nfl", "mode": "week"},
    {"id": "nba", "label": "NBA", "group": "Basketball", "path": "basketball/nba", "mode": "days", "days": 7},
    {"id": "nhl", "label": "NHL", "group": "Hockey", "path": "hockey/nhl", "mode": "days", "days": 7},
    {"id": "ncaaf", "label": "College football", "group": "Football", "path": "football/college-football", "mode": "week"},
    {"id": "ncaab", "label": "College basketball", "group": "Basketball", "path": "basketball/mens-college-basketball", "mode": "days", "days": 7},
    {"id": "ufc", "label": "UFC", "group": "Combat", "path": "mma/ufc", "mode": "ufc"},
    {"id": "f1", "label": "Formula 1", "group": "Racing", "path": "racing/f1", "mode": "f1"},
    {"id": "epl", "label": "Premier League", "group": "Soccer", "path": "soccer/eng.1", "mode": "days", "days": 10},
    {"id": "ucl", "label": "Champions League", "group": "Soccer", "path": "soccer/uefa.champions", "mode": "days", "days": 10},
    {"id": "mls", "label": "MLS", "group": "Soccer", "path": "soccer/usa.1", "mode": "days", "days": 8},
    {"id": "atp", "label": "ATP tennis", "group": "Tennis", "path": "tennis/atp", "mode": "days", "days": 5},
    {"id": "pga", "label": "PGA Tour", "group": "Golf", "path": "golf/pga", "mode": "days", "days": 7},
    {"id": "mlb", "label": "MLB", "group": "Baseball", "path": "baseball/mlb", "mode": "days", "days": 5},
]

SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard"
UFC_DAYS = "https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/calendar/ondays?lang=en&region=us"
F1_EVENTS = "https://sports.core.api.espn.com/v2/sports/racing/leagues/f1/seasons/{year}/types/2/events?limit=40"


class FeedError(Exception):
    pass


def sport_by_id(sport_id: str) -> dict | None:
    return next((sport for sport in SPORTS if sport["id"] == sport_id), None)


def load_sport(sport_id: str) -> list[dict]:
    sport = sport_by_id(sport_id)
    if sport is None:
        raise FeedError("Unknown sport")
    mode = sport["mode"]
    if mode == "week":
        events = _load_week(sport)
    elif mode == "ufc":
        events = _load_ufc(sport)
    elif mode == "f1":
        events = _load_f1(sport)
    else:
        events = _load_days(sport)
    return _dedupe(events)


def events_from_scoreboard(sport: dict, payload: dict) -> list[dict]:
    """Turn one scoreboard payload into ledger events. Used by tests."""
    if sport["mode"] == "ufc":
        return _fights(sport, payload)
    found = []
    for raw in payload.get("events") or []:
        event = _standard_event(sport, raw)
        if event:
            found.append(event)
    return found


def _load_week(sport: dict) -> list[dict]:
    first = _scoreboard(sport["path"])
    if not first:
        raise FeedError(f"Could not reach the {sport['label']} schedule")
    payloads = [first]
    week = (first.get("week") or {}).get("number")
    season = first.get("season") or {}
    year = season.get("year")
    season_type = season.get("type")
    if isinstance(season_type, dict):
        season_type = season_type.get("type") or season_type.get("id")
    if week and year and season_type:
        for nearby in (int(week) - 1, int(week) + 1):
            if nearby < 1:
                continue
            extra = _scoreboard(sport["path"], dates=year, seasontype=season_type, week=nearby)
            if extra:
                payloads.append(extra)
    return _from_payloads(sport, payloads)


def _load_days(sport: dict) -> list[dict]:
    span = int(sport.get("days") or 7)
    start = date.today() - timedelta(days=1)
    stamps = [(start + timedelta(days=offset)).strftime("%Y%m%d") for offset in range(span + 1)]
    payloads = _scoreboards(sport["path"], stamps)
    if payloads and all(item is None for item in payloads):
        raise FeedError(f"Could not reach the {sport['label']} schedule")
    return _from_payloads(sport, payloads)


def _load_ufc(sport: dict) -> list[dict]:
    stamps = _ufc_dates()
    if not stamps:
        start = date.today() - timedelta(days=1)
        stamps = [(start + timedelta(days=offset)).strftime("%Y%m%d") for offset in range(22)]
    payloads = _scoreboards(sport["path"], stamps)
    if payloads and all(item is None for item in payloads):
        raise FeedError("Could not reach the UFC schedule")
    found = []
    for payload in payloads:
        if payload:
            found.extend(_fights(sport, payload))
    return found


def _load_f1(sport: dict) -> list[dict]:
    shells = _f1_shells()
    if not shells:
        # One scoreboard call still returns the current grand prix.
        payload = _scoreboard(sport["path"])
        if not payload:
            raise FeedError("Could not reach the Formula 1 schedule")
        return events_from_scoreboard(sport, payload)
    stamps = sorted({shell["day"] for shell in shells})
    payloads = _scoreboards(sport["path"], stamps)
    found = []
    for payload in payloads:
        if payload:
            found.extend(events_from_scoreboard(sport, payload))
    covered = {event["id"] for event in found}
    covered_days = {event["startTime"][:10] for event in found}
    for shell in shells:
        if shell["id"] in covered or shell["date"][:10] in covered_days:
            continue
        found.append(_shell_event(sport, shell))
    if not found and all(item is None for item in payloads):
        raise FeedError("Could not reach the Formula 1 schedule")
    return found


def _from_payloads(sport: dict, payloads: list) -> list[dict]:
    found = []
    for payload in payloads:
        if payload:
            found.extend(events_from_scoreboard(sport, payload))
    return found


def _fights(sport: dict, payload: dict) -> list[dict]:
    found = []
    for raw in payload.get("events") or []:
        card = raw.get("name") or raw.get("shortName") or "UFC"
        venue = _venue_name(raw, {})
        for comp in raw.get("competitions") or []:
            weight = ((comp.get("type") or {}).get("abbreviation") or "").strip()
            competitors = _competitors(comp, keep_winners=True)
            if len(competitors) >= 2:
                title = f"{competitors[0]['name']} vs {competitors[1]['name']}"
            else:
                title = raw.get("name") or "UFC bout"
            subtitle = " · ".join(part for part in (card, weight) if part)
            start = comp.get("date") or raw.get("date")
            try:
                start_time = normalize_time(start)
            except ValueError:
                continue
            status, detail = _status(comp.get("status") or raw.get("status"))
            found.append(
                _event(
                    sport,
                    f"{raw.get('id')}_{comp.get('id')}",
                    title,
                    subtitle or venue,
                    start_time,
                    status,
                    detail,
                    competitors,
                )
            )
    return found


def _standard_event(sport: dict, raw: dict) -> dict | None:
    competitions = raw.get("competitions") or []
    if sport["mode"] == "f1":
        return _grand_prix(sport, raw, competitions)
    comp = competitions[0] if competitions else {}
    competitors = _competitors(comp, keep_winners=True)
    title = raw.get("name") or raw.get("shortName") or ""
    if not title:
        return None
    start = (comp or {}).get("date") or raw.get("date")
    try:
        start_time = normalize_time(start)
    except ValueError:
        return None
    status, detail = _status((comp or {}).get("status") or raw.get("status"))
    venue = _venue_name(raw, comp or {})
    return _event(sport, str(raw.get("id")), title, venue, start_time, status, detail, competitors)


def _grand_prix(sport: dict, raw: dict, competitions: list) -> dict | None:
    race = _preferred_session(competitions, "race") or (competitions[-1] if competitions else {})
    drivers = _drivers(competitions, race)
    title = raw.get("name") or raw.get("shortName") or "Grand Prix"
    start = (race or {}).get("date") or raw.get("date")
    try:
        start_time = normalize_time(start)
    except ValueError:
        return None
    status, detail = _status((race or {}).get("status") or raw.get("status"))
    circuit = _circuit_name(raw)
    subtitle = " · ".join(part for part in (circuit, detail) if part)
    return _event(sport, str(raw.get("id")), title, subtitle, start_time, status, detail, drivers)


def _preferred_session(competitions: list, kind: str) -> dict | None:
    for comp in competitions:
        label = _session_label(comp)
        if kind == "race" and "race" in label and "sprint" not in label:
            return comp
    return None


def _session_label(comp: dict) -> str:
    kind = comp.get("type") or {}
    return " ".join(
        str(kind.get(key) or "") for key in ("abbreviation", "text", "name")
    ).lower()


def _drivers(competitions: list, race: dict) -> list[dict]:
    race_drivers = _competitors(race, keep_winners=True) if race else []
    if race_drivers:
        race_drivers.sort(key=lambda item: item["name"].casefold())
        return race_drivers
    pooled: dict[str, dict] = {}
    for comp in competitions:
        for driver in _competitors(comp, keep_winners=False):
            pooled.setdefault(driver["name"].casefold(), driver)
    drivers = list(pooled.values())
    drivers.sort(key=lambda item: item["name"].casefold())
    return drivers


def _competitors(comp: dict, *, keep_winners: bool) -> list[dict]:
    found = []
    for raw in (comp or {}).get("competitors") or []:
        name = _competitor_name(raw)
        if not name:
            continue
        side = raw.get("homeAway") or ""
        score = raw.get("score")
        if isinstance(score, dict):
            score = score.get("displayValue") or score.get("value") or ""
        score = "" if score is None else str(score)
        if score in ("0", "0.0") and not keep_winners:
            score = ""
        rank = _rank(raw)
        color = ""
        team = raw.get("team") or {}
        if isinstance(team, dict) and team.get("color"):
            color = "#" + str(team["color"]).lstrip("#")
        found.append(
            {
                "name": name,
                "side": side if side in ("home", "away") else "",
                "winner": bool(raw.get("winner")) if keep_winners else False,
                "score": score if keep_winners else "",
                "record": _record(raw),
                "color": color,
                "rank": rank,
            }
        )
    if any(item["side"] in ("home", "away") for item in found):
        order = {"away": 0, "home": 1}
        found.sort(key=lambda item: order.get(item["side"], 2))
    return found


def _competitor_name(raw: dict) -> str:
    team = raw.get("team") or {}
    if isinstance(team, dict):
        name = team.get("displayName") or team.get("name") or ""
        if name:
            return str(name)
    athlete = raw.get("athlete") or {}
    if isinstance(athlete, dict):
        name = athlete.get("displayName") or athlete.get("fullName") or ""
        if name:
            return str(name)
    return str(raw.get("name") or "")


def _record(raw: dict) -> str:
    records = raw.get("records") or []
    for item in records:
        if item.get("type") in (None, "total") or item.get("name") in ("overall", "total"):
            if item.get("summary"):
                return str(item["summary"])
    if records and records[0].get("summary"):
        return str(records[0]["summary"])
    return ""


def _rank(raw: dict):
    curated = raw.get("curatedRank")
    value = curated.get("current") if isinstance(curated, dict) else None
    if isinstance(value, int) and 1 <= value <= 25:
        return value
    return None


def _status(status: dict | None) -> tuple[str, str]:
    kind = (status or {}).get("type") or {}
    name = str(kind.get("name") or "").upper()
    state = kind.get("state") or "pre"
    detail = str(kind.get("shortDetail") or kind.get("detail") or "")
    if "POSTPON" in name or "DELAY" in name or "SUSPEND" in name:
        return "postponed", detail or "Postponed"
    if "CANCEL" in name:
        return "cancelled", detail or "Cancelled"
    if state == "in":
        return "live", detail or "Live"
    if state == "post" or kind.get("completed"):
        return "final", detail or "Final"
    return "scheduled", detail


def _venue_name(event: dict, comp: dict) -> str:
    venue = (comp or {}).get("venue") or {}
    if isinstance(venue, dict):
        name = venue.get("fullName") or venue.get("displayName") or ""
        if name:
            return str(name)
    venues = event.get("venues") or []
    if venues and isinstance(venues[0], dict):
        return str(venues[0].get("fullName") or "")
    return _circuit_name(event)


def _circuit_name(event: dict) -> str:
    circuit = event.get("circuit") or {}
    if isinstance(circuit, dict):
        return str(circuit.get("fullName") or circuit.get("name") or "")
    return ""


def _event(sport, key, title, subtitle, start_time, status, detail, competitors) -> dict:
    safe_key = "".join(ch if ch.isalnum() else "_" for ch in str(key))
    return {
        "id": f"espn_{sport['id']}_{safe_key}",
        "sport": sport["id"],
        "league": sport["label"],
        "title": title,
        "subtitle": subtitle or "",
        "startTime": start_time,
        "status": status,
        "detail": detail or "",
        "source": "espn",
        "competitors": competitors,
    }


def _shell_event(sport: dict, shell: dict) -> dict:
    end = shell.get("end") or shell["date"]
    status = "final" if end < _utc_now() else "scheduled"
    return _event(
        sport,
        shell["espnId"],
        shell["name"],
        "Driver list unavailable — a prop bet still works",
        shell["date"],
        status,
        "",
        [],
    )


def _f1_shells() -> list[dict]:
    year = datetime.now(timezone.utc).year
    listing = _get_json(F1_EVENTS.format(year=year))
    if not listing:
        return []
    refs = []
    for item in listing.get("items") or []:
        ref = item.get("$ref") if isinstance(item, dict) else None
        if ref:
            refs.append(ref.replace("http://", "https://", 1))
    documents = _map_get(refs)
    start = date.today() - timedelta(days=7)
    end = date.today() + timedelta(days=150)
    shells = []
    for document in documents:
        if not document or not document.get("date") or not document.get("id"):
            continue
        try:
            start_time = normalize_time(document["date"])
        except ValueError:
            continue
        try:
            end_time = normalize_time(document.get("endDate") or document["date"])
        except ValueError:
            end_time = start_time
        day = datetime.strptime(start_time[:10], "%Y-%m-%d").date()
        end_day = datetime.strptime(end_time[:10], "%Y-%m-%d").date()
        if end_day < start or day > end:
            continue
        shells.append(
            {
                "espnId": str(document["id"]),
                "id": f"espn_f1_{document['id']}",
                "name": document.get("name") or document.get("shortName") or "Grand Prix",
                "date": start_time,
                "end": end_time,
                "day": day.strftime("%Y%m%d"),
            }
        )
    return shells


def _ufc_dates() -> list[str]:
    payload = _get_json(UFC_DAYS)
    raw_dates = ((payload or {}).get("eventDate") or {}).get("dates") or []
    start = date.today() - timedelta(days=2)
    end = date.today() + timedelta(days=70)
    stamps = []
    for value in raw_dates:
        text = str(value)[:10]
        try:
            day = datetime.strptime(text, "%Y-%m-%d").date()
        except ValueError:
            continue
        if start <= day <= end:
            stamps.append(day.strftime("%Y%m%d"))
    return sorted(set(stamps))


def _scoreboard(path: str, **params):
    url = SCOREBOARD.format(path=path)
    if params:
        cleaned = {key: value for key, value in params.items() if value is not None}
        url = url + "?" + urlencode(cleaned)
    return _get_json(url)


def _scoreboards(path: str, stamps: list[str]) -> list:
    urls = [SCOREBOARD.format(path=path) + "?" + urlencode({"dates": stamp}) for stamp in stamps]
    return _map_get(urls)


def _map_get(urls: list[str]) -> list:
    if not urls:
        return []
    found = [None] * len(urls)
    workers = min(8, len(urls))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_get_json, url): index for index, url in enumerate(urls)}
        for future in as_completed(futures):
            found[futures[future]] = future.result()
    return found


def _get_json(url: str):
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; Marker/0.1)",
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        log.warning("schedule fetch failed: %s (%s)", url, exc)
        return None


def _dedupe(events: list[dict]) -> list[dict]:
    by_id = {}
    for event in events:
        by_id[event["id"]] = event
    return list(by_id.values())


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
