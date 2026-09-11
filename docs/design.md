# orcaDeck — design

**2026-09-11.** A LAN-servable panel for everything Orca is running, sourced
directly from Orca — a sibling to SideCrab, not a fork of it. SideCrab
(crabd + widget) stays exactly as it is; this is a new, standalone project.

## Why a new source instead of extending crabd

crabd's source is Claude Code's own hooks, which only exist for Claude Code
sessions started the normal way. Orca sees strictly more: every harness it
launches (Claude, Codex, OpenCode, ...), every worktree, and the
parent/subagent shape of a dispatch — all through one already-running
process. Reading it costs nothing to set up (no hooks to install) and grows
for free as Orca adds harnesses.

## Integration boundary: the `orca` CLI, not the daemon socket

Orca exposes the same data two ways: a documented, versioned CLI
(`orca worktree ps --json`, `orca terminal list --json`, `agent-context` for
the full schema) and a private unix-socket RPC the desktop app itself uses.
The CLI is the contract Orca commits to keeping stable; the socket is an
implementation detail with no version guarantee. orcad only ever shells out
to the CLI. Measured round-trip on this machine: ~80-120ms per call, cheap
enough to poll every couple of seconds.

## Shape: one process, not two

SideCrab is split into crabd (data) and widget (an `.icuewidget` package,
imported into iCUE, that can't proxy or fetch cross-origin on its own) —
hence the LAN-preview proxy script. orcaDeck has no such constraint: the
panel is a plain page for Safari on an iPad, so **orcad serves both the JSON
feed and the static panel itself**, bound to `0.0.0.0` for LAN reach. One
process, one port, no proxy.

```
orca CLI (worktree ps, terminal list) ──poll──▶ orcad (0.0.0.0:8720)
                                                    │  GET /v1/state   (read)
                                                    │  POST /v1/action (write, token-gated)
                                                    │  GET /, /panel.js, ... (static)
                                                    ▼
                                          panel in iPad Safari (polls every 2s)
```

## Data projection

`orca worktree ps --json` already returns almost the exact shape the sidebar
renders from: worktrees with `displayName`/`branch`/`status`/`isMainWorktree`/
`linkedPR` etc., each carrying a flat `agents[]` list. Every agent carries
`parentPaneKey`; orcad nests that flat list into a tree per worktree — that
edge *is* the subagent relationship, no extra call needed. `orca terminal
list --json` is joined in by `paneKey = tabId:leafId` to attach a
`terminalHandle` to every agent that has a live terminal, which is what makes
that agent remote-controllable.

Harness identity: `agentType` (`claude`, `opencode`, `codex`, ...) rides
straight through. Logos are the same static marks Orca's own UI uses
(`claude.webp`, `opencode.webp`, `openclaude.png`, copied into
`panel/assets/harness/` as local static files); an agent type with no shipped
mark falls back to a two-letter badge rather than guessing.

## Remote control (v0.1.0 scope)

One write action to start: **send text into a session's terminal** —
`orca terminal send --terminal <handle> --text "..." --enter`, plus a plain
`--interrupt`. That covers answering a question, unblocking a stuck agent, or
steering it, which is the case that actually comes up from an iPad. Richer
flows Orca also exposes — `orchestration reply`, `gate-resolve`, threaded
`ask` — are a natural v0.2.0 once this path is proven; nothing about the
projection needs to change to add them, since a question/gate is just another
kind of pending state on a node that already has a `terminalHandle`.

## Auth

orcad binds the LAN and can steer real running agents, so `/v1/action` is
gated behind a bearer token generated on first run and stored in
`~/.orcad/token`. The console prints a pairing URL
(`http://<lan-ip>:<port>/?token=...`); the panel reads the token from the URL
once, stores it in `localStorage`, and strips it from the address bar. `GET
/v1/state` stays open on the LAN — read-only, same posture as crabd's own
`/v1/state`.

## Non-goals for v0.1.0

- No push/eventing — polling only, matching crabd's own model.
- No auth beyond a single shared token — this is a personal LAN tool, not a
  multi-user service.
- No attempt to reproduce Orca's own mobile-pairing/E2EE relay; that's a
  different, already-existing surface with a different UI.
