"""SQLite storage for the shared book."""

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_path: Path | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    password_hash TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS currencies (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    kind TEXT NOT NULL,
    sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    sport TEXT NOT NULL,
    league TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    start_time TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    competitors_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    event_id TEXT,
    event_title TEXT NOT NULL,
    event_sport TEXT NOT NULL,
    event_league TEXT NOT NULL DEFAULT '',
    event_start TEXT,
    maker_id TEXT NOT NULL REFERENCES people(id),
    taker_id TEXT NOT NULL REFERENCES people(id),
    maker_pick TEXT NOT NULL,
    taker_pick TEXT NOT NULL,
    maker_stake INTEGER NOT NULL,
    taker_stake INTEGER NOT NULL,
    currency_code TEXT NOT NULL REFERENCES currencies(code),
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    winner_id TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT
);

CREATE TABLE IF NOT EXISTS syncs (
    sport TEXT PRIMARY KEY,
    fetched_at TEXT,
    ok INTEGER NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    event_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
CREATE INDEX IF NOT EXISTS idx_bets_maker ON bets(maker_id);
CREATE INDEX IF NOT EXISTS idx_bets_taker ON bets(taker_id);
CREATE INDEX IF NOT EXISTS idx_events_sport_time ON events(sport, start_time);
CREATE INDEX IF NOT EXISTS idx_sessions_person ON sessions(person_id);
"""

CURRENCIES = [
    ("USD", "US dollar", "$", 2, "fiat", 10),
    ("VND", "Vietnamese dong", "₫", 0, "fiat", 20),
    ("GOLD", "Gold bar", "bar", 2, "metal", 30),
    ("EUR", "Euro", "€", 2, "fiat", 40),
    ("GBP", "British pound", "£", 2, "fiat", 50),
    ("CAD", "Canadian dollar", "CA$", 2, "fiat", 60),
    ("AUD", "Australian dollar", "A$", 2, "fiat", 70),
    ("JPY", "Japanese yen", "¥", 0, "fiat", 80),
    ("THB", "Thai baht", "฿", 2, "fiat", 90),
    ("MXN", "Mexican peso", "MX$", 2, "fiat", 100),
    ("BTC", "Bitcoin", "₿", 8, "crypto", 110),
    ("ETH", "Ether", "Ξ", 6, "crypto", 120),
]


def init(path: Path) -> None:
    global _conn, _path
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None
        _path = Path(path)
        _path.parent.mkdir(parents=True, exist_ok=True)
        connection = connect()
        connection.executescript(SCHEMA)
        _migrate(connection)
        connection.executemany(
            """
            INSERT OR IGNORE INTO currencies
                (code, name, symbol, decimals, kind, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            CURRENCIES,
        )
        connection.commit()


def _migrate(connection: sqlite3.Connection) -> None:
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(people)")}
    if "password_hash" not in columns:
        connection.execute("ALTER TABLE people ADD COLUMN password_hash TEXT")


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None


def connect() -> sqlite3.Connection:
    global _conn
    if _path is None:
        raise RuntimeError("Database is not configured")
    if _conn is None:
        _conn = sqlite3.connect(_path, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA foreign_keys = ON")
    return _conn


@contextmanager
def tx():
    with _lock:
        connection = connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
