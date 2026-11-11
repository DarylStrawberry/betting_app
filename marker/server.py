"""Local web server for the Marker book."""

import argparse
import json
import logging
import sys
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from marker import db, service
from marker.errors import BookError

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
log = logging.getLogger("marker")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json; charset=utf-8",
}


COOKIE = "marker"
COOKIE_MAX_AGE = 30 * 24 * 60 * 60


class Raw:
    def __init__(self, data: bytes, content_type: str, filename: str | None = None):
        self.data = data
        self.content_type = content_type
        self.filename = filename


class Reply:
    def __init__(self, status: int, payload, *, token: str | None = None, clear_cookie: bool = False):
        self.status = status
        self.payload = payload
        self.token = token
        self.clear_cookie = clear_cookie


def read_token(header: str) -> str:
    if not header:
        return ""
    jar = SimpleCookie()
    try:
        jar.load(header)
    except Exception:
        return ""
    morsel = jar.get(COOKIE)
    return morsel.value if morsel else ""


def cookie_header(token: str | None, clear: bool = False) -> str | None:
    if clear:
        return f"{COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    if not token:
        return None
    return f"{COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={COOKIE_MAX_AGE}"


def q1(query: dict, key: str, default: str = "") -> str:
    values = query.get(key) or []
    return values[0] if values else default


def _safe_file(url_path: str) -> Path | None:
    rel = unquote(url_path).split("?", 1)[0].lstrip("/")
    if not rel:
        rel = "index.html"
    if "\\" in rel or rel.startswith("/"):
        return None
    root = WEB.resolve()
    candidate = (WEB / rel).resolve()
    if candidate != root and root not in candidate.parents:
        return None
    if candidate.is_dir():
        index = (candidate / "index.html").resolve()
        if index.is_file() and (index == root or root in index.parents):
            return index
        return None
    if candidate.is_file():
        return candidate
    return None


