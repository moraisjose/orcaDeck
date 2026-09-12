"""Thin wrapper around the `orca` CLI — every `--json` subcommand orcad shells
out to, plus the confirmed-send dance `/v1/action` needs for `send-text`."""
from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any

CLI_TIMEOUT_SEC = 10


class OrcaCliError(RuntimeError):
    def __init__(self, message: str, error: dict | None = None) -> None:
        super().__init__(message)
        # The structured `error` payload orca itself returned, when there
        # was one — e.g. `agent_prompt_blocked` carries a retry-request id
        # in `error["data"]["orchestrationRequestId"]` that callers need
        # without having to regex it back out of the message string.
        self.error = error or {}


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
        err = doc.get("error")
        raise OrcaCliError(
            f"`{' '.join(cmd)}` reported failure: {err or doc}",
            error=err if isinstance(err, dict) else None,
        )
    return doc.get("result", doc)


# `orca terminal send` separates "did the CLI accept these bytes" from "did
# the agent's turn actually start" — a bare send can come back `ok: true`
# with delivery still unconfirmed (no `turn_started` stage yet), or
# `ok: false` with `agent_prompt_blocked` (an ambiguous transport failure).
# Both responses carry the exact retry-request id to reissue with
# `--retry-request`/`--wait-submit` to get a real answer. Doing that reissue
# here means a reply from the panel comes back confirmed, not a "maybe" the
# person has to go verify by hand against a second terminal.
def send_text_confirmed(
    binary: str, handle: str, text: str, enter: bool, wait_submit: float = 8.0
) -> Any:
    args = ["terminal", "send", "--terminal", handle, "--text", text]
    if enter:
        args.append("--enter")

    def confirm(request_id: str) -> Any:
        return run_orca_json(
            binary,
            *args,
            "--retry-request",
            request_id,
            "--wait-submit",
            str(wait_submit),
            timeout=wait_submit + CLI_TIMEOUT_SEC,
        )

    try:
        result = run_orca_json(binary, *args)
    except OrcaCliError as exc:
        request_id = (exc.error.get("data") or {}).get("orchestrationRequestId")
        if not request_id:
            raise
        return confirm(request_id)

    prompt = (result.get("send") or {}).get("prompt") if isinstance(result, dict) else None
    stages = (prompt or {}).get("stages") or []
    request_id = (prompt or {}).get("requestId")
    if request_id and "turn_started" not in stages:
        return confirm(request_id)
    return result
