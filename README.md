# orcaDeck 🐋

A live panel of everything [Orca](https://orcaapp.dev) is running — every
worktree, every agent, every subagent, every harness — servable to any device
on your LAN (an iPad, say), with the ability to reply into a session from
there. A sibling to [SideCrab](https://github.com/Dixie-sketch/Clawdeck), not
a fork of it: same "small companion + polling panel" shape, sourced from Orca
instead of Claude Code's hooks, so it sees every harness Orca runs, not only
Claude.

## What you need

- **Orca**, installed and running (its `orca` CLI needs to resolve on PATH).
- **Python 3.9+** — stdlib only, no dependencies to install.

## Run it

```
scripts/run.sh
```

This prints two URLs:

```
local:  http://127.0.0.1:8720/?token=...
LAN:    http://192.168.x.x:8720/?token=...
```

Open the **LAN** one on your iPad's Safari, once — the token pairs that
browser and is remembered from then on (`localStorage`), so day to day you
can just bookmark `http://192.168.x.x:8720/`. Add it to the iPad's Home
Screen for a full-screen panel.

Environment variables, if you want non-defaults: `ORCAD_PORT` (default
`8720`), `ORCAD_BIND` (default `0.0.0.0`), `ORCAD_POLL_INTERVAL` seconds
(default `2`).

## What it shows

One card per worktree — status dot, name, branch, the `primary` chip on your
main worktree — and under it, one row per agent Orca is running there, with
its harness logo, its current state and tool, and subagents nested under
their parent exactly the way Orca's own sidebar shows them.

Tap **Reply** on any row with a live terminal to send text straight into that
session.

## How it works

See [`docs/design.md`](docs/design.md) for the full design. In short: `orcad`
polls `orca worktree ps --json` + `orca terminal list --json` every couple of
seconds, projects them into one JSON document, and serves that plus the
panel itself from one process/port — no separate proxy step, unlike
SideCrab's iCUE-widget split.

## Status

v0.1.0 — read the tree, reply into a session. Richer write actions
(answering orchestration questions/gates directly) are a natural next step;
see the design doc's non-goals.
