"""The background loop: poll `orca` on an interval, keep the latest
projection around for the HTTP layer to serve."""
from __future__ import annotations

import threading
import time

from orcad.cli import OrcaCliError, run_orca_json
from orcad.projection import SCHEMA, project_rate_limits, project_state


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
