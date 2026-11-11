"""The book: people, events, bets, and the record between them."""

import csv
import hashlib
import hmac
import io
import json
import logging
import math
import re
import secrets
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from uuid import uuid4

from marker import db
from marker.errors import BookError
from marker.espn import SPORTS, FeedError, load_sport, sport_by_id
from marker.util import normalize_time, now_iso, shift_iso

log = logging.getLogger("marker")

PALETTE = [
    "#1f6a4e",
    "#8d6420",
    "#8e3b32",
    "#2a4e86",
    "#6a4584",
    "#1f6f78",
    "#8a4b2f",
    "#3e5c2f",
    "#6e4a6a",
    "#3f4f6b",
]

PBKDF2_ITERS = 200_000
SESSION_SECONDS = 30 * 24 * 60 * 60
_DUMMY_HASH: str | None = None


def meta() -> dict:
    return {
        "people": list_people(),
        "currencies": list_currencies(),
        "sports": [{"id": sport["id"], "label": sport["label"], "group": sport["group"]} for sport in SPORTS]
        + [{"id": "custom", "label": "Custom", "group": "Yours"}],
    }


def list_people() -> list[dict]:
    with db.tx() as connection:
        rows = connection.execute(
            """
            SELECT p.*,
                (SELECT COUNT(*) FROM bets b
                 WHERE b.maker_id = p.id OR b.taker_id = p.id) AS bet_count
            FROM people p
            ORDER BY p.created_at
            """
        ).fetchall()
    return [_person(row, row["bet_count"]) for row in rows]


def list_currencies() -> list[dict]:
    with db.tx() as connection:
        rows = connection.execute(
            "SELECT * FROM currencies ORDER BY sort_order, code"
        ).fetchall()
    return [_currency(row) for row in rows]


def register(name: str, password: str) -> tuple[dict, str]:
    cleaned = _clean_name(name)
    secret = _require_password(password)
    with db.tx() as connection:
        existing = list(connection.execute("SELECT name, color FROM people"))
        if any(row["name"].casefold() == cleaned.casefold() for row in existing):
            raise BookError("That name is already at the table.")
        used = {row["color"] for row in existing}
        color = next((item for item in PALETTE if item not in used), PALETTE[len(existing) % len(PALETTE)])
        person_id = uuid4().hex
        connection.execute(
            "INSERT INTO people (id, name, color, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
            (person_id, cleaned, color, _hash_password(secret), now_iso()),
        )
        token = _start_session(connection, person_id)
        row = connection.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        person = _person_brief(row)
    return person, token


def login(name: str, password: str) -> tuple[dict, str]:
    cleaned = " ".join(str(name or "").split())
    secret = password if isinstance(password, str) else ""
    with db.tx() as connection:
        rows = connection.execute("SELECT * FROM people").fetchall()
        match = next((row for row in rows if row["name"].casefold() == cleaned.casefold()), None)
        stored = match["password_hash"] if match is not None else None
        password_ok = _verify_password(secret, stored)
        if match is None or not password_ok:
            raise BookError("That name or password is wrong.", 401)
        token = _start_session(connection, match["id"])
        person = _person_brief(match)
    return person, token


def logout(token: str | None) -> None:
    if not token:
        return
    with db.tx() as connection:
        connection.execute("DELETE FROM sessions WHERE token = ?", (token,))


def actor_from_token(token: str | None) -> dict | None:
    if not token or len(token) > 200:
        return None
    with db.tx() as connection:
        row = connection.execute(
            """
            SELECT s.expires_at, p.id, p.name, p.color
            FROM sessions s
            JOIN people p ON p.id = s.person_id
            WHERE s.token = ?
            """,
            (token,),
        ).fetchone()
        if row is None:
            return None
        if row["expires_at"] <= now_iso():
            connection.execute("DELETE FROM sessions WHERE token = ?", (token,))
            return None
        return _person_brief(row)


def session_view(actor: dict | None) -> dict:
    with db.tx() as connection:
        count = connection.execute("SELECT COUNT(*) AS n FROM people").fetchone()["n"]
    return {"person": actor, "needsAccount": count == 0}


def rename_person(person_id: str, name: str, actor_id: str) -> dict:
    _require_self(person_id, actor_id)
    cleaned = _clean_name(name)
    with db.tx() as connection:
        row = connection.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        if row is None:
            raise BookError("That person is not at the table.", 404)
        others = connection.execute("SELECT id, name FROM people WHERE id != ?", (person_id,)).fetchall()
        if any(item["name"].casefold() == cleaned.casefold() for item in others):
            raise BookError("That name is already at the table.")
        connection.execute("UPDATE people SET name = ? WHERE id = ?", (cleaned, person_id))
        updated = connection.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        count = connection.execute(
            "SELECT COUNT(*) AS n FROM bets WHERE maker_id = ? OR taker_id = ?",
            (person_id, person_id),
        ).fetchone()["n"]
    return _person(updated, count)


