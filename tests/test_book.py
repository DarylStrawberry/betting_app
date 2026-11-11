"""Ledger math, feed parsing, and one pass through the HTTP server."""

import http.cookiejar
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from marker import db
from marker.errors import BookError
from marker.espn import events_from_scoreboard
from marker.server import make_server
from marker.service import (
    accept,
    create_bet,
    decline,
    delete_person,
    login,
    patch_bet,
    records,
    register,
    reopen,
    settle,
    suggestion_for,
    withdraw,
)


NBA = {"id": "nba", "label": "NBA", "mode": "days", "path": "basketball/nba"}
UFC = {"id": "ufc", "label": "UFC", "mode": "ufc", "path": "mma/ufc"}
F1 = {"id": "f1", "label": "Formula 1", "mode": "f1", "path": "racing/f1"}


class FeedParseTests(unittest.TestCase):
    def test_team_game_lists_away_side_first(self):
        payload = {
            "events": [
                {
                    "id": "1",
                    "date": "2026-11-08T20:30Z",
                    "name": "Philadelphia 76ers at Chicago Bulls",
                    "competitions": [
                        {
                            "date": "2026-11-08T20:30Z",
                            "venue": {"fullName": "United Center"},
                            "status": {"type": {"state": "pre", "name": "STATUS_SCHEDULED", "shortDetail": "7:30 PM"}},
                            "competitors": [
                                {
                                    "homeAway": "home",
                                    "winner": False,
                                    "team": {"displayName": "Chicago Bulls", "color": "ce1141"},
                                    "records": [{"type": "total", "summary": "5-3"}],
                                },
                                {
                                    "homeAway": "away",
                                    "winner": False,
                                    "team": {"displayName": "Philadelphia 76ers", "color": "006bb6"},
                                },
                            ],
                        }
                    ],
                }
            ]
        }
        event = events_from_scoreboard(NBA, payload)[0]
        self.assertEqual(event["competitors"][0]["name"], "Philadelphia 76ers")
        self.assertEqual(event["competitors"][0]["side"], "away")
        self.assertEqual(event["status"], "scheduled")
        self.assertEqual(event["subtitle"], "United Center")
        self.assertEqual(event["id"], "espn_nba_1")

    def test_ufc_card_becomes_one_bet_per_fight(self):
        payload = {
            "events": [
                {
                    "id": "600",
                    "name": "UFC 334: Gane vs. Hokit",
                    "date": "2026-11-14T22:00Z",
                    "competitions": [
                        {
                            "id": "1",
                            "date": "2026-11-14T22:00Z",
                            "type": {"abbreviation": "Lightweight"},
                            "status": {"type": {"state": "pre", "shortDetail": "5:00 PM"}},
                            "competitors": [
                                {"athlete": {"displayName": "Evan Elder"}},
                                {"athlete": {"displayName": "Samuel Sanches"}},
                            ],
                        },
                        {
                            "id": "2",
                            "date": "2026-11-15T02:00Z",
                            "type": {"abbreviation": "Heavyweight"},
                            "status": {"type": {"state": "pre", "shortDetail": "9:00 PM"}},
                            "competitors": [
                                {"athlete": {"displayName": "Ciryl Gane"}},
                                {"athlete": {"displayName": "Josh Hokit"}},
                            ],
                        },
                    ],
                }
            ]
        }
        events = events_from_scoreboard(UFC, payload)
        self.assertEqual(len(events), 2)
        heavy = next(event for event in events if "Heavyweight" in event["subtitle"])
        self.assertEqual(heavy["title"], "Ciryl Gane vs Josh Hokit")
        self.assertIn("UFC 334", heavy["subtitle"])

    def test_f1_follows_the_race_not_practice(self):
        payload = {
            "events": [
                {
                    "id": "99",
                    "name": "Test Grand Prix",
                    "date": "2026-11-06T15:30Z",
                    "status": {"type": {"state": "post", "name": "STATUS_FINAL", "completed": True}},
                    "competitions": [
                        {
                            "id": "1",
                            "date": "2026-11-06T15:30Z",
                            "type": {"abbreviation": "FP1"},
                            "status": {"type": {"state": "post", "name": "STATUS_FINAL", "completed": True}},
                            "competitors": [{"winner": True, "athlete": {"displayName": "Lando Norris"}}],
                        },
                        {
                            "id": "2",
                            "date": "2026-11-08T17:00Z",
                            "type": {"abbreviation": "Race"},
                            "status": {"type": {"state": "pre", "name": "STATUS_SCHEDULED", "shortDetail": "Sun 12:00 PM"}},
                            "competitors": [],
                        },
                    ],
                }
            ]
        }
        event = events_from_scoreboard(F1, payload)[0]
        self.assertEqual(event["status"], "scheduled")
        self.assertEqual(event["startTime"], "2026-11-08T17:00:00Z")
        norris = event["competitors"][0]
        self.assertEqual(norris["name"], "Lando Norris")
        self.assertFalse(norris["winner"])

    def test_suggestions(self):
        bet = {"maker_pick": "Chicago Bulls", "taker_pick": "Over 220.5"}
        final = {
            "status": "final",
            "competitors": [
                {"name": "Chicago Bulls", "winner": True, "score": "110"},
                {"name": "Philadelphia 76ers", "winner": False, "score": "99"},
            ],
        }
        self.assertEqual(suggestion_for(bet, final)["result"], "maker")
        draw = {
            "status": "final",
            "competitors": [
                {"name": "Arsenal", "winner": False, "score": "1"},
                {"name": "Chelsea", "winner": False, "score": "1"},
            ],
        }
        self.assertEqual(suggestion_for({"maker_pick": "Arsenal", "taker_pick": "Chelsea"}, draw)["result"], "push")
        cancelled = {"status": "cancelled", "competitors": []}
        self.assertEqual(suggestion_for(bet, cancelled)["result"], "void")


class BookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.init(Path(self.tmp.name) / "book.db")
        self.password = "password1"
        self.alex, _ = register("Alex", self.password)
        self.sam, _ = register("Sam", self.password)
        self.jordan, _ = register("Jordan", self.password)

    def tearDown(self):
        db.close()
        self.tmp.cleanup()

    def bet(self, maker, taker, maker_stake, taker_stake, currency, outcome=None, **extra):
        body = {
            "makerId": maker["id"],
            "takerId": taker["id"],
            "makerPick": extra.get("makerPick", "Lakers"),
            "takerPick": extra.get("takerPick", "Celtics"),
            "makerStake": maker_stake,
            "takerStake": taker_stake,
            "currency": currency,
            "event": {
                "title": extra.get("title", "Lakers at Celtics"),
                "sport": "nba",
                "startTime": "2026-11-07T00:00:00Z",
            },
        }
        if outcome:
            body["outcome"] = outcome
        created = create_bet(body, maker["id"])
        if outcome:
            return created
        return accept(created["id"], taker["id"])

    def nets(self, code):
        found = {}
        for row in records()["leaderboard"]:
            amount = 0
            for net in row["nets"]:
                if net["currency"]["code"] == code:
                    amount = net["amount"]
            found[row["person"]["name"]] = amount
        return found

    def test_names_are_case_insensitive(self):
        register("Nguyễn", self.password)
        with self.assertRaises(BookError):
            register("nguyễn", self.password)

    def test_login_checks_the_password(self):
        person, _token = login("alex", self.password)
        self.assertEqual(person["id"], self.alex["id"])
        with self.assertRaises(BookError) as bad:
            login("Alex", "wrong-password")
        self.assertEqual(bad.exception.status, 401)
        with self.assertRaises(BookError):
            register("Riley", "short")
        with db.tx() as connection:
            stored = connection.execute(
                "SELECT password_hash FROM people WHERE id = ?",
                (self.alex["id"],),
            ).fetchone()["password_hash"]
        self.assertTrue(stored.startswith("pbkdf2$"))
        self.assertNotIn(self.password, stored)

    def test_two_different_people_and_picks(self):
        with self.assertRaises(BookError):
            self.bet(self.alex, self.alex, 10, 10, "USD")
        with self.assertRaises(BookError):
            self.bet(self.alex, self.sam, 10, 10, "USD", makerPick="Lakers", takerPick="lakers")

    def test_uneven_stakes_move_only_the_losers_amount(self):
        created = self.bet(self.alex, self.sam, 100, 40, "USD")
        settle(created["id"], "maker", self.alex["id"])
        self.assertEqual(self.nets("USD"), {"Alex": 40, "Sam": -40, "Jordan": 0})
        pair = records()["pairs"][0]
        wins = {pair["a"]["name"]: pair["aWins"], pair["b"]["name"]: pair["bWins"]}
        self.assertEqual(wins, {"Alex": 1, "Sam": 0})
        owe = records()["owes"][0]
        self.assertEqual((owe["from"]["name"], owe["to"]["name"], owe["amount"]), ("Sam", "Alex", 40))

        created = self.bet(self.alex, self.sam, 100, 40, "USD")
        settle(created["id"], "taker", self.sam["id"])
        self.assertEqual(self.nets("USD"), {"Alex": 40 - 100, "Sam": -40 + 100, "Jordan": 0})
        self.assertEqual(sum(self.nets("USD").values()), 0)

    def test_push_void_reopen_and_gold_and_dong(self):
        pushed = self.bet(self.alex, self.sam, 25, 25, "USD", "push")
        self.assertEqual(pushed["status"], "push")
        self.assertEqual(self.nets("USD")["Alex"], 0)
        self.assertEqual(records()["leaderboard"][0]["pushes"] + records()["leaderboard"][1]["pushes"] + records()["leaderboard"][2]["pushes"], 2)

        voided = self.bet(self.alex, self.jordan, 10, 10, "USD")
        settle(voided["id"], "void", self.jordan["id"])
        self.assertEqual(sum(self.nets("USD").values()), 0)
        self.assertTrue(all(row["wins"] == 0 and row["losses"] == 0 for row in records()["leaderboard"]))

        gold = self.bet(self.alex, self.sam, 2, 0.5, "GOLD", "taker", makerPick="Norris", takerPick="Verstappen", title="Abu Dhabi")
        self.assertEqual(gold["takerStake"], 0.5)
        self.assertEqual(self.nets("GOLD"), {"Alex": -2, "Sam": 2, "Jordan": 0})

        dong = self.bet(self.jordan, self.alex, 1500000.4, 1000000, "VND", "maker", makerPick="Home", takerPick="Away", title="V-League")
        self.assertEqual(dong["makerStake"], 1500000)
        self.assertEqual(self.nets("VND")["Jordan"], 1000000)
        self.assertEqual(self.nets("VND")["Alex"], -1000000)

        reopen(pushed["id"], self.alex["id"])
        self.assertEqual(sum(row["pushes"] for row in records()["leaderboard"]), 0)

    def test_a_proposal_does_not_count_until_it_is_accepted(self):
        proposed = create_bet(self._body(self.alex, self.sam, 10, 10, "USD"), self.alex["id"])
        self.assertEqual(proposed["status"], "proposed")
        self.assertEqual(self.nets("USD")["Alex"], 0)
        with self.assertRaises(BookError) as denied:
            accept(proposed["id"], self.alex["id"])
        self.assertEqual(denied.exception.status, 403)
        declined = decline(proposed["id"], self.sam["id"])
        self.assertEqual(declined["status"], "declined")
        self.assertEqual(self.nets("USD")["Alex"], 0)
        with self.assertRaises(BookError):
            reopen(declined["id"], self.sam["id"])

        again = create_bet(self._body(self.alex, self.sam, 10, 10, "USD"), self.alex["id"])
        with self.assertRaises(BookError):
            withdraw(again["id"], self.sam["id"])
        self.assertEqual(withdraw(again["id"], self.alex["id"])["status"], "withdrawn")

        live = create_bet(self._body(self.alex, self.sam, 10, 10, "USD"), self.alex["id"])
        self.assertEqual(accept(live["id"], self.sam["id"])["status"], "open")
        with self.assertRaises(BookError) as outsider:
            settle(live["id"], "maker", self.jordan["id"])
        self.assertEqual(outsider.exception.status, 403)
        with self.assertRaises(BookError):
            patch_bet(
                live["id"],
                {"makerStake": 9, "takerStake": 9, "makerPick": "Lakers", "takerPick": "Celtics"},
                self.alex["id"],
            )
        self.assertEqual(patch_bet(live["id"], {"note": "locked in"}, self.sam["id"])["note"], "locked in")
        settle(live["id"], "taker", self.sam["id"])
        self.assertEqual(self.nets("USD")["Sam"], 10)
        self.assertEqual(self.nets("USD")["Alex"], -10)

    def _body(self, maker, taker, maker_stake, taker_stake, currency):
        return {
            "makerId": maker["id"],
            "takerId": taker["id"],
            "makerPick": "Lakers",
            "takerPick": "Celtics",
            "makerStake": maker_stake,
            "takerStake": taker_stake,
            "currency": currency,
            "event": {"title": "Lakers at Celtics", "sport": "nba", "startTime": "2026-11-07T00:00:00Z"},
        }

    def test_cannot_remove_someone_on_a_bet(self):
        self.bet(self.alex, self.sam, 1, 1, "USD", "maker")
        with self.assertRaises(BookError):
            delete_person(self.alex["id"], self.alex["id"])
        with self.assertRaises(BookError):
            delete_person(self.jordan["id"], self.alex["id"])
        delete_person(self.jordan["id"], self.jordan["id"])

    def test_http_round_trip(self):
        server = make_server("127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            base = f"http://127.0.0.1:{port}"

            def opener():
                return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

            def call(client, method, path, body=None):
                data = None if body is None else json.dumps(body).encode()
                request = urllib.request.Request(base + path, data=data, method=method)
                if data is not None:
                    request.add_header("Content-Type", "application/json")
                try:
                    with client.open(request) as response:
                        return response.status, response.headers, response.read()
                except urllib.error.HTTPError as exc:
                    try:
                        return exc.code, exc.headers, exc.read()
                    finally:
                        exc.close()

            guest = opener()
            status, _headers, raw = call(guest, "GET", "/")
            self.assertEqual(status, 200)
            self.assertIn(b"Marker", raw)

            status, _headers, raw = call(guest, "GET", "/api/meta")
            self.assertEqual(status, 401)
            self.assertIn(b"Sign in", raw)

            status, _headers, raw = call(guest, "GET", "/api/session")
            self.assertEqual(status, 200)
            self.assertIsNone(json.loads(raw)["person"])

            alex = opener()
            status, headers, raw = call(alex, "POST", "/api/login", {"name": "Alex", "password": self.password})
            self.assertEqual(status, 200)
            cookie = headers.get("Set-Cookie", "")
            self.assertIn("marker=", cookie)
            self.assertIn("HttpOnly", cookie)
            self.assertIn("SameSite=Lax", cookie)
            self.assertNotIn("Secure", [part.strip() for part in cookie.split(";")])
            self.assertEqual(json.loads(raw)["person"]["name"], "Alex")

            status, _headers, raw = call(alex, "GET", "/api/meta")
            self.assertEqual(status, 200)
            meta = json.loads(raw)
            self.assertIn("GOLD", [item["code"] for item in meta["currencies"]])
            self.assertNotIn("password", json.dumps(meta).lower())
            self.assertNotIn(b"pbkdf2", raw)

            status, _headers, raw = call(
                alex,
                "POST",
                "/api/bets",
                {
                    "makerId": self.alex["id"],
                    "takerId": self.sam["id"],
                    "makerPick": "Lakers",
                    "takerPick": "Celtics",
                    "makerStake": 20,
                    "takerStake": 20,
                    "currency": "USD",
                    "outcome": "maker",
                    "event": {"title": "Lakers at Celtics", "sport": "nba", "startTime": "2026-11-07T00:00:00Z"},
                },
            )
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw)["winnerId"], self.alex["id"])

            status, headers, raw = call(alex, "GET", "/api/export.csv")
            self.assertIn("text/csv", headers.get("Content-Type", ""))
            self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
            self.assertIn(b"Lakers at Celtics", raw)

            status, _headers, raw = call(
                alex,
                "POST",
                "/api/bets",
                {
                    "takerId": self.sam["id"],
                    "makerPick": "Lakers",
                    "takerPick": "Celtics",
                    "makerStake": 5,
                    "takerStake": 5,
                    "currency": "USD",
                    "event": {"title": "Nuggets at Pacers", "sport": "nba", "startTime": "2026-11-08T00:00:00Z"},
                },
            )
            self.assertEqual(status, 200)
            proposed = json.loads(raw)
            self.assertEqual(proposed["status"], "proposed")

            sam = opener()
            status, _headers, _raw = call(sam, "POST", "/api/login", {"name": "Sam", "password": self.password})
            self.assertEqual(status, 200)
            status, _headers, raw = call(sam, "POST", f"/api/bets/{proposed['id']}/accept", {})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw)["status"], "open")

            status, _headers, raw = call(
                alex,
                "POST",
                "/api/bets",
                {
                    "takerId": self.sam["id"],
                    "makerPick": "Home",
                    "takerPick": "Away",
                    "makerStake": 1,
                    "takerStake": 1,
                    "currency": "USD",
                    "event": {"title": "Arsenal at Chelsea", "sport": "epl", "startTime": "2026-11-08T00:00:00Z"},
                },
            )
            waiting = json.loads(raw)
            status, _headers, raw = call(sam, "POST", f"/api/bets/{waiting['id']}/decline", {})
            self.assertEqual(json.loads(raw)["status"], "declined")

            status, _headers, _raw = call(alex, "POST", "/api/logout", {})
            status, _headers, _raw = call(alex, "GET", "/api/meta")
            self.assertEqual(status, 401)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
