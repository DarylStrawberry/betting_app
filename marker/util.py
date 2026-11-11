"""Small helpers shared by the feed and the ledger."""

from datetime import datetime, timedelta, timezone


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def shift_iso(*, days: int = 0, seconds: int = 0) -> str:
    moment = datetime.now(timezone.utc) + timedelta(days=days, seconds=seconds)
    return moment.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_time(value: str) -> str:
    """Return a UTC timestamp as YYYY-MM-DDTHH:MM:SSZ so text sorting works."""
    text = (value or "").strip()
    if not text:
        raise ValueError("Missing time")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc).replace(microsecond=0)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")
