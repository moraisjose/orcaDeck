#!/usr/bin/env python3
"""orcad — a companion daemon that turns `orca` into a LAN-servable panel feed.

Same shape as SideCrab's crabd: poll a local source on an interval, project it
into one small JSON document, serve that document plus a static panel over
HTTP so a browser on another device (an iPad on the same LAN, say) can render
it. The difference is the source — instead of Claude Code hooks, orcad reads
the Orca CLI, so it sees every harness Orca is running (Claude, Codex,
OpenCode, ...), not only Claude sessions, and it sees the subagent tree Orca
already tracks via `parentPaneKey`.

No third-party dependencies — stdlib only, like crabd. Two responsibilities:

  1. Poll `orca worktree ps --json` + `orca terminal list --json` on a timer,
     project them into /v1/state.
  2. Serve /v1/state (read), /v1/action (write — remote control), and the
     panel's static files, all from one process/port. Unlike crabd there is
     no cross-origin split to work around: nothing here is packaged as an
     iCUE widget, so this process can bind 0.0.0.0 directly and hand out both
     the page and the data from the same origin.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

VERSION = "0.1.0"
SCHEMA = 1

REPO_ROOT = Path(__file__).resolve().parent.parent
PANEL_DIR = REPO_ROOT / "panel"

STATE_DIR = Path.home() / ".orcad"
TOKEN_PATH = STATE_DIR / "token"

DEFAULT_PORT = 8720
DEFAULT_BIND = "0.0.0.0"
DEFAULT_POLL_INTERVAL = 2.0
CLI_TIMEOUT_SEC = 10

# Actions /v1/action accepts. Deliberately small for v0.1.0 — "send text into
# a session" covers a reply to a question, an unblock nudge, or a plain
# steer. Gate resolution and threaded orchestration replies are a fine next
# addition once this path is proven; they need no change to this shape.
ACTION_SEND_TEXT = "send-text"
ACTION_INTERRUPT = "interrupt"


# --------------------------------------------------------------------------- orca CLI


class OrcaCliError(RuntimeError):
    pass


def find_orca_binary() -> str:
    path = shutil.which("orca")
    if not path:
        raise OrcaCliError(
            "`orca` is not on PATH. orcad shells out to the Orca CLI — "
            "install/open Orca once so `orca` resolves, then restart orcad."
        )
    return path


def run_orca_json(binary: str, *args: str, timeout: float = CLI_TIMEOUT_SEC) -> Any:
    """Run an `orca ... --json` subcommand and return its parsed `result`."""
    cmd = [binary, *args, "--json"]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except FileNotFoundError as exc:
        raise OrcaCliError(f"orca binary disappeared: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise OrcaCliError(f"`{' '.join(cmd)}` timed out after {timeout}s") from exc

    stdout = (proc.stdout or "").strip()
    if not stdout:
        raise OrcaCliError(
            f"`{' '.join(cmd)}` exited {proc.returncode} with no output: "
            f"{(proc.stderr or '').strip()[:400]}"
        )
    try:
        doc = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise OrcaCliError(f"`{' '.join(cmd)}` did not return JSON: {exc}") from exc

    if doc.get("ok") is False:
        raise OrcaCliError(f"`{' '.join(cmd)}` reported failure: {doc.get('error') or doc}")
    return doc.get("result", doc)


# --------------------------------------------------------------------------- projection


def _pane_key(tab_id: str | None, leaf_id: str | None) -> str | None:
    if not tab_id or not leaf_id:
        return None
    return f"{tab_id}:{leaf_id}"


def build_terminal_index(terminals_result: Any) -> dict[str, dict]:
    """`orca terminal list --json` -> {paneKey: {handle, connected, writable}}."""
    terminals = terminals_result
    if isinstance(terminals, dict):
        terminals = terminals.get("terminals", [])
    index: dict[str, dict] = {}
    for t in terminals or []:
        key = _pane_key(t.get("tabId"), t.get("leafId"))
        if not key:
            continue
        index[key] = {
            "handle": t.get("handle"),
            "connected": t.get("connected"),
            "writable": t.get("writable"),
        }
    return index


def _nest_agents(raw_agents: list[dict], term_index: dict[str, dict]) -> list[dict]:
    """Turn a worktree's flat `agents[]` into a parentPaneKey-nested tree."""
    nodes: dict[str, dict] = {}
    order: list[str] = []
    for a in raw_agents:
        pane_key = a.get("paneKey")
        if not pane_key:
            continue
        term = term_index.get(pane_key, {})
        nodes[pane_key] = {
            "paneKey": pane_key,
            "parentPaneKey": a.get("parentPaneKey"),
            "agentType": a.get("agentType"),
            "state": a.get("state"),
            # `state: "working"` alone is not enough to mean "actually
            # working" — Orca's own UI (checked against its bundled source,
            # terminal-tab-activity-status.js) treats `workingMode:
            # "monitoring"` as a distinct, separate case: the agent finished
            # its turn and is idling/waiting, not crunching. Dropping this
            # field is what let a session asking the user a question render
            # as "Working" instead of "Needs attention".
            "workingMode": a.get("workingMode"),
            "displayName": a.get("displayName"),
            "taskTitle": a.get("taskTitle"),
            "prompt": a.get("prompt"),
            "lastAssistantMessage": a.get("lastAssistantMessage"),
            "toolName": a.get("toolName"),
            "toolInput": a.get("toolInput"),
            "interrupted": a.get("interrupted"),
            "stateStartedAt": a.get("stateStartedAt"),
            "updatedAt": a.get("updatedAt"),
            "terminalHandle": term.get("handle"),
            "connected": term.get("connected"),
            "writable": term.get("writable"),
            "children": [],
        }
        order.append(pane_key)

    top: list[dict] = []
    for pane_key in order:
        node = nodes[pane_key]
        parent_key = node["parentPaneKey"]
        parent = nodes.get(parent_key) if parent_key else None
        if parent is not None and parent is not node:
            parent["children"].append(node)
        else:
            top.append(node)
    return top


