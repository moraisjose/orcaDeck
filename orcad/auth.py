"""Pairing token for /v1/action, and the LAN IP used to print it."""
from __future__ import annotations

import secrets
import socket
from pathlib import Path

STATE_DIR = Path.home() / ".orcad"
TOKEN_PATH = STATE_DIR / "token"


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
