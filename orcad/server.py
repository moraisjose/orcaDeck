"""The HTTP layer: /v1/state (read), /v1/action + /v1/terminal-tail (write/
read behind the pairing token), and the panel's static files — all from one
process/port."""
from __future__ import annotations

import json
import mimetypes
import secrets
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from orcad.cli import OrcaCliError, run_orca_json, send_text_confirmed
from orcad.poller import StateStore
from orcad.version import VERSION

REPO_ROOT = Path(__file__).resolve().parent.parent
PANEL_DIR = REPO_ROOT / "panel"

# Actions /v1/action accepts. Deliberately small for v0.1.0 — "send text into
# a session" covers a reply to a question, an unblock nudge, or a plain
# steer. Gate resolution and threaded orchestration replies are a fine next
# addition once this path is proven; they need no change to this shape.
ACTION_SEND_TEXT = "send-text"
ACTION_INTERRUPT = "interrupt"


class Handler(BaseHTTPRequestHandler):
    server_version = f"orcad/{VERSION}"

    # Populated by make_handler_class()
    store: StateStore
    binary: str
    token: str

    def log_message(self, fmt: str, *args) -> None:  # quieter default logging
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # -- helpers ------------------------------------------------------------

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        supplied = header[7:] if header.startswith("Bearer ") else None
        if not supplied:
            query = urllib.parse.urlparse(self.path).query
            supplied = urllib.parse.parse_qs(query).get("token", [None])[0]
        return bool(supplied) and secrets.compare_digest(supplied, self.token)

    def _serve_static(self, url_path: str) -> None:
        rel = url_path.lstrip("/") or "index.html"
        target = (PANEL_DIR / rel).resolve()
        if PANEL_DIR not in target.parents and target != PANEL_DIR:
            self.send_error(403, "forbidden")
            return
        if not target.is_file():
            self.send_error(404, "not found")
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # Logos never change without a redeploy — cache them so a full
        # DOM rebuild every poll doesn't re-fetch/re-decode them (that
        # re-decode is what looked like a "blinking" logo). HTML/JS/CSS stay
        # uncached so an edit shows up on next reload.
        if rel.startswith("assets/"):
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            # no-store, not no-cache: this response carries no ETag/Last-
            # Modified, so a "no-cache" revalidation has nothing to
            # revalidate against and some WebKit versions fall back to
            # serving the cached copy anyway — silently running stale
            # panel.js on a fast-iterating dev loop like this one.
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # -- routes ---------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        path = urllib.parse.urlparse(self.path).path
        if path == "/v1/state":
            self._send_json(200, self.store.snapshot())
            return
        if path == "/v1/terminal-tail":
            self._handle_terminal_tail()
            return
        if path == "/" or not path.startswith("/v1/"):
            self._serve_static(path)
            return
        self.send_error(404, "not found")

    def _handle_terminal_tail(self) -> None:
        # What the modal's reply box can't infer from `/v1/state` alone: a
        # session waiting on a keypress-driven permission menu (not a chat
        # question) has no `lastAssistantMessage` at all, so the panel had
        # nothing to show for "what is this session actually asking". This
        # mirrors the rendered screen straight from the CLI so that content
        # reaches the reply device too. Same auth model as `/v1/state` — it's
        # a read, not a write, so it isn't gated behind the action token.
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        handle = (query.get("handle") or [None])[0]
        if not handle:
            self._send_json(400, {"ok": False, "error": "handle is required"})
            return
        try:
            result = run_orca_json(
                self.binary, "terminal", "read", "--terminal", handle, "--screen", "--limit", "60"
            )
        except OrcaCliError as exc:
            self._send_json(502, {"ok": False, "error": str(exc)})
            return
        terminal = result.get("terminal", {}) if isinstance(result, dict) else {}
        self._send_json(
            200,
            {"ok": True, "tail": terminal.get("tail", []), "source": terminal.get("source")},
        )

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path != "/v1/action":
            self.send_error(404, "not found")
            return
        if not self._authorized():
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "invalid JSON body"})
            return

        action = body.get("type")
        handle = body.get("terminalHandle")
        if not handle:
            self._send_json(400, {"ok": False, "error": "terminalHandle is required"})
            return

        if action == ACTION_SEND_TEXT:
            text = body.get("text")
            if not text:
                self._send_json(400, {"ok": False, "error": "text is required"})
                return
            try:
                result = send_text_confirmed(self.binary, handle, text, body.get("enter", True))
                self._send_json(200, {"ok": True, "result": result})
            except OrcaCliError as exc:
                self._send_json(502, {"ok": False, "error": str(exc)})
            return

        if action == ACTION_INTERRUPT:
            args = ["terminal", "send", "--terminal", handle, "--interrupt"]
        else:
            self._send_json(400, {"ok": False, "error": f"unknown action type {action!r}"})
            return

        try:
            result = run_orca_json(self.binary, *args)
            self._send_json(200, {"ok": True, "result": result})
        except OrcaCliError as exc:
            self._send_json(502, {"ok": False, "error": str(exc)})


def make_handler_class(store: StateStore, binary: str, token: str) -> type[Handler]:
    return type("BoundHandler", (Handler,), {"store": store, "binary": binary, "token": token})