def dispatch(method: str, path: str, query: dict, body: dict, actor: dict | None, token: str):
    parts = [unquote(part) for part in path.split("/") if part]
    if len(parts) < 2 or parts[0] != "api":
        raise BookError("Not found.", 404)

    if method == "GET" and parts == ["api", "health"]:
        return Reply(200, {"ok": True})
    if method == "GET" and parts == ["api", "session"]:
        return Reply(200, service.session_view(actor))
    if method == "POST" and parts == ["api", "register"]:
        person, session = service.register(body.get("name"), body.get("password"))
        return Reply(200, {"person": person}, token=session)
    if method == "POST" and parts == ["api", "login"]:
        person, session = service.login(body.get("name"), body.get("password"))
        return Reply(200, {"person": person}, token=session)
    if method == "POST" and parts == ["api", "logout"]:
        service.logout(token)
        return Reply(200, {"ok": True}, clear_cookie=True)

    if actor is None:
        raise BookError("Sign in to use the book.", 401)

    if method == "GET" and parts == ["api", "meta"]:
        return Reply(200, service.meta())
    if method == "GET" and parts == ["api", "people"]:
        return Reply(200, {"people": service.list_people()})
    if method == "PATCH" and len(parts) == 3 and parts[1] == "people":
        return Reply(200, service.rename_person(parts[2], body.get("name"), actor["id"]))
    if method == "DELETE" and len(parts) == 3 and parts[1] == "people":
        service.delete_person(parts[2], actor["id"])
        return Reply(200, {"ok": True})
    if method == "POST" and parts == ["api", "currencies"]:
        return Reply(200, service.add_currency(body))
    if method == "DELETE" and len(parts) == 3 and parts[1] == "currencies":
        service.delete_currency(parts[2])
        return Reply(200, {"ok": True})
    if method == "GET" and parts == ["api", "events"]:
        return Reply(200, service.list_events(q1(query, "sport") or "nfl", refresh=q1(query, "refresh") == "1"))
    if method == "POST" and parts == ["api", "events"]:
        return Reply(200, service.create_event(body))
    if method == "GET" and len(parts) == 3 and parts[1] == "events":
        return Reply(200, service.get_event(parts[2]))
    if method == "GET" and parts == ["api", "bets"]:
        return Reply(200, service.list_bets(q1(query, "status") or "all", q1(query, "person") or None))
    if method == "POST" and parts == ["api", "bets"]:
        return Reply(200, service.create_bet(body, actor["id"]))
    if method == "PATCH" and len(parts) == 3 and parts[1] == "bets":
        return Reply(200, service.patch_bet(parts[2], body, actor["id"]))
    if method == "POST" and len(parts) == 4 and parts[1] == "bets" and parts[3] == "settle":
        return Reply(200, service.settle(parts[2], body.get("result"), actor["id"]))
    if method == "POST" and len(parts) == 4 and parts[1] == "bets" and parts[3] == "reopen":
        return Reply(200, service.reopen(parts[2], actor["id"]))
    if method == "POST" and len(parts) == 4 and parts[1] == "bets" and parts[3] == "accept":
        return Reply(200, service.accept(parts[2], actor["id"]))
    if method == "POST" and len(parts) == 4 and parts[1] == "bets" and parts[3] == "decline":
        return Reply(200, service.decline(parts[2], actor["id"]))
    if method == "POST" and len(parts) == 4 and parts[1] == "bets" and parts[3] == "withdraw":
        return Reply(200, service.withdraw(parts[2], actor["id"]))
    if method == "GET" and parts == ["api", "records"]:
        return Reply(200, service.records())
    if method == "GET" and parts == ["api", "board"]:
        return Reply(200, service.board(actor["id"], refresh=q1(query, "refresh") == "1"))
    if method == "GET" and parts == ["api", "export.csv"]:
        return Reply(200, Raw(service.export_csv(), "text/csv; charset=utf-8", "marker-bets.csv"))
    raise BookError("Not found.", 404)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_PATCH(self):
        self._handle()

    def do_DELETE(self):
        self._handle()

    def _handle(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                body = self._read_body() if self.command in ("POST", "PATCH") else {}
                token = read_token(self.headers.get("Cookie", ""))
                actor = service.actor_from_token(token) if token else None
                reply = dispatch(self.command, parsed.path, parse_qs(parsed.query), body, actor, token)
                set_cookie = cookie_header(reply.token, reply.clear_cookie)
                if isinstance(reply.payload, Raw):
                    self._send(reply.status, reply.payload.data, reply.payload.content_type, reply.payload.filename, set_cookie)
                else:
                    raw = json.dumps(reply.payload, ensure_ascii=False).encode("utf-8")
                    self._send(reply.status, raw, "application/json; charset=utf-8", set_cookie=set_cookie)
                return
            self._static(parsed.path)
        except BookError as exc:
            raw = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self._send(exc.status, raw, "application/json; charset=utf-8")
        except Exception:
            log.exception("request failed")
            raw = json.dumps({"error": "Something broke on the server."}).encode("utf-8")
            self._send(500, raw, "application/json; charset=utf-8")

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > 1_000_000:
            raise BookError("That request is too large.", 413)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            raise BookError("That request was not valid JSON.")
        if not isinstance(data, dict):
            raise BookError("Send a JSON object.")
        return data

    def _static(self, url_path: str) -> None:
        path_only = url_path.split("?", 1)[0]
        rel = unquote(path_only).lstrip("/")
        if rel and not rel.endswith("/"):
            folder = (WEB / rel).resolve()
            root = WEB.resolve()
            if folder.is_dir() and (folder == root or root in folder.parents):
                self.send_response(302)
                self.send_header("Location", path_only + "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        candidate = _safe_file(url_path)
        if candidate is None:
            raw = b"Not found"
            self._send(404, raw, "text/plain; charset=utf-8")
            return
        content_type = MIME.get(candidate.suffix, "application/octet-stream")
        self._send(200, candidate.read_bytes(), content_type)

    def _send(
        self,
        status: int,
        raw: bytes,
        content_type: str,
        filename: str | None = None,
        set_cookie: str | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        try:
            message = fmt % args
        except TypeError:
            message = str(args)
        if any(token in message for token in ("/css/", "/js/", "/favicon")) and " 200 " in message:
            return
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), message))


def make_server(host: str, port: int) -> ThreadingHTTPServer:
    class Server(ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    return Server((host, port), Handler)


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="Marker, the book between friends")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", default="", help="Path to the SQLite book. Defaults to data/marker.db")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    db_path = Path(args.db) if args.db else ROOT / "data" / "marker.db"
    db.init(db_path)
    server = make_server(args.host, args.port)
    url = f"http://{args.host}:{args.port}"
    print(f"Marker is open at {url}")
    print("This book records bets. It does not hold or move money.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nClosed.")
    finally:
        server.server_close()
        db.close()
