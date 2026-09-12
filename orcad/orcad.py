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

This file is just the entry point — argument parsing, wiring the poller
thread to the HTTP server, and the startup banner. The actual work lives in
sibling modules, each one responsibility:

  version.py     VERSION
  cli.py         the `orca` CLI wrapper (OrcaCliError, run_orca_json, ...)
  projection.py  raw `orca` output -> the /v1/state document
  poller.py      StateStore + the background poll loop
  auth.py        the pairing token + LAN IP for the startup banner
  server.py      the HTTP handler (routes, static files, /v1/action)

Everything below except main() is re-exported from those modules so existing
callers (the test suite included) that reach through `orcad.<name>` keep
working unchanged.
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

# Running this file directly (`python3 orcad/orcad.py`, exactly how
# scripts/run.sh and bin/orcadeck invoke it) auto-inserts this file's own
# directory — orcad/ itself — at the front of sys.path. That directory
# shadows the `orcad` package: with orcad/ on the path, Python resolves
# `import orcad.auth` by finding orcad/orcad.py *inside* it and treating
# `orcad` as that plain module instead of the parent package, so
# `orcad.auth` then 404s as "'orcad' is not a package". Strip that
# self-shadowing entry and put the repo root on the path instead — same fix
# tests/test_orcad.py already needed to import this file as a package.
_THIS_DIR = Path(__file__).resolve().parent
REPO_ROOT = _THIS_DIR.parent
sys.path[:] = [p for p in sys.path if p and Path(p).resolve() != _THIS_DIR]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from orcad.auth import STATE_DIR, TOKEN_PATH, lan_ip, load_or_create_token  # noqa: E402
from orcad.cli import (  # noqa: E402
    CLI_TIMEOUT_SEC,
    OrcaCliError,
    find_orca_binary,
    run_orca_json,
    send_text_confirmed,
)
from orcad.poller import StateStore, poll_forever  # noqa: E402
from orcad.projection import (  # noqa: E402
    PROVIDER_LABELS,
    SCHEMA,
    _nest_agents,
    build_terminal_index,
    project_rate_limits,
    project_state,
)
from orcad.server import (  # noqa: E402
    ACTION_INTERRUPT,
    ACTION_SEND_TEXT,
    PANEL_DIR,
    Handler,
    make_handler_class,
)
from orcad.version import VERSION  # noqa: E402

__all__ = [
    "STATE_DIR",
    "TOKEN_PATH",
    "lan_ip",
    "load_or_create_token",
    "CLI_TIMEOUT_SEC",
    "OrcaCliError",
    "find_orca_binary",
    "run_orca_json",
    "send_text_confirmed",
    "StateStore",
    "poll_forever",
    "PROVIDER_LABELS",
    "SCHEMA",
    "build_terminal_index",
    "project_rate_limits",
    "project_state",
    "ACTION_INTERRUPT",
    "ACTION_SEND_TEXT",
    "PANEL_DIR",
    "Handler",
    "make_handler_class",
    "VERSION",
    "main",
]

DEFAULT_PORT = 8720
DEFAULT_BIND = "0.0.0.0"
DEFAULT_POLL_INTERVAL = 2.0


def main() -> int:
    parser = argparse.ArgumentParser(description="orcad — Orca session panel companion")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ORCAD_PORT", DEFAULT_PORT)))
    parser.add_argument("--bind", default=os.environ.get("ORCAD_BIND", DEFAULT_BIND))
    parser.add_argument(
        "--interval",
        type=float,
        default=float(os.environ.get("ORCAD_POLL_INTERVAL", DEFAULT_POLL_INTERVAL)),
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