def project_state(ps_result: Any, terminals_result: Any) -> dict:
    term_index = build_terminal_index(terminals_result)
    worktrees_raw = ps_result.get("worktrees", []) if isinstance(ps_result, dict) else ps_result

    worktrees = []
    for w in worktrees_raw or []:
        worktrees.append(
            {
                "worktreeId": w.get("worktreeId"),
                "repo": w.get("repo"),
                "displayName": w.get("displayName"),
                "branch": w.get("branch"),
                "path": w.get("path"),
                "status": w.get("status"),
                "workspaceStatus": w.get("workspaceStatus"),
                "isMainWorktree": w.get("isMainWorktree"),
                "isPinned": w.get("isPinned"),
                "isActive": w.get("isActive"),
                "unread": w.get("unread"),
                "preview": w.get("preview"),
                "lastActivityAt": w.get("lastActivityAt"),
                "lastOutputAt": w.get("lastOutputAt"),
                "linkedPR": w.get("linkedPR"),
                "linkedIssue": w.get("linkedIssue"),
                "linkedLinearIssue": w.get("linkedLinearIssue"),
                "linkedGitLabMR": w.get("linkedGitLabMR"),
                "linkedGitLabIssue": w.get("linkedGitLabIssue"),
                "agents": _nest_agents(w.get("agents", []) or [], term_index),
            }
        )

    return {
        "schema": SCHEMA,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "worktrees": worktrees,
    }


# `orca account list --json` carries a `rateLimits` block keyed by provider —
# every harness Orca can track usage for, not only Claude. Label order here is
# also render order for the usage panel.
PROVIDER_LABELS = {
    "claude": "Claude",
    "codex": "Codex",
    "gemini": "Gemini",
    "opencodeGo": "OpenCode",
    "kimi": "Kimi",
    "antigravity": "Antigravity",
    "minimax": "MiniMax",
    "grok": "Grok",
}


def project_rate_limits(account_result: Any) -> list[dict]:
    """Only providers with a real, usable reading make it into the panel — a
    harness with no account connected (`status != "ok"`) has nothing to show
    and is left out entirely rather than rendered as a broken gauge."""
    raw = (account_result or {}).get("rateLimits") or {}
    out: list[dict] = []
    for provider, label in PROVIDER_LABELS.items():
        entry = raw.get(provider)
        if not isinstance(entry, dict) or entry.get("status") != "ok":
            continue
        windows: dict[str, dict] = {}
        for window_key in ("session", "weekly", "monthly"):
            w = entry.get(window_key)
            if isinstance(w, dict) and isinstance(w.get("usedPercent"), (int, float)):
                windows[window_key] = {
                    "usedPercent": w.get("usedPercent"),
                    "resetsAt": w.get("resetsAt"),
                    "resetDescription": w.get("resetDescription"),
                }
        if windows:
            out.append({"provider": provider, "label": label, "windows": windows})
    return out