def delete_person(person_id: str, actor_id: str) -> None:
    _require_self(person_id, actor_id)
    with db.tx() as connection:
        row = connection.execute("SELECT 1 FROM people WHERE id = ?", (person_id,)).fetchone()
        if row is None:
            raise BookError("That person is not at the table.", 404)
        count = connection.execute(
            "SELECT COUNT(*) AS n FROM bets WHERE maker_id = ? OR taker_id = ?",
            (person_id, person_id),
        ).fetchone()["n"]
        if count:
            raise BookError("Can't remove someone who has bets in the book.")
        connection.execute("DELETE FROM sessions WHERE person_id = ?", (person_id,))
        connection.execute("DELETE FROM people WHERE id = ?", (person_id,))


def add_currency(body: dict) -> dict:
    code = str(body.get("code") or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{2,8}", code):
        raise BookError("Use 2 to 8 letters or numbers for the code.")
    name = _clean(body.get("name"), 40, "Name the currency.")
    symbol = " ".join(str(body.get("symbol") or "").split())
    if not symbol or len(symbol) > 8:
        raise BookError("Give it a short symbol.")
    try:
        decimals = int(body.get("decimals"))
    except (TypeError, ValueError):
        raise BookError("Decimals should be a number from 0 to 8.")
    if decimals < 0 or decimals > 8:
        raise BookError("Decimals should be a number from 0 to 8.")
    with db.tx() as connection:
        if connection.execute("SELECT 1 FROM currencies WHERE code = ?", (code,)).fetchone():
            raise BookError("That currency is already in the book.")
        connection.execute(
            """
            INSERT INTO currencies (code, name, symbol, decimals, kind, sort_order)
            VALUES (?, ?, ?, ?, 'custom', 1000)
            """,
            (code, name, symbol, decimals),
        )
        row = connection.execute("SELECT * FROM currencies WHERE code = ?", (code,)).fetchone()
    return _currency(row)


def delete_currency(code: str) -> None:
    code = (code or "").upper()
    with db.tx() as connection:
        row = connection.execute("SELECT * FROM currencies WHERE code = ?", (code,)).fetchone()
        if row is None:
            raise BookError("That currency is not in the book.", 404)
        if row["kind"] != "custom":
            raise BookError("The built-in currencies stay in the book.")
        if connection.execute("SELECT 1 FROM bets WHERE currency_code = ?", (code,)).fetchone():
            raise BookError("That currency is already on a bet.")
        connection.execute("DELETE FROM currencies WHERE code = ?", (code,))


def list_events(sport_id: str, refresh: bool = False) -> dict:
    sport_id = (sport_id or "nfl").strip().lower()
    if sport_id != "custom" and sport_by_id(sport_id) is None:
        raise BookError("Unknown sport.", 404)
    warning = ""
    if sport_id != "custom":
        warning = _maybe_sync(sport_id, force=refresh)
    cutoff = shift_iso(days=-5)
    with db.tx() as connection:
        rows = connection.execute(
            """
            SELECT * FROM events
            WHERE sport = ?
              AND (start_time >= ? OR status = 'live')
              AND status != 'cancelled'
            ORDER BY CASE status
                WHEN 'live' THEN 0
                WHEN 'scheduled' THEN 1
                WHEN 'postponed' THEN 2
                ELSE 3 END,
                start_time
            """,
            (sport_id, cutoff),
        ).fetchall()
        sync = connection.execute("SELECT * FROM syncs WHERE sport = ?", (sport_id,)).fetchone()
    return {
        "sport": sport_id,
        "events": [_event_public(row) for row in rows],
        "sync": _sync_public(sync),
        "warning": warning,
    }


def get_event(event_id: str) -> dict:
    with db.tx() as connection:
        row = connection.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
        if row is None:
            raise BookError("That event is not in the book.", 404)
        return _event_public(row)


def create_event(body: dict) -> dict:
    with db.tx() as connection:
        row = _insert_event(connection, body or {})
        return _event_public(row)


def list_bets(status: str = "all", person: str | None = None) -> dict:
    where, args = _bet_filter(status, person)
    with db.tx() as connection:
        people, currencies = _lookups(connection)
        bets = _present_bets(
            connection,
            people,
            currencies,
            where,
            args,
            "COALESCE(settled_at, event_start, created_at) DESC",
        )
    return {"bets": bets}


def create_bet(body: dict, actor_id: str) -> dict:
    body = body or {}
    with db.tx() as connection:
        people, currencies = _lookups(connection)
        actor = _require_person(people, actor_id)
        logging_past = bool(body.get("outcome"))
        if logging_past:
            maker = _require_person(people, body.get("makerId"))
            taker = _require_person(people, body.get("takerId"))
            if actor["id"] not in (maker["id"], taker["id"]):
                raise BookError("You have to be on a bet you log.")
        else:
            if body.get("makerId") and body.get("makerId") != actor["id"]:
                raise BookError("You can only propose a bet as yourself.")
            maker = actor
            taker = _require_person(people, body.get("takerId"))
        if maker["id"] == taker["id"]:
            raise BookError("A bet needs two different people.")
        currency = currencies.get(str(body.get("currency") or "").upper())
        if currency is None:
            raise BookError("Choose a currency.")
        maker_pick = _clean(body.get("makerPick"), 120, "Both sides need a pick.")
        taker_pick = _clean(body.get("takerPick"), 120, "Both sides need a pick.")
        if maker_pick.casefold() == taker_pick.casefold():
            raise BookError("The two picks are the same.")
        maker_stake = _parse_amount(body.get("makerStake"), currency["decimals"])
        taker_stake = _parse_amount(body.get("takerStake"), currency["decimals"])
        note = _note(body.get("note"))
        if body.get("event") and not body.get("eventId"):
            event_body = body["event"]
            if not event_body.get("competitors"):
                event_body["competitors"] = [maker_pick, taker_pick]
            if logging_past:
                event_body.setdefault("status", "final")
        event_row = _resolve_event(connection, body)
        status = "proposed"
        winner = None
        settled = None
        if logging_past:
            status, winner, settled = _outcome_fields(body.get("outcome"), maker["id"], taker["id"])
        bet_id = uuid4().hex
        connection.execute(
            """
            INSERT INTO bets (
                id, event_id, event_title, event_sport, event_league, event_start,
                maker_id, taker_id, maker_pick, taker_pick, maker_stake, taker_stake,
                currency_code, note, status, winner_id, created_at, settled_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                bet_id,
                event_row["id"],
                event_row["title"],
                event_row["sport"],
                event_row["league"],
                event_row["start_time"],
                maker["id"],
                taker["id"],
                maker_pick,
                taker_pick,
                maker_stake,
                taker_stake,
                currency["code"],
                note,
                status,
                winner,
                now_iso(),
                settled,
            ),
        )
        return _present_one(connection, bet_id)


def patch_bet(bet_id: str, body: dict, actor_id: str) -> dict:
    body = body or {}
    with db.tx() as connection:
        row = _must_bet(connection, bet_id)
        _require_actor_on_bet(row, actor_id)
        if set(body.keys()) <= {"note"}:
            if row["status"] == "proposed" and row["maker_id"] != actor_id:
                raise BookError("Only the person who proposed this can change it.", 403)
            if row["status"] in ("declined", "withdrawn"):
                raise BookError("That bet is already closed.")
            connection.execute("UPDATE bets SET note = ? WHERE id = ?", (_note(body.get("note")), bet_id))
            return _present_one(connection, bet_id)
        if row["status"] != "proposed":
            raise BookError("Terms are locked once the bet is accepted. You can still change the note.")
        if row["maker_id"] != actor_id:
            raise BookError("Only the person who proposed this can change it.", 403)
        if body.get("makerId") and body.get("makerId") != row["maker_id"]:
            raise BookError("You stay on your side of the bet.")
        people, currencies = _lookups(connection)
        maker = _require_person(people, row["maker_id"])
        taker = _require_person(people, body.get("takerId") or row["taker_id"])
        if maker["id"] == taker["id"]:
            raise BookError("A bet needs two different people.")
        code = str(body.get("currency") or row["currency_code"]).upper()
        currency = currencies.get(code)
        if currency is None:
            raise BookError("Choose a currency.")
        maker_pick = _clean(body.get("makerPick", row["maker_pick"]), 120, "Both sides need a pick.")
        taker_pick = _clean(body.get("takerPick", row["taker_pick"]), 120, "Both sides need a pick.")
        if maker_pick.casefold() == taker_pick.casefold():
            raise BookError("The two picks are the same.")
        if "makerStake" in body:
            maker_stake = _parse_amount(body.get("makerStake"), currency["decimals"])
        elif code != row["currency_code"]:
            raise BookError("Enter the stakes again when you change currency.")
        else:
            maker_stake = row["maker_stake"]
        if "takerStake" in body:
            taker_stake = _parse_amount(body.get("takerStake"), currency["decimals"])
        elif code != row["currency_code"]:
            raise BookError("Enter the stakes again when you change currency.")
        else:
            taker_stake = row["taker_stake"]
        connection.execute(
            """
            UPDATE bets
            SET maker_id = ?, taker_id = ?, maker_pick = ?, taker_pick = ?,
                maker_stake = ?, taker_stake = ?, currency_code = ?, note = ?
            WHERE id = ?
            """,
            (
                maker["id"],
                taker["id"],
                maker_pick,
                taker_pick,
                maker_stake,
                taker_stake,
                currency["code"],
                _note(body.get("note", row["note"])),
                bet_id,
            ),
        )
        return _present_one(connection, bet_id)


def settle(bet_id: str, result: str, actor_id: str) -> dict:
    with db.tx() as connection:
        row = _must_bet(connection, bet_id)
        _require_actor_on_bet(row, actor_id)
        if row["status"] != "open":
            if row["status"] == "proposed":
                raise BookError("Accept the bet before settling it.")
            raise BookError("That bet is already settled. Reopen it to change the result.")
        status, winner, settled = _outcome_fields(result, row["maker_id"], row["taker_id"])
        connection.execute(
            "UPDATE bets SET status = ?, winner_id = ?, settled_at = ? WHERE id = ?",
            (status, winner, settled, bet_id),
        )
        return _present_one(connection, bet_id)


def reopen(bet_id: str, actor_id: str) -> dict:
    with db.tx() as connection:
        row = _must_bet(connection, bet_id)
        _require_actor_on_bet(row, actor_id)
        if row["status"] == "open":
            raise BookError("That bet is already open.")
        if row["status"] not in ("settled", "push", "void"):
            raise BookError("Only a settled bet can be reopened.")
        connection.execute(
            "UPDATE bets SET status = 'open', winner_id = NULL, settled_at = NULL WHERE id = ?",
            (bet_id,),
        )
        return _present_one(connection, bet_id)


def accept(bet_id: str, actor_id: str) -> dict:
    return _answer(bet_id, actor_id, "accept")


def decline(bet_id: str, actor_id: str) -> dict:
    return _answer(bet_id, actor_id, "decline")


def withdraw(bet_id: str, actor_id: str) -> dict:
    return _answer(bet_id, actor_id, "withdraw")


def _answer(bet_id: str, actor_id: str, action: str) -> dict:
    with db.tx() as connection:
        row = _must_bet(connection, bet_id)
        if row["status"] != "proposed":
            raise BookError("That bet is no longer waiting for an answer.")
        if action == "withdraw":
            if row["maker_id"] != actor_id:
                raise BookError("Only the person who proposed this can take it back.", 403)
            connection.execute(
                "UPDATE bets SET status = 'withdrawn', settled_at = ? WHERE id = ?",
                (now_iso(), bet_id),
            )
        else:
            if row["taker_id"] != actor_id:
                raise BookError("Only the other person can answer this bet.", 403)
            if action == "accept":
                connection.execute("UPDATE bets SET status = 'open' WHERE id = ?", (bet_id,))
            else:
                connection.execute(
                    "UPDATE bets SET status = 'declined', settled_at = ? WHERE id = ?",
                    (now_iso(), bet_id),
                )
        return _present_one(connection, bet_id)


def records() -> dict:
    with db.tx() as connection:
        people, currencies = _lookups(connection)
        return _compute_records(connection, people, currencies)


def board(person_id: str | None, refresh: bool = False) -> dict:
    warnings = []
    with db.tx() as connection:
        due = _open_sports(connection) if refresh else _sports_due(connection)
    for sport_id in due:
        result = sync_sport(sport_id)
        if not result["ok"]:
            sport = sport_by_id(sport_id)
            label = sport["label"] if sport else sport_id
            warnings.append(f"{label}: {result['message']}")
    with db.tx() as connection:
        people, currencies = _lookups(connection)
        bets = _present_bets(
            connection,
            people,
            currencies,
            "status IN ('open', 'proposed')",
            [],
            "CASE status WHEN 'proposed' THEN 0 ELSE 1 END, COALESCE(event_start, created_at) ASC",
        )
        rec = _compute_records(connection, people, currencies)
    me = None
    if person_id:
        me = next((row for row in rec["leaderboard"] if row["person"]["id"] == person_id), None)
    return {"bets": bets, "me": me, "owes": rec["owes"], "warnings": warnings}


def export_csv() -> bytes:
    with db.tx() as connection:
        people, currencies = _lookups(connection)
        rows = connection.execute("SELECT * FROM bets ORDER BY created_at").fetchall()
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(
        [
            "id",
            "created",
            "settled",
            "status",
            "sport",
            "league",
            "event",
            "event_start",
            "maker",
            "maker_pick",
            "maker_stake",
            "taker",
            "taker_pick",
            "taker_stake",
            "currency",
            "winner",
            "note",
        ]
    )
    for row in rows:
        currency = currencies.get(row["currency_code"])
        decimals = currency["decimals"] if currency else 2
        maker = people.get(row["maker_id"])
        taker = people.get(row["taker_id"])
        winner = people.get(row["winner_id"]) if row["winner_id"] else None
        writer.writerow(
            [
                row["id"],
                row["created_at"],
                row["settled_at"] or "",
                row["status"],
                row["event_sport"],
                row["event_league"],
                row["event_title"],
                row["event_start"] or "",
                maker["name"] if maker else "",
                row["maker_pick"],
                _money_number(row["maker_stake"], decimals),
                taker["name"] if taker else "",
                row["taker_pick"],
                _money_number(row["taker_stake"], decimals),
                row["currency_code"],
                winner["name"] if winner else "",
                row["note"],
            ]
        )
    return buffer.getvalue().encode("utf-8-sig")


def sync_sport(sport_id: str) -> dict:
    try:
        events = load_sport(sport_id)
    except FeedError as exc:
        message = str(exc)[:180]
        log.warning("sync %s failed: %s", sport_id, message)
        _mark_sync(sport_id, ok=False, message=message, count=0)
        return {"ok": False, "message": message, "count": 0}
    except Exception:
        log.exception("sync %s failed", sport_id)
        message = "The schedule feed returned something unexpected."
        _mark_sync(sport_id, ok=False, message=message, count=0)
        return {"ok": False, "message": message, "count": 0}
    now = now_iso()
    with db.tx() as connection:
        for event in events:
            connection.execute(
                """
                INSERT INTO events (
                    id, sport, league, title, subtitle, start_time, status, detail,
                    source, competitors_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'espn', ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    league = excluded.league,
                    title = excluded.title,
                    subtitle = excluded.subtitle,
                    start_time = excluded.start_time,
                    status = excluded.status,
                    detail = excluded.detail,
                    competitors_json = excluded.competitors_json,
                    updated_at = excluded.updated_at
                """,
                (
                    event["id"],
                    event["sport"],
                    event["league"],
                    event["title"],
                    event["subtitle"],
                    event["startTime"],
                    event["status"],
                    event["detail"],
                    json.dumps(event["competitors"], ensure_ascii=False),
                    now,
                ),
            )
        connection.execute(
            """
            INSERT INTO syncs (sport, fetched_at, ok, message, event_count)
            VALUES (?, ?, 1, '', ?)
            ON CONFLICT(sport) DO UPDATE SET
                fetched_at = excluded.fetched_at,
                ok = 1,
                message = '',
                event_count = excluded.event_count
            """,
            (sport_id, now, len(events)),
        )
    return {"ok": True, "message": "", "count": len(events)}


def _maybe_sync(sport_id: str, force: bool) -> str:
    with db.tx() as connection:
        row = connection.execute("SELECT * FROM syncs WHERE sport = ?", (sport_id,)).fetchone()
    if not force and row is not None:
        age = _age_seconds(row["fetched_at"])
        limit = 60 if not row["ok"] else 600
        if age is not None and age < limit:
            return "" if row["ok"] else row["message"]
    result = sync_sport(sport_id)
    return "" if result["ok"] else result["message"]


def _open_sports(connection) -> list[str]:
    rows = connection.execute(
        """
        SELECT DISTINCT e.sport AS sport
        FROM bets b
        JOIN events e ON e.id = b.event_id
        WHERE b.status = 'open' AND e.source = 'espn'
        """
    ).fetchall()
    return [row["sport"] for row in rows][:4]


def _sports_due(connection) -> list[str]:
    rows = connection.execute(
        """
        SELECT DISTINCT e.sport AS sport
        FROM bets b
        JOIN events e ON e.id = b.event_id
        WHERE b.status = 'open'
          AND e.source = 'espn'
          AND e.status NOT IN ('final', 'cancelled')
          AND e.start_time <= ?
        """,
        (now_iso(),),
    ).fetchall()
    due = []
    for row in rows:
        sport_id = row["sport"]
        sync = connection.execute("SELECT * FROM syncs WHERE sport = ?", (sport_id,)).fetchone()
        age = _age_seconds(sync["fetched_at"]) if sync is not None else None
        if age is None or age >= 120:
            due.append(sport_id)
    return due[:4]


def _mark_sync(sport_id: str, *, ok: bool, message: str, count: int) -> None:
    with db.tx() as connection:
        connection.execute(
            """
            INSERT INTO syncs (sport, fetched_at, ok, message, event_count)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(sport) DO UPDATE SET
                fetched_at = excluded.fetched_at,
                ok = excluded.ok,
                message = excluded.message,
                event_count = excluded.event_count
            """,
            (sport_id, now_iso(), 1 if ok else 0, message, count),
        )


def _compute_records(connection, people: dict, currencies: dict) -> dict:
    stats = {
        person_id: {
            "wins": 0,
            "losses": 0,
            "pushes": 0,
            "nets": {},
            "results": [],
        }
        for person_id in people
    }
    pair_wins: dict[tuple, dict] = {}
    pair_pushes: dict[tuple, int] = {}
    pair_nets: dict[tuple, dict] = {}
    rows = connection.execute(
        "SELECT * FROM bets WHERE status IN ('settled', 'push')"
    ).fetchall()
    for row in rows:
        maker_id = row["maker_id"]
        taker_id = row["taker_id"]
        if maker_id not in people or taker_id not in people or maker_id == taker_id:
            continue
        key = tuple(sorted((maker_id, taker_id)))
        pair_wins.setdefault(key, {})
        pair_nets.setdefault(key, {})
        code = row["currency_code"]
        if row["status"] == "push":
            for person_id in (maker_id, taker_id):
                stats[person_id]["pushes"] += 1
                stats[person_id]["results"].append((row["settled_at"] or "", "P"))
            pair_pushes[key] = pair_pushes.get(key, 0) + 1
            continue
        winner_id = row["winner_id"]
        if winner_id not in (maker_id, taker_id):
            continue
        loser_id = taker_id if winner_id == maker_id else maker_id
        stake = row["maker_stake"] if loser_id == maker_id else row["taker_stake"]
        _add_net(stats[winner_id]["nets"], code, stake)
        _add_net(stats[loser_id]["nets"], code, -stake)
        stats[winner_id]["wins"] += 1
        stats[loser_id]["losses"] += 1
        stats[winner_id]["results"].append((row["settled_at"] or "", "W"))
        stats[loser_id]["results"].append((row["settled_at"] or "", "L"))
        pair_wins[key][winner_id] = pair_wins[key].get(winner_id, 0) + 1
        pair_nets[key].setdefault(code, {})
        pair_nets[key][code][winner_id] = pair_nets[key][code].get(winner_id, 0) + stake
        pair_nets[key][code][loser_id] = pair_nets[key][code].get(loser_id, 0) - stake

    leaderboard = []
    for person_id, person in people.items():
        item = stats[person_id]
        decisions = item["wins"] + item["losses"]
        leaderboard.append(
            {
                "person": _person_brief(person),
                "wins": item["wins"],
                "losses": item["losses"],
                "pushes": item["pushes"],
                "winPct": (item["wins"] / decisions) if decisions else None,
                "streak": _streak(item["results"]),
                "nets": _nets_public(item["nets"], currencies),
            }
        )
    leaderboard.sort(key=_leader_key)

    pairs = []
    owes = []
    for key in sorted(set(pair_wins) | set(pair_pushes)):
        a_id, b_id = key
        a_wins = pair_wins.get(key, {}).get(a_id, 0)
        b_wins = pair_wins.get(key, {}).get(b_id, 0)
        pushes = pair_pushes.get(key, 0)
        if a_wins + b_wins + pushes == 0:
            continue
        net_rows = []
        for code, by_person in sorted(pair_nets.get(key, {}).items()):
            minor = by_person.get(a_id, 0)
            if minor == 0 or code not in currencies:
                continue
            currency = currencies[code]
            amount = _money_number(minor, currency["decimals"])
            net_rows.append({"currency": _currency(currency), "amount": amount})
            debtor = b_id if minor > 0 else a_id
            creditor = a_id if minor > 0 else b_id
            owes.append(
                {
                    "from": _person_brief(people[debtor]),
                    "to": _person_brief(people[creditor]),
                    "currency": _currency(currency),
                    "amount": _money_number(abs(minor), currency["decimals"]),
                }
            )
        pairs.append(
            {
                "a": _person_brief(people[a_id]),
                "b": _person_brief(people[b_id]),
                "aWins": a_wins,
                "bWins": b_wins,
                "pushes": pushes,
                "nets": net_rows,
            }
        )
    pairs.sort(key=lambda item: (-(item["aWins"] + item["bWins"] + item["pushes"]), item["a"]["name"].casefold()))
    owes.sort(key=lambda item: (item["currency"]["code"], -Decimal(str(item["amount"]))))
    return {"leaderboard": leaderboard, "pairs": pairs, "owes": owes}


def _leader_key(row: dict):
    return (-row["wins"], -(row["winPct"] or 0), row["person"]["name"].casefold())


def _streak(results: list[tuple[str, str]]) -> str:
    kind = None
    count = 0
    for _, result in sorted(results, key=lambda item: item[0], reverse=True):
        if result == "P":
            continue
        if kind is None:
            kind = result
            count = 1
            continue
        if result != kind:
            break
        count += 1
    if not kind:
        return ""
    return f"{kind}{count}"


def _add_net(bucket: dict, code: str, minor: int) -> None:
    bucket[code] = bucket.get(code, 0) + minor


def _nets_public(bucket: dict, currencies: dict) -> list[dict]:
    found = []
    for code, minor in sorted(bucket.items()):
        if minor == 0 or code not in currencies:
            continue
        currency = currencies[code]
        found.append({"currency": _currency(currency), "amount": _money_number(minor, currency["decimals"])})
    return found


def suggestion_for(bet, event) -> dict | None:
    if not event:
        return None
    if event["status"] == "cancelled":
        return {"result": "void", "label": "This event was cancelled"}
    if event["status"] != "final":
        return None
    competitors = event.get("competitors") or []
    winners = [item for item in competitors if item.get("winner")]
    if len(winners) == 1:
        name = winners[0]["name"]
        if bet["maker_pick"].strip().casefold() == name.casefold():
            return {"result": "maker", "label": f"{name} won"}
        if bet["taker_pick"].strip().casefold() == name.casefold():
            return {"result": "taker", "label": f"{name} won"}
        return {
            "result": None,
            "label": f"{name} won. The picks don't match a side, so settle this one by hand.",
        }
    if len(competitors) == 2:
        scores = [str(item.get("score") or "") for item in competitors]
        if scores[0] and scores[0] == scores[1] and not winners:
            return {"result": "push", "label": "Looks like a draw"}
    return None


def _resolve_event(connection, body: dict):
    event_id = str(body.get("eventId") or "").strip()
    if event_id:
        row = connection.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
        if row is None:
            raise BookError("That event is not in the book.", 404)
        return row
    event = body.get("event")
    if not event:
        raise BookError("Pick an event, or describe one.")
    return _insert_event(connection, event)


def _insert_event(connection, event: dict):
    title = _clean(event.get("title"), 160, "Name the event.")
    sport = str(event.get("sport") or "custom").strip().lower()
    known = sport_by_id(sport)
    if sport != "custom" and known is None:
        raise BookError("Pick a sport from the list, or choose Something else.")
    if sport == "custom":
        league = _clean(event.get("league") or "Custom", 40, "Name what you're betting on.")
    else:
        league = known["label"]
    try:
        start = normalize_time(event.get("startTime") or now_iso())
    except ValueError:
        raise BookError("That start time is not valid.")
    status = event.get("status") or "scheduled"
    if status not in ("scheduled", "live", "final", "postponed", "cancelled"):
        raise BookError("That event status is not valid.")
    names = []
    seen = set()
    for item in (event.get("competitors") or [])[:40]:
        if isinstance(item, str):
            name = " ".join(item.split())
        elif isinstance(item, dict):
            name = " ".join(str(item.get("name") or "").split())
        else:
            name = ""
        if not name:
            continue
        name = name[:120]
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)
    competitors = [
        {"name": name, "side": "", "winner": False, "score": "", "record": "", "color": "", "rank": None}
        for name in names
    ]
    event_id = "custom_" + uuid4().hex
    connection.execute(
        """
        INSERT INTO events (
            id, sport, league, title, subtitle, start_time, status, detail,
            source, competitors_json, updated_at
        ) VALUES (?, ?, ?, ?, '', ?, ?, '', 'custom', ?, ?)
        """,
        (
            event_id,
            sport,
            league,
            title,
            start,
            status,
            json.dumps(competitors, ensure_ascii=False),
            now_iso(),
        ),
    )
    return connection.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()


def _present_bets(connection, people, currencies, where_sql, args, order_sql):
    sql = "SELECT * FROM bets"
    if where_sql:
        sql += " WHERE " + where_sql
    sql += " ORDER BY " + order_sql
    rows = list(connection.execute(sql, args))
    events = _events_for(connection, rows)
    return [_present_bet(row, people, currencies, events.get(row["event_id"])) for row in rows]


def _present_one(connection, bet_id: str) -> dict:
    people, currencies = _lookups(connection)
    row = connection.execute("SELECT * FROM bets WHERE id = ?", (bet_id,)).fetchone()
    events = _events_for(connection, [row])
    return _present_bet(row, people, currencies, events.get(row["event_id"]))


def _present_bet(row, people, currencies, event_row) -> dict:
    currency_row = currencies.get(row["currency_code"])
    decimals = currency_row["decimals"] if currency_row else 2
    event = _event_public(event_row) if event_row is not None else None
    suggestion = suggestion_for(row, event) if row["status"] == "open" else None
    return {
        "id": row["id"],
        "eventId": row["event_id"],
        "eventTitle": row["event_title"],
        "eventSport": row["event_sport"],
        "eventLeague": row["event_league"],
        "eventStart": row["event_start"],
        "eventStatus": event["status"] if event else None,
        "eventDetail": event["detail"] if event else "",
        "maker": _person_or(people, row["maker_id"]),
        "taker": _person_or(people, row["taker_id"]),
        "makerPick": row["maker_pick"],
        "takerPick": row["taker_pick"],
        "makerStake": _money_number(row["maker_stake"], decimals),
        "takerStake": _money_number(row["taker_stake"], decimals),
        "currency": _currency(currency_row) if currency_row else {
            "code": row["currency_code"],
            "name": row["currency_code"],
            "symbol": "",
            "decimals": decimals,
            "kind": "custom",
        },
        "note": row["note"],
        "status": row["status"],
        "winnerId": row["winner_id"],
        "createdAt": row["created_at"],
        "settledAt": row["settled_at"],
        "suggestion": suggestion,
    }


def _events_for(connection, rows) -> dict:
    ids = sorted({row["event_id"] for row in rows if row["event_id"]})
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    found = connection.execute(f"SELECT * FROM events WHERE id IN ({marks})", ids).fetchall()
    return {row["id"]: row for row in found}


def _event_public(row) -> dict:
    return {
        "id": row["id"],
        "sport": row["sport"],
        "league": row["league"],
        "title": row["title"],
        "subtitle": row["subtitle"],
        "startTime": row["start_time"],
        "status": row["status"],
        "detail": row["detail"],
        "source": row["source"],
        "competitors": json.loads(row["competitors_json"]),
    }


def _sync_public(row) -> dict | None:
    if row is None:
        return None
    return {
        "fetchedAt": row["fetched_at"],
        "ok": bool(row["ok"]),
        "message": row["message"],
        "eventCount": row["event_count"],
    }


def _lookups(connection):
    people = {row["id"]: row for row in connection.execute("SELECT * FROM people")}
    currencies = {row["code"]: row for row in connection.execute("SELECT * FROM currencies")}
    return people, currencies


def _must_bet(connection, bet_id: str):
    row = connection.execute("SELECT * FROM bets WHERE id = ?", (bet_id,)).fetchone()
    if row is None:
        raise BookError("That bet is not in the book.", 404)
    return row


def _require_person(people: dict, person_id):
    row = people.get(str(person_id or ""))
    if row is None:
        raise BookError("Pick who is on each side.")
    return row


def _require_self(person_id: str, actor_id: str) -> None:
    if person_id != actor_id:
        raise BookError("You can only change your own account.", 403)


def _require_actor_on_bet(row, actor_id: str) -> None:
    if actor_id not in (row["maker_id"], row["taker_id"]):
        raise BookError("Only the two people on this bet can change it.", 403)


def _start_session(connection, person_id: str) -> str:
    token = secrets.token_urlsafe(32)
    connection.execute(
        "INSERT INTO sessions (token, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (token, person_id, now_iso(), shift_iso(seconds=SESSION_SECONDS)),
    )
    return token


def _require_password(password) -> str:
    if not isinstance(password, str) or len(password) < 8 or len(password) > 128:
        raise BookError("Use 8 to 128 characters.")
    if any(ord(ch) < 32 for ch in password):
        raise BookError("That password has characters I can't store.")
    return password


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERS)
    return f"pbkdf2${PBKDF2_ITERS}${salt.hex()}${digest.hex()}"


def _dummy_hash() -> str:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = _hash_password("marker-dummy-password")
    return _DUMMY_HASH


def _verify_password(password: str, stored: str | None) -> bool:
    usable = isinstance(password, str) and 1 <= len(password) <= 128
    candidate = password if usable else "marker-dummy-password"
    salt = None
    expected = None
    iters = PBKDF2_ITERS
    try:
        if stored:
            kind, iters_text, salt_hex, digest_hex = stored.split("$", 3)
            iters = int(iters_text)
            if kind == "pbkdf2" and 1 <= iters <= 1_000_000:
                salt = bytes.fromhex(salt_hex)
                expected = bytes.fromhex(digest_hex)
    except (ValueError, TypeError):
        salt = None
        expected = None
    if salt is None or expected is None:
        kind, iters_text, salt_hex, digest_hex = _dummy_hash().split("$", 3)
        iters = int(iters_text)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        candidate = "marker-dummy-password"
        usable = False
    got = hashlib.pbkdf2_hmac("sha256", candidate.encode("utf-8"), salt, iters)
    return bool(usable and hmac.compare_digest(got, expected))


def _bet_filter(status: str, person: str | None):
    where = []
    args = []
    if status == "open":
        where.append("status = 'open'")
    elif status == "closed":
        closed = ("settled", "push", "void", "declined", "withdrawn")
        where.append("status IN (%s)" % ",".join("?" * len(closed)))
        args.extend(closed)
    elif status != "all":
        raise BookError("Unknown bet list.")
    if person:
        where.append("(maker_id = ? OR taker_id = ?)")
        args.extend([person, person])
    return " AND ".join(where), args


def _outcome_fields(outcome, maker_id: str, taker_id: str):
    settled = now_iso()
    if outcome == "maker":
        return "settled", maker_id, settled
    if outcome == "taker":
        return "settled", taker_id, settled
    if outcome == "push":
        return "push", None, settled
    if outcome == "void":
        return "void", None, settled
    raise BookError("Pick who won, a push, or void.")


def _person(row, bet_count: int) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "createdAt": row["created_at"],
        "betCount": bet_count,
    }


def _person_brief(row) -> dict:
    return {"id": row["id"], "name": row["name"], "color": row["color"]}


def _person_or(people: dict, person_id: str) -> dict:
    row = people.get(person_id)
    if row is not None:
        return _person_brief(row)
    return {"id": person_id, "name": "Removed", "color": "#8a8175"}


def _currency(row) -> dict:
    return {
        "code": row["code"],
        "name": row["name"],
        "symbol": row["symbol"],
        "decimals": row["decimals"],
        "kind": row["kind"],
    }


def _clean_name(value) -> str:
    name = " ".join(str(value or "").split())
    if not name:
        raise BookError("A name is required.")
    if len(name) > 40:
        raise BookError("Use a name under 40 characters.")
    if any(ord(ch) < 32 for ch in name):
        raise BookError("That name has characters I can't store.")
    return name


def _clean(value, limit: int, empty_message: str) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        raise BookError(empty_message)
    if len(text) > limit:
        raise BookError(f"Keep that under {limit} characters.")
    return text


def _note(value) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > 500:
        raise BookError("Keep the note under 500 characters.")
    return text


def _parse_amount(value, decimals: int) -> int:
    if isinstance(value, bool) or value is None or value == "":
        raise BookError("Enter both stakes. Use 0 for a pride bet.")
    if isinstance(value, float) and not math.isfinite(value):
        raise BookError("That stake is not a number.")
    text = str(value).strip().replace(",", "")
    try:
        amount = Decimal(text)
    except InvalidOperation:
        raise BookError("That stake is not a number.")
    if amount < 0:
        raise BookError("Stakes cannot be negative.")
    if amount > Decimal("1000000000000"):
        raise BookError("That stake is too large.")
    quant = Decimal(10) ** -decimals if decimals else Decimal("1")
    amount = amount.quantize(quant, rounding=ROUND_HALF_UP)
    return int(amount * (Decimal(10) ** decimals))


def _money_number(minor: int, decimals: int):
    quant = Decimal(10) ** -decimals if decimals else Decimal("1")
    amount = (Decimal(minor) / (Decimal(10) ** decimals)).quantize(quant)
    if decimals == 0:
        return int(amount)
    return float(amount)


def _age_seconds(stamp: str | None):
    if not stamp:
        return None
    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - moment).total_seconds()
