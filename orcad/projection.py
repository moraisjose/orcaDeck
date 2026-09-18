"""Turns raw `orca` CLI output into the small JSON document orcad serves at
/v1/state — the shape the panel actually renders."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

SCHEMA = 1


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
            # `state: "working"` alone is not enough to say WHAT kind of
            # work: Orca's own UI treats `workingMode: "monitoring"` as its
            # own case, and its label for it is "Monitoring background
            # tasks". Per claude-roster-state.js it is minted only when the
            # lead turn is already done and a background shell task or a
            # session cron is still running — so the panel shows it as busy,
            # distinct from a turn actually being driven, and never as a
            # session asking for a human. That misreading is what used to pin
            # every session with a background task in "Needs attention".
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
