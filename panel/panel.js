// orcaDeck panel — polls orcad's /v1/state and renders the worktree/agent
// tree the way Orca's own sidebar does: a card per worktree, a row per
// agent, subagents nested under their parent. Vanilla JS, no build step —
// same spirit as SideCrab's widget.

const POLL_MS = 2000;
const TOKEN_KEY = "orcad_token";

const LOGO_BY_TYPE = {
  claude: "/assets/harness/claude.webp",
  "claude-agent-teams": "/assets/harness/claude.webp",
  openclaude: "/assets/harness/openclaude.png",
  opencode: "/assets/harness/opencode.webp",
};

function getToken() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.pathname + url.search);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY);
}

let TOKEN = getToken();

function fmtAge(ms) {
  if (!ms) return "";
  const deltaSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

function el(tag, className, children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (children) for (const c of children) if (c) node.append(c);
  return node;
}

function harnessLogo(agentType) {
  const src = LOGO_BY_TYPE[agentType];
  if (src) {
    const img = el("img", "agent-logo");
    img.src = src;
    img.alt = agentType;
    return img;
  }
  const badge = el("div", "agent-logo fallback");
  badge.textContent = (agentType || "?").slice(0, 2).toUpperCase();
  return badge;
}

function agentStateLine(agent) {
  const line = el("div", "agent-state" + (agent.state === "done" ? " done" : ""));
  const kw = el("span", "kw");
  kw.textContent = agent.state === "working" ? "Working" : agent.state === "done" ? "Done" : (agent.state || "—");
  line.append(kw);
  if (agent.toolName) {
    line.append(document.createTextNode(" — " + agent.toolName));
    if (agent.toolInput) {
      const trimmed = String(agent.toolInput).slice(0, 80);
      line.append(document.createTextNode(": " + trimmed));
    }
  } else if (agent.lastAssistantMessage) {
    line.append(document.createTextNode(" — " + String(agent.lastAssistantMessage).slice(0, 80)));
  }
  return line;
}

async function sendAction(body) {
  const res = await fetch("/v1/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + (TOKEN || "") },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    document.getElementById("token-banner").hidden = false;
    throw new Error("unauthorized");
  }
  return res.json();
}

function buildReplyBox(agent) {
  const box = el("div", "reply-box");
  box.hidden = true;
  const textarea = document.createElement("textarea");
  textarea.placeholder = "Send to this session…";
  const button = document.createElement("button");
  button.textContent = "Send";
  button.disabled = !agent.terminalHandle;
  button.onclick = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    button.disabled = true;
    try {
      await sendAction({ type: "send-text", terminalHandle: agent.terminalHandle, text, enter: true });
      textarea.value = "";
      box.hidden = true;
    } catch (err) {
      console.error(err);
    } finally {
      button.disabled = false;
    }
  };
  box.append(textarea, button);
  return box;
}

function renderAgent(agent, depth) {
  const row = el("div", "agent-row");
  row.dataset.depth = String(Math.min(depth, 3));

  const main = el("div", "agent-main");
  const line = el("div", "agent-line", [agentStateLine(agent)]);
  const age = el("span", "agent-age");
  age.textContent = fmtAge(agent.updatedAt || agent.stateStartedAt);
  line.append(age);
  main.append(line);

  const label = agent.displayName || agent.taskTitle || agent.agentType;
  if (label) {
    const detail = el("div", "agent-detail");
    detail.textContent = label;
    main.append(detail);
  }

  if (agent.terminalHandle) {
    const toggle = el("button", "agent-reply-toggle");
    toggle.textContent = "Reply";
    const replyBox = buildReplyBox(agent);
    toggle.onclick = () => {
      replyBox.hidden = !replyBox.hidden;
    };
    main.append(toggle, replyBox);
  }

  row.append(harnessLogo(agent.agentType), main);

  const rows = [row];
  for (const child of agent.children || []) {
    rows.push(...renderAgent(child, depth + 1));
  }
  return rows;
}

function statusDotClass(status) {
  if (status === "working" || status === "active") return "dot on";
  if (status === "needs_input" || status === "attention") return "dot attn";
  return "dot";
}

function renderWorktree(w) {
  const card = el("div", "card");

  const head = el("div", "card-head", [el("span", statusDotClass(w.status))]);
  const title = el("div", "card-title");
  title.textContent = w.displayName || w.repo || w.branch || "worktree";
  head.append(title);
  if (w.isMainWorktree) {
    const chip = el("span", "chip");
    chip.textContent = "primary";
    head.append(chip);
  }
  card.append(head);

  const sub = el("div", "card-sub");
  sub.textContent = [w.repo, w.branch].filter(Boolean).join(" · ");
  card.append(sub);

  if (w.agents && w.agents.length) {
    const agentsBox = el("div", "agents");
    for (const a of w.agents) {
      for (const row of renderAgent(a, 0)) agentsBox.append(row);
    }
    card.append(agentsBox);
  }

  return card;
}

function render(doc) {
  const app = document.getElementById("app");
  const empty = document.getElementById("empty");
  const status = document.getElementById("topbar-status");
  const banner = document.getElementById("token-banner");

  if (doc.error) {
    status.textContent = doc.stale ? "stale — " + doc.error : doc.error;
    status.className = doc.stale ? "stale" : "dead";
  } else {
    status.textContent = "live";
    status.className = "";
  }
  banner.hidden = true;

  [...app.querySelectorAll(".card")].forEach((n) => n.remove());

  const worktrees = doc.worktrees || [];
  empty.hidden = worktrees.length > 0;
  for (const w of worktrees) {
    app.append(renderWorktree(w));
  }
}

async function poll() {
  try {
    const res = await fetch("/v1/state", { cache: "no-store" });
    const doc = await res.json();
    render(doc);
  } catch (err) {
    const status = document.getElementById("topbar-status");
    status.textContent = "unreachable";
    status.className = "dead";
  }
}

poll();
setInterval(poll, POLL_MS);