# --------------------------------------------------------------------------- poller


class StateStore:
    """Thread-safe holder for the latest projection, with staleness tracking."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict = {"schema": SCHEMA, "generatedAt": None, "worktrees": []}
        self._error: str | None = "not polled yet"
        self._last_ok_at: float | None = None

    def set_ok(self, state: dict) -> None:
        with self._lock:
            self._state = state
            self._error = None
            self._last_ok_at = time.time()

    def set_error(self, message: str) -> None:
        with self._lock:
            self._error = message

    def snapshot(self) -> dict:
        with self._lock:
            doc = dict(self._state)
            doc["error"] = self._error
            doc["stale"] = self._last_ok_at is None or (time.time() - self._last_ok_at) > 15
            return doc


def poll_forever(binary: str, store: StateStore, interval: float, stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        try:
            ps = run_orca_json(binary, "worktree", "ps")
            terms = run_orca_json(binary, "terminal", "list")
            state = project_state(ps, terms)
        except OrcaCliError as exc:
            store.set_error(str(exc))
            stop_event.wait(interval)
            continue
        except Exception as exc:  # keep polling no matter what goes wrong
            store.set_error(f"unexpected: {exc}")
            stop_event.wait(interval)
            continue

        # Usage is a separate CLI call — its failure (e.g. no accounts
        # configured) must not take down the worktree/agent feed that already
        # succeeded above.
        try:
            accounts = run_orca_json(binary, "account", "list")
            state["rateLimits"] = project_rate_limits(accounts)
        except Exception:
            state["rateLimits"] = []

        store.set_ok(state)
        stop_event.wait(interval)


# --------------------------------------------------------------------------- auth token


def load_or_create_token() -> str:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if TOKEN_PATH.exists():
        token = TOKEN_PATH.read_text().strip()
        if token:
            return token
    token = secrets.token_urlsafe(24)
    TOKEN_PATH.write_text(token + "\n")
    try:
        TOKEN_PATH.chmod(0o600)
    except OSError:
        pass
    return token


def lan_ip() -> str:
    """Best-effort LAN-facing IP, for printing the pairing URL. Never actually
    sends anything — UDP connect to a public address just picks the outbound
    interface without a packet leaving the host."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# --------------------------------------------------------------------------- HTTP


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
        if path == "/" or not path.startswith("/v1/"):
            self._serve_static(path)
            return
        self.send_error(404, "not found")

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
            args = ["terminal", "send", "--terminal", handle, "--text", text]
            if body.get("enter", True):
                args.append("--enter")
        elif action == ACTION_INTERRUPT:
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


# --------------------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description="orcad — Orca session panel companion")
    parser.add_argument("--port", type=int, default=int(__import__("os").environ.get("ORCAD_PORT", DEFAULT_PORT)))
    parser.add_argument("--bind", default=__import__("os").environ.get("ORCAD_BIND", DEFAULT_BIND))
    parser.add_argument(
        "--interval",
        type=float,
        default=float(__import__("os").environ.get("ORCAD_POLL_INTERVAL", DEFAULT_POLL_INTERVAL)),
    )
    args = parser.parse_args()

    try:
        binary = find_orca_binary()
    except OrcaCliError as exc:
        print(f"orcad: {exc}", file=sys.stderr)
        return 1

    token = load_or_create_token()
    store = StateStore()
    stop_event = threading.Event()
    poller = threading.Thread(
        target=poll_forever, args=(binary, store, args.interval, stop_event), daemon=True
    )
    poller.start()

    handler_cls = make_handler_class(store, binary, token)
    httpd = ThreadingHTTPServer((args.bind, args.port), handler_cls)

    ip = lan_ip()
    print(f"orcad {VERSION} — polling `{binary}` every {args.interval}s")
    print(f"  local:  http://127.0.0.1:{args.port}/?token={token}")
    print(f"  LAN:    http://{ip}:{args.port}/?token={token}")
    print("  (open the LAN link on the iPad once; the token is then remembered on that device)")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
