---
name: setup-orcadeck
description: Use when the user wants to set up, install, start, launch, or serve orcaDeck, needs the LAN URL to open the panel on an iPad or other external device, or asks how to pair a new device with orcad.
---

# Setting up orcaDeck

## Overview

orcaDeck is `orcad` (a small Python HTTP server, stdlib only) plus a static
panel it serves on the same port. Setting it up means: confirm the two
prerequisites, start `orcad` if it isn't already running, then hand the user
the exact URL their external device (iPad, say) needs — not just "it's
running", the actual pairing link.

## Prerequisites

1. **`orca` CLI resolves on PATH** — `which orca`. If missing, tell the user
   to install/open Orca first (`orcad` shells out to this CLI for every
   worktree/agent poll and refuses to start without it).
2. **Python 3.9+** — `python3 --version`. No pip installs; the server is
   stdlib-only.

Don't proceed to starting the server if either check fails — report which
one and stop.

## Check if it's already running

```bash
pgrep -f "orcad/orcad.py"
```

If a process is already up, **don't start a second one** — a second process
would fail to bind the same port anyway. Skip straight to
[Get the pairing URL](#get-the-pairing-url) below.

## Start it

From the repo root:

```bash
scripts/run.sh > /tmp/orcad_run.log 2>&1 &
disown
```

Run this with the Bash tool's `run_in_background` if available, so it's not
blocking. Give it 1-2 seconds, then confirm it actually bound the port
rather than dying immediately:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8720/
```

A `200` means it's up. If it's not (connection refused, or the log shows
`orcad: ...` on stderr), read `/tmp/orcad_run.log` — the most common cause is
prerequisite #1 (`orca` not on PATH).

Non-default port/bind/poll-interval: the script reads `ORCAD_PORT` (default
`8720`), `ORCAD_BIND` (default `0.0.0.0`), `ORCAD_POLL_INTERVAL` seconds
(default `2`) from the environment — set them before invoking `scripts/run.sh`
if the user asked for something else. Use the same port number in every step
below.

## Get the pairing URL

Whether you just started it or found it already running, build the URL the
same way — don't rely on capturing `scripts/run.sh`'s own stdout, since a
backgrounded process's output isn't reliably readable and a live process
that was started earlier (by this skill or otherwise) never re-prints it.
Read the same two things `orcad` itself uses to print its banner:

```bash
TOKEN=$(cat ~/.orcad/token)
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1")
echo "http://$IP:8720/?token=$TOKEN"
```

(Swap `8720` for the actual port if it's non-default.) `ipconfig getifaddr`
is macOS-specific; on Linux use `hostname -I | awk '{print $1}'` or
`ip route get 1.1.1.1 | awk '{print $7; exit}'` instead.

**The token is only needed for one thing: replying into a session.**
`GET /v1/state` (everything the dashboard shows — cards, usage, everything)
is unauthenticated by design; only `POST /v1/action` (the Send button in a
session's modal) checks it. So there are two valid URLs to hand back,
depending on what the user asked for:

- **Viewing only** ("just want to see it on the iPad", a display/monitor
  use case): `http://$IP:8720/` — no token, nothing to pair, works
  immediately, forever.
- **Viewing + replying** (the default, if they didn't specify): the
  `?token=$TOKEN` URL above, opened once so the device's `localStorage`
  picks it up. If they only mentioned viewing/monitoring, offer the plain
  URL first and mention the token URL as what unlocks replying, rather than
  assuming they want write access.

**Report the URL back to the user as the final answer** — this is the whole
point of the skill, not an intermediate step. If you gave the token URL,
tell them explicitly:

- Open that exact URL in Safari on the external device **once** — the token
  pairs that browser and is remembered in `localStorage` from then on.
- After that first open, they can bookmark the plain `http://<ip>:8720/`
  (no token needed for viewing either way) and/or add it to the device's
  Home Screen for a full-screen panel.
- The token file lives at `~/.orcad/token` and is stable across restarts —
  re-running this skill later reuses the same token, so a device paired
  once stays paired.

## Common mistakes

- **Printing "server started" without the URL.** The user can't do anything
  with that — the URL is the deliverable, whichever of the two above fits.
- **Always defaulting to the token URL.** If the user only asked to view the
  panel, the plain no-token URL is the correct answer — don't hand out write
  access they didn't ask for.
- **Starting a second `orcad` process.** Always check `pgrep` first; a port
  already in bind will make the new process fail, and the OLD process (with
  the URL you should actually report) keeps serving.
- **Trying to scrape the backgrounded shell's stdout for the URL.** It was
  designed for a human watching a foreground terminal. Read `~/.orcad/token`
  and compute the IP directly instead — deterministic, works whether you or
  someone else started the process.
- **Guessing the LAN IP.** Don't assume `192.168.x.x` — compute it with
  `ipconfig getifaddr`/equivalent, since it can be on any subnet.
