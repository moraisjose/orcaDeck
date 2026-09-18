// orcaDeck panel — polls orcad's /v1/state and renders a usage column plus a
// scrollable, sorted/filterable list of session cards, the way Clawdeck lays
// its own panel out (usage left, sessions right). Vanilla JS, no build step.
//
// Rendering is a keyed diff, not a teardown/rebuild: every poll updates
// existing DOM nodes in place (by worktreeId) and only creates/removes nodes
// when the session set actually changes. A full rebuild every 2s was why
// harness logos used to flash on every poll — an <img> torn down and
// recreated re-decodes from scratch even when the bytes are cached.

const POLL_MS = 2000;
const TOKEN_KEY = "orcad_token";

// Real brand marks only. claude.svg/opencode.svg are the exact paths Clawdeck
// verified it lifted from Orca's own UI ("the REAL ones... so the panel and
// the window the operator already has open name the same thing the same
// way" — sidecrab.js CLIENT_GLYPHS) — the .webp files orcaDeck shipped here
// before this were mismatched mascot art bundled elsewhere in Orca's app,
// not its Claude/OpenCode logos. gremlin/gwindows were dropped outright: they
// aren't real agentType values Orca ever emits (checked against Orca's own
// agent catalog), just more of that unrelated mascot art.
// onerror below still catches an agentType with no shipped mark at all (e.g.
// codex, gemini, pi) and swaps to the text badge instead of a broken image.
const LOGO_BY_TYPE = {
  claude: "/assets/harness/claude.svg",
  "claude-agent-teams": "/assets/harness/claude.svg",
  openclaude: "/assets/harness/openclaude.png",
  opencode: "/assets/harness/opencode.svg",
  ghostty: "/assets/harness/ghostty.svg",
  minimax: "/assets/harness/minimax.svg",
};

// Orca's own status vocabulary, in Orca's own priority order — reproduced,
// not reinvented. The ladder is worktree-status.js's: permission > working >
// monitoring > interrupted > done. Everything in this file that classifies an
// agent goes through agentStatus(), so the rule can never drift between the
// rollup, the card icon, the mascot and the modal's per-agent line.
//
// `state` itself is only ever one of four values (AGENT_STATUS_STATES in
// Orca's agent-status-types.js): working, blocked, waiting, done. The two
// derived statuses are the ones worth spelling out, because guessing at them
// is exactly what this file used to get wrong:
//
//   monitoring — `state:"working"` + `workingMode:"monitoring"`. NOT "the
//     agent asked a question and is waiting on a reply". Orca mints it in
//     claude-roster-state.js only when the lead turn is ALREADY done and a
//     background shell task or a session cron is still running; its own label
//     is "Monitoring background tasks", and terminal-tab-activity-status.js
//     groups it with working/permission as busy. Reading it as attention
//     pinned every session with a background task in "Needs attention" for
//     good — and since the mascot's Done bounce was gated on nothing needing
//     attention anywhere, it also meant that animation could never fire.
//
//   unverifiable — a non-done status too old to believe. Orca decays these
//     after AGENT_STATUS_STALE_AFTER_MS (agent-status-freshness.js) so a pane
//     whose hook stream died stops counting as live work; its dot calls that
//     "No recent update". Without the same gate here a dead pane claims to be
//     working for as long as orcad keeps polling.
//
// "Needs attention" is exactly Orca's `permission`, and nothing else: state
// blocked or waiting. `interrupted` is its own rung, below monitoring — it
// only ever rides `state:"done"` carrying `is_interrupt` from Claude's Stop
// hook (claude-events.js), i.e. a human pressed Esc/Ctrl+C. A run the human
// ended on purpose is not a run asking for their attention.
const STALE_AFTER_MS = 30 * 60 * 1000;

const STATUS_RANK = {
  permission: 0,
  working: 1,
  monitoring: 2,
  interrupted: 3,
  done: 4,
  unverifiable: 5,
  idle: 5,
};

const STATUS_LABEL = {
  permission: "Needs attention",
  working: "Working",
  monitoring: "Monitoring",
  interrupted: "Interrupted",
  done: "Done",
  unverifiable: "No recent update",
  idle: "Idle",
};

// Band -> the status that put a worktree in it. Bands 5 is shared by idle and
// unverifiable (Orca treats a decayed pane as contributing nothing either),
// so the rollup resolves that one from the counts instead.
const BAND_STATUS = ["permission", "working", "monitoring", "interrupted", "done", "idle"];

function agentStatus(agent, now) {
  const state = agent.state;
  // done is never stale-gated — a finished turn stays finished however long
  // ago it finished, which is why Orca's freshness check is explicitly
  // "isFreshNonDoneAgentStatus".
  if (state === "done") return agent.interrupted === true ? "interrupted" : "done";
  if (state !== "working" && state !== "blocked" && state !== "waiting") return "idle";
  const seenAt = agent.updatedAt || agent.stateStartedAt || 0;
  if (!seenAt || (now || Date.now()) - seenAt > STALE_AFTER_MS) return "unverifiable";
  if (state === "working") return agent.workingMode === "monitoring" ? "monitoring" : "working";
  return "permission";
}

const FILTER_MODES = ["all", "working", "attention", "done"];
const FILTER_LABELS = { all: "All", working: "Working", attention: "Needs attention", done: "Done" };

let filterMode = "all";
const cardNodes = new Map(); // worktreeId -> card element
let lastGoodDoc = null;
let openModalId = null;

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

// Read in boot(), not here: this file has to be requirable outside a browser
// (see the bottom of the file) and getToken() reaches for window/localStorage.
let TOKEN = null;

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

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function harnessLogo(agentType) {
  const src = LOGO_BY_TYPE[agentType];
  const badge = el("div", "agent-logo fallback");
  badge.textContent = (agentType || "?").slice(0, 2).toUpperCase();
  if (!src) return badge;
  const img = el("img", "agent-logo");
  img.src = src;
  img.alt = agentType;
  // A harness type with no shipped mark (codex, say) 404s — swap to the
  // text badge instead of leaving the browser's broken-image icon on screen.
  img.onerror = () => img.replaceWith(badge);
  return img;
}

// -------------------------------------------------------------- rollup / sort / filter

function collectAgents(agents, out) {
  for (const a of agents || []) {
    out.push(a);
    collectAgents(a.children, out);
  }
}

function rollup(w) {
  const agents = [];
  collectAgents(w.agents, agents);

  // Deliberately NOT seeded from w.status: orca's worktree-level "active" just
  // means "has a live/attached terminal" (the same green dot Orca's own UI
  // shows for a long-finished session), not "an agent is working right now".
  // Only a specific agent's state counts as evidence of work in progress.
  //
  // The band IS the worktree's position on Orca's ladder: the best (lowest)
  // rank any of its agents holds. One shared ladder means the card icon, the
  // sort order and the filter chips can't disagree about what a session is.
  const now = Date.now();
  const counts = {};
  let band = STATUS_RANK.idle;
  for (const a of agents) {
    const s = agentStatus(a, now);
    counts[s] = (counts[s] || 0) + 1;
    if (STATUS_RANK[s] < band) band = STATUS_RANK[s];
  }

  let status = agents.length ? BAND_STATUS[band] : "idle";
  if (band === STATUS_RANK.idle && counts.unverifiable) status = "unverifiable";

  const n = counts[status] || 0;
  let label;
  if (!agents.length) label = "Idle";
  else if (band === 0) label = n > 1 ? `${n} need attention` : "Needs attention";
  else if (band === 1) label = n > 1 ? `${n} working` : "Working";
  else if (band === 2) label = n > 1 ? `${n} monitoring` : "Monitoring background tasks";
  else label = STATUS_LABEL[status];

  return { band, status, label, agentCount: agents.length };
}

// Six bands, three chips: the chips group them the way Orca groups its own
// statuses — working and monitoring are both "busy", done and interrupted are
// both "finished" — so no band is left unreachable behind every chip.
function matchesFilter(band, mode) {
  if (mode === "all") return true;
  if (mode === "attention") return band === 0;
  if (mode === "working") return band === 1 || band === 2;
  if (mode === "done") return band === 3 || band === 4;
  return true;
}

// lastOutputAt, not lastActivityAt — checked against live data where the two
// diverged by 14+ hours on the same worktree (lastActivityAt tracks
// something else, stale after just replying into that session).
// lastOutputAt is the one that actually moves the moment a terminal produces
// new output, which is what "most recent" should mean here.
function recencyOf(w) {
  return w.lastOutputAt || w.lastActivityAt || 0;
}

function sortedWorktrees(worktrees) {
  return worktrees
    .map((w, i) => ({ w, i, r: rollup(w) }))
    .sort((a, b) => (a.r.band - b.r.band) || (recencyOf(b.w) - recencyOf(a.w)) || (a.i - b.i));
}

// ---------------------------------------------------------------- state icons

// The exact icons Orca's own AgentStateDot component uses (read out of its
// bundled source): a CSS spinner ring for working, Lucide's
// message-circle-question-mark for needs attention, circle-check for done,
// activity for monitoring, circle-dashed for a status too old to verify.
// Reproduced as real elements/paths, not re-drawn, so they read as the same
// status language a viewer already knows from Orca itself.
const SVG_NS = "http://www.w3.org/2000/svg";

function svgIcon(className, defs) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "state-icon " + className);
  for (const [tag, attrs] of defs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    svg.appendChild(node);
  }
  return svg;
}

function chatIcon() {
  return svgIcon("icon-chat", [
    ["path", { d: "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" }],
    ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }],
    ["path", { d: "M12 17h.01" }],
  ]);
}

function checkIcon() {
  return svgIcon("icon-check", [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "m9 12 2 2 4-4" }],
  ]);
}

// Lucide `activity` — the pulse line Orca shows for a pane that is only
// monitoring background tasks, deliberately not the working spinner.
function activityIcon() {
  return svgIcon("icon-activity", [
    ["path", { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" }],
  ]);
}

// Lucide `circle-dashed` — Orca's own mark for "No recent update".
function dashedIcon() {
  return svgIcon("icon-dashed", [
    ["path", { d: "M10.1 2.182a10 10 0 0 1 3.8 0" }],
    ["path", { d: "M13.9 21.818a10 10 0 0 1-3.8 0" }],
    ["path", { d: "M17.609 3.721a10 10 0 0 1 2.69 2.7" }],
    ["path", { d: "M2.182 13.9a10 10 0 0 1 0-3.8" }],
    ["path", { d: "M20.279 17.609a10 10 0 0 1-2.7 2.69" }],
    ["path", { d: "M21.818 10.1a10 10 0 0 1 0 3.8" }],
    ["path", { d: "M3.721 6.391a10 10 0 0 1 2.7-2.69" }],
    ["path", { d: "M6.391 20.279a10 10 0 0 1-2.69-2.7" }],
  ]);
}

// Takes one of agentStatus()'s values. The mascot passes its own mood names,
// which are a near-subset — "attn" is its spelling of permission.
function stateIconNode(kind) {
  if (kind === "working") return el("span", "state-icon spin-ring");
  if (kind === "monitoring") return activityIcon();
  if (kind === "permission" || kind === "attn") return chatIcon();
  if (kind === "done") return checkIcon();
  if (kind === "unverifiable") return dashedIcon();
  if (kind === "interrupted") return el("span", "state-icon dot-interrupted");
  return el("span", "state-icon dot-plain");
}

// ------------------------------------------------------------------- cards

// The rollup already resolved which status put this worktree in its band;
// that name is both the icon to draw and the class that colours it.
function stateClass(r) {
  return r.status;
}

function buildCard(w) {
  const card = el("div", "card");
  card.tabIndex = 0;
  card.setAttribute("role", "button");

  // State icon reads first, right before the name — its colour is the only
  // state signal left on the card now; no separate state-word line.
  const head = el("div", "card-head");
  const stateIconSlot = el("span", "card-state-icon");
  const title = el("div", "card-title");
  const chip = el("span", "chip");
  chip.textContent = "primary";
  head.append(stateIconSlot, title, chip);

  const sub = el("div", "card-sub");
  const agentsBox = el("div", "card-agents");

  card.append(head, sub, agentsBox);
  card.addEventListener("click", () => openModal(card.dataset.wtid));
  card.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      openModal(card.dataset.wtid);
    }
  });

  return card;
}

function agentStateKind(agent) {
  return agentStatus(agent);
}

// The line a subagent row shows: whatever's most specific about what it's
// doing right now, in the same priority order the modal's full detail uses.
function agentRowText(agent) {
  if (agent.toolName) {
    const input = agent.toolInput ? String(agent.toolInput).slice(0, 60) : "";
    return input ? `${agent.toolName}: ${input}` : agent.toolName;
  }
  if (agent.lastAssistantMessage) return String(agent.lastAssistantMessage).slice(0, 60);
  return agent.taskTitle || agent.displayName || agent.prompt || agent.agentType || "—";
}

const CARD_AGENT_ROW_LIMIT = 4;

// Flattens the agent/subagent tree into (agent, depth) pairs, depth-first —
// the same order Orca's own sidebar lists a dispatch under its parent —
// capped so one worktree running a large dispatch can't blow up a grid card.
function flattenAgentsForCard(agents, depth, out) {
  for (const a of agents || []) {
    if (out.length >= CARD_AGENT_ROW_LIMIT) return;
    out.push({ agent: a, depth });
    flattenAgentsForCard(a.children, depth + 1, out);
  }
}

function countAgents(agents) {
  let n = 0;
  for (const a of agents || []) n += 1 + countAgents(a.children);
  return n;
}

function buildCardAgentRow(agent, depth) {
  const row = el("div", "card-agent-row");
  row.style.marginLeft = depth * 14 + "px";
  const dot = stateIconNode(agentStateKind(agent));
  const logo = harnessLogo(agent.agentType);
  const text = el("span", "card-agent-text");
  text.textContent = agentRowText(agent);
  const age = el("span", "card-agent-age");
  age.textContent = fmtAge(agent.updatedAt || agent.stateStartedAt);
  row.append(dot, logo, text, age);
  return row;
}

function updateCard(card, w, r) {
  card.dataset.wtid = w.worktreeId;
  card.className = "card" + (r.band === 0 ? " attn" : r.band <= 2 ? " working" : "");

  const kind = stateClass(r);
  const iconSlot = card.querySelector(".card-state-icon");
  iconSlot.className = "card-state-icon " + kind;
  if (iconSlot.dataset.kind !== kind) {
    iconSlot.textContent = "";
    iconSlot.append(stateIconNode(kind));
    iconSlot.dataset.kind = kind;
  }

  setText(card.querySelector(".card-title"), w.displayName || w.repo || w.branch || "worktree");
  card.querySelector(".chip").hidden = !w.isMainWorktree;

  setText(card.querySelector(".card-sub"), [w.repo, w.branch].filter(Boolean).join(" · "));

  // Every agent/subagent gets its own bordered sub-card, nested under the
  // session card — the state line above already says Working/Done/Idle for
  // the whole session, so this is purely "what's actually running".
  const agentsBox = card.querySelector(".card-agents");
  agentsBox.textContent = "";
  const flat = [];
  flattenAgentsForCard(w.agents, 0, flat);
  const total = countAgents(w.agents);
  for (const { agent, depth } of flat) agentsBox.append(buildCardAgentRow(agent, depth));
  if (total > flat.length) {
    const more = el("div", "card-agent-more");
    more.textContent = `+${total - flat.length} more`;
    agentsBox.append(more);
  }
}

function renderCards(worktrees) {
  const container = document.getElementById("cards");
  const ranked = sortedWorktrees(worktrees).filter((x) => matchesFilter(x.r.band, filterMode));

  const seen = new Set();
  let prevNode = null;
  for (const { w, r } of ranked) {
    seen.add(w.worktreeId);
    let card = cardNodes.get(w.worktreeId);
    if (!card) {
      card = buildCard(w);
      cardNodes.set(w.worktreeId, card);
    }
    updateCard(card, w, r);
    // Keyed reorder — but ONLY when actually out of place. Node.after()/
    // .prepend() always remove-then-reinsert per the DOM spec, even when the
    // node is already exactly where it belongs; reinserting a node blurs it
    // if it (or a descendant) had focus. Skipping the call when the position
    // is already correct is what makes this truly a no-op on an unchanged
    // order, not just "no visible move".
    if (prevNode) {
      if (prevNode.nextElementSibling !== card) prevNode.after(card);
    } else if (container.firstElementChild !== card) {
      container.prepend(card);
    }
    prevNode = card;
  }

  for (const [id, node] of cardNodes) {
    if (!seen.has(id)) {
      node.remove();
      cardNodes.delete(id);
    }
  }

  document.getElementById("empty").hidden = worktrees.length > 0;
  const count = worktrees.length;
  const shown = ranked.length;
  setText(document.getElementById("session-count"), shown === count ? String(count) : `${shown}/${count}`);
}

// ------------------------------------------------------------------- modal

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

// Keyed by paneKey, exactly like cardNodes for the grid — a poll while the
// modal is open used to wipe modal-body and rebuild every row (and every
// <textarea>) from scratch. On an iPad that destroys the very element the
// tap just focused a moment earlier, so the on-screen keyboard that was
// opening immediately closed again (and any text already typed vanished
// with it). Reused nodes fix both.
const modalRowNodes = new Map();

function agentRowExtraText(agent) {
  if (agent.toolName) {
    const input = agent.toolInput ? String(agent.toolInput).slice(0, 80) : "";
    return input ? ` — ${agent.toolName}: ${input}` : ` — ${agent.toolName}`;
  }
  if (agent.lastAssistantMessage) return " — " + String(agent.lastAssistantMessage).slice(0, 80);
  return "";
}

function buildAgentRow() {
  const row = el("div", "agent-row");
  const logoSlot = el("span", "agent-logo-slot");
  const main = el("div", "agent-main");
  const line = el("div", "agent-line");
  const stateLine = el("div", "agent-state");
  const kw = el("span", "kw");
  const extra = el("span", "agent-extra");
  stateLine.append(kw, extra);
  const age = el("span", "agent-age");
  line.append(stateLine, age);
  const detail = el("div", "agent-detail");

  // Conversation context, so replying doesn't mean guessing what's being
  // answered — the last thing the user said and the agent's own last
  // message (which, on a needs-attention session, is usually the question
  // itself), shown in full rather than the one-line truncated preview above.
  const context = el("div", "agent-context");
  const contextYou = el("div", "agent-context-you");
  const contextReply = el("div", "agent-context-reply");
  context.append(contextYou, contextReply);

  // Live mirror of the terminal's actual rendered screen — the only place a
  // keypress-driven permission menu (no chat message, so nothing in
  // `context` above) ever shows up. Populated by refreshModalScreens(),
  // not by updateAgentRow(), since it needs its own CLI round-trip.
  const screen = el("pre", "agent-screen");
  screen.hidden = true;

  const replyBox = el("div", "reply-box");
  const textarea = document.createElement("textarea");
  textarea.placeholder = "Send to this session…";
  const button = document.createElement("button");
  button.textContent = "Send";
  const sendError = el("div", "agent-send-error");
  sendError.hidden = true;
  button.onclick = async () => {
    const text = textarea.value.trim();
    const agent = row._agent;
    if (!text || !agent || !agent.terminalHandle) return;
    button.disabled = true;
    sendError.hidden = true;
    try {
      // sendAction() only throws on 401 — orca itself can reject a send
      // (e.g. `agent_prompt_blocked`) with a 502 that still resolves here
      // as {ok:false, error}. Not checking `.ok` was the actual bug behind
      // "I sent a reply and nothing happened": the textarea cleared as if
      // it worked, and the failure reason was never shown anywhere.
      const result = await sendAction({ type: "send-text", terminalHandle: agent.terminalHandle, text, enter: true });
      if (!result || result.ok === false) {
        throw new Error((result && result.error) || "send failed");
      }
      textarea.value = "";
      // Give the terminal a beat to redraw, then pull the screen so the
      // user can see whether the reply actually landed.
      setTimeout(refreshModalScreens, 400);
    } catch (err) {
      console.error(err);
      setText(sendError, String((err && err.message) || err));
      sendError.hidden = false;
    } finally {
      button.disabled = false;
    }
  };
  replyBox.append(textarea, button, sendError);
  main.append(line, detail, context, screen, replyBox);
  row.append(logoSlot, main);

  row._logoSlot = logoSlot;
  row._stateLine = stateLine;
  row._kw = kw;
  row._extra = extra;
  row._age = age;
  row._detail = detail;
  row._context = context;
  row._contextYou = contextYou;
  row._contextReply = contextReply;
  row._screen = screen;
  row._replyBox = replyBox;
  row._button = button;
  return row;
}

function updateAgentRow(row, agent, depth) {
  row._agent = agent; // the Send button's onclick reads this, never a stale closure
  row.dataset.depth = String(Math.min(depth, 3));

  const status = agentStatus(agent);
  row._stateLine.className = "agent-state " + status;
  setText(row._kw, STATUS_LABEL[status] || agent.state || "—");
  setText(row._extra, agentRowExtraText(agent));
  setText(row._age, fmtAge(agent.updatedAt || agent.stateStartedAt));

  const label = agent.displayName || agent.taskTitle || agent.agentType;
  row._detail.hidden = !label;
  if (label) setText(row._detail, label);

  const logoSlot = row._logoSlot;
  if (logoSlot.dataset.type !== (agent.agentType || "")) {
    logoSlot.textContent = "";
    logoSlot.append(harnessLogo(agent.agentType));
    logoSlot.dataset.type = agent.agentType || "";
  }

  // Full text here, not the 80-char preview above — this is specifically
  // for reading before replying, so truncating it would defeat the point.
  const hasYou = Boolean(agent.prompt);
  const hasReply = Boolean(agent.lastAssistantMessage);
  row._contextYou.hidden = !hasYou;
  if (hasYou) setText(row._contextYou, "You: " + agent.prompt);
  row._contextReply.hidden = !hasReply;
  if (hasReply) setText(row._contextReply, agent.lastAssistantMessage);
  row._context.hidden = !hasYou && !hasReply;

  if (!agent.terminalHandle) row._screen.hidden = true;

  row._replyBox.hidden = !agent.terminalHandle;
  row._button.disabled = !agent.terminalHandle;
}

// Flattens the tree into (paneKey, agent, depth) triples, depth-first —
// same order the cards use, no row-count cap here (this is the detail view).
function flattenAgentsForModal(agents, depth, out) {
  for (const a of agents || []) {
    out.push({ key: a.paneKey, agent: a, depth });
    flattenAgentsForModal(a.children, depth + 1, out);
  }
}

async function fetchTerminalTail(handle) {
  const res = await fetch(`/v1/terminal-tail?handle=${encodeURIComponent(handle)}`, { cache: "no-store" });
  return res.json();
}

// Trims only trailing padding on each line (TUIs often pad box-drawing
// output to the full terminal width) — the content itself is left as-is,
// since it's a mirror of the real screen, not something to reformat.
function setAgentScreen(row, tailLines) {
  const text = (tailLines || []).join("\n").replace(/[ \t]+$/gm, "").trim();
  row._screen.hidden = !text;
  if (text) setText(row._screen, text);
}

// Polls each open modal row's own terminal screen — separate from the main
// /v1/state poll because it's a per-agent CLI round-trip, only worth paying
// for the handful of rows actually visible in an open modal, not every
// agent on every worktree every cycle.
let modalTailTimer = null;

async function refreshModalScreens() {
  for (const [, row] of modalRowNodes) {
    const agent = row._agent;
    if (!row.isConnected || !agent || !agent.terminalHandle) continue;
    try {
      const data = await fetchTerminalTail(agent.terminalHandle);
      if (data && data.ok) setAgentScreen(row, data.tail);
    } catch (err) {
      // best-effort — leave the last-known screen content in place
    }
  }
}

function openModal(worktreeId) {
  const doc = lastGoodDoc;
  const w = doc && (doc.worktrees || []).find((x) => x.worktreeId === worktreeId);
  if (!w) return;
  openModalId = worktreeId;
  renderModal(w);
  document.getElementById("modal").hidden = false;
  refreshModalScreens();
  if (modalTailTimer) clearInterval(modalTailTimer);
  modalTailTimer = setInterval(refreshModalScreens, POLL_MS);
}

function closeModal() {
  openModalId = null;
  document.getElementById("modal").hidden = true;
  if (modalTailTimer) {
    clearInterval(modalTailTimer);
    modalTailTimer = null;
  }
}

function renderModal(w) {
  setText(document.getElementById("modal-title"), w.displayName || w.repo || w.branch || "worktree");
  setText(document.getElementById("modal-sub"), [w.repo, w.branch].filter(Boolean).join(" · "));

  const body = document.getElementById("modal-body");
  const flat = [];
  flattenAgentsForModal(w.agents, 0, flat);

  let empty = body.querySelector(".empty-state");
  if (!flat.length) {
    if (!empty) {
      empty = el("div", "empty-state small", [document.createTextNode("No agents running here.")]);
      body.append(empty);
    }
  } else if (empty) {
    empty.remove();
  }

  const seen = new Set();
  let prevNode = null;
  for (const { key, agent, depth } of flat) {
    seen.add(key);
    let row = modalRowNodes.get(key);
    if (!row) {
      row = buildAgentRow();
      modalRowNodes.set(key, row);
    }
    updateAgentRow(row, agent, depth);
    // Only reposition when actually out of place — see the comment on the
    // identical guard in renderCards(). This is the specific fix for the
    // reply textarea losing focus (and the iPad keyboard dismissing) a
    // moment after tapping it: without the guard, every poll re-inserted
    // the row even when its order hadn't changed, which blurs whatever was
    // focused inside it.
    if (prevNode) {
      if (prevNode.nextElementSibling !== row) prevNode.after(row);
    } else if (body.firstElementChild !== row) {
      body.prepend(row);
    }
    prevNode = row;
  }

  for (const [key, row] of modalRowNodes) {
    if (!seen.has(key)) {
      row.remove();
      modalRowNodes.delete(key);
    }
  }
}

// ------------------------------------------------------------------- usage

function pctClass(pct) {
  if (pct >= 90) return "gauge-fill danger";
  if (pct >= 70) return "gauge-fill warn";
  return "gauge-fill";
}

function buildGauge(providerLabel, windowLabel, w) {
  const pct = Math.max(0, Math.min(100, Number(w.usedPercent) || 0));
  const wrap = el("div", "gauge");
  const head = el("div", "gauge-head");
  const name = el("span", "gauge-name");
  name.textContent = `${providerLabel} · ${windowLabel}`;
  const val = el("span", "gauge-pct");
  val.textContent = `${Math.round(pct)}%`;
  head.append(name, val);
  const track = el("div", "gauge-track");
  const fill = el("div", pctClass(pct));
  fill.style.width = pct + "%";
  track.append(fill);
  const foot = el("div", "gauge-foot");
  foot.textContent = w.resetDescription ? `resets ${w.resetDescription}` : "";
  wrap.append(head, track, foot);
  return wrap;
}

const WINDOW_LABELS = { session: "session", weekly: "weekly", monthly: "monthly" };

// ------------------------------------------------------------------- mascot

// Same priority-ladder idea as Clawdeck's crab mood (sidecrab.js): each state
// only matters if nothing higher in the list already answered. Connection
// trouble outranks everything — a mascot reacting to session state it can no
// longer see would be the panel claiming a live opinion about a dead feed.
function computeMood(doc) {
  // Never successfully polled yet (first load) reads as asleep, matching the
  // crab's own "connecting -> asleep"; anything gone wrong AFTER data has
  // loaded at least once reads as attn (its "stale -> worried").
  if (doc.error) return doc.generatedAt === null ? "idle" : "attn";
  let working = 0;
  let attn = 0;
  let total = 0;
  for (const w of doc.worktrees || []) {
    const r = rollup(w);
    total += r.agentCount;
    if (r.band === 0) attn++;
    else if (r.band === 1 || r.band === 2) working++;
  }
  if (attn > 0) return "attn";
  if (working > 0) return "working";
  if (total === 0) return "idle";
  return "done";
}

// Per-worktree band, remembered across polls. The Done hop is a one-shot
// EVENT — "that session just finished" — while the mood above is a continuous
// aggregate over the whole deck. Deriving the event from the aggregate (the
// old `prevMood === "working" && mood === "done"`) meant a single session
// needing attention anywhere suppressed every celebration on the deck; with
// monitoring miscounted as attention, that suppression was permanent and the
// animation could never fire at all. They are separate signals now.
const prevBandByWorktree = new Map();

// Band 4 (done) only: band 3 is interrupted, and a run a human killed with
// Ctrl+C is not an accomplishment to hop about. A worktree with no remembered
// band is one this panel never watched change — first poll, or a session that
// showed up already finished — and neither is a transition, so neither hops.
function consumeFinishedWorktrees(worktrees) {
  let finished = false;
  const seen = new Set();
  for (const w of worktrees || []) {
    const id = w.worktreeId;
    if (!id) continue;
    seen.add(id);
    const band = rollup(w).band;
    const prev = prevBandByWorktree.get(id);
    if (prev !== undefined && prev <= 2 && band === 4) finished = true;
    prevBandByWorktree.set(id, band);
  }
  for (const id of Array.from(prevBandByWorktree.keys())) {
    if (!seen.has(id)) prevBandByWorktree.delete(id);
  }
  return finished;
}

// Shared between the real hero mascot and every ?mock=puppy preview (which
// clones the whole .mascot-wrap) — scoped by class/data-role rather than id,
// since clones must not carry duplicate ids.
function populateOrcaChat(root) {
  const slot = root.querySelector(".orca-chat");
  if (slot && !slot.firstChild) slot.append(chatIcon());
}

function setMascotMood(root, mood) {
  const front = root.querySelector(".orca-front");
  if (front && front.dataset.mood !== mood) front.dataset.mood = mood;
  if (root.dataset.mood !== mood) root.dataset.mood = mood;
  populateOrcaChat(root);
}

// The one-shot hop + splash. Both live on a timer rather than an
// animationend listener so a second trigger mid-flight cleanly restarts
// rather than leaving stale classes — which is no longer rare now that any
// session finishing fires it, not just the last one on the whole deck.
function triggerMascotBounce(root) {
  const front = root.querySelector(".orca-front");
  root.classList.add("bounce");
  if (front) front.classList.add("bounce");
  setTimeout(() => {
    root.classList.remove("bounce");
    if (front) front.classList.remove("bounce");
  }, 800);
}

function updateMascot(doc) {
  const wrap = document.getElementById("mascot-wrap");
  const mood = computeMood(doc);

  // The hop rides on top of whatever mood is showing; it does not wait for
  // the mascot to land on Done. A session finishing while three others still
  // need attention is still a session finishing — it hops once and settles
  // straight back into the worried pose. Skipped entirely while the feed is
  // erroring: those worktrees are the last good snapshot, not news.
  if (!doc.error && consumeFinishedWorktrees(doc.worktrees)) triggerMascotBounce(wrap);

  setMascotMood(wrap, mood);

  // The mascot itself is fixed white now — this is where the aggregate mood's
  // colour and icon actually live, right beside the clock.
  const heroState = document.getElementById("hero-state");
  const MOOD_LABEL = { working: "Working", attn: "Needs attention", done: "Done" };
  heroState.className = mood;
  heroState.textContent = "";
  if (MOOD_LABEL[mood]) {
    const label = document.createElement("span");
    label.textContent = MOOD_LABEL[mood];
    heroState.append(stateIconNode(mood), label);
  }
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function tickClock() {
  const now = new Date();
  setText(document.getElementById("clock-hm"), pad2(now.getHours()) + ":" + pad2(now.getMinutes()));
  setText(document.getElementById("clock-ss"), pad2(now.getSeconds()));
  let dateStr;
  try {
    dateStr = now.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" });
  } catch (err) {
    dateStr = now.toDateString();
  }
  setText(document.getElementById("clock-date"), dateStr);
}

function renderUsage(rateLimits) {
  const list = document.getElementById("usage-list");
  const empty = document.getElementById("usage-empty");
  list.textContent = "";
  const providers = rateLimits || [];
  empty.hidden = providers.length > 0;
  for (const p of providers) {
    for (const key of ["session", "weekly", "monthly"]) {
      const w = p.windows && p.windows[key];
      if (w) list.append(buildGauge(p.label, WINDOW_LABELS[key], w));
    }
  }
}

// ------------------------------------------------------------------- poll

function render(doc) {
  const status = document.getElementById("hero-status");
  const banner = document.getElementById("token-banner");

  if (doc.error) {
    status.textContent = doc.stale ? "stale — " + doc.error : doc.error;
    status.className = doc.stale ? "stale" : "dead";
  } else {
    status.textContent = "live";
    status.className = "";
  }
  banner.hidden = true;

  lastGoodDoc = doc;
  renderCards(doc.worktrees || []);
  renderUsage(doc.rateLimits || []);
  updateMascot(doc);

  if (openModalId) {
    const w = (doc.worktrees || []).find((x) => x.worktreeId === openModalId);
    if (w) renderModal(w);
    else closeModal();
  }
}

async function poll() {
  const status = document.getElementById("hero-status");
  let doc;
  try {
    const res = await fetch("/v1/state", { cache: "no-store" });
    doc = await res.json();
  } catch (err) {
    // A genuine network/parse failure — orcad is actually unreachable.
    status.textContent = "unreachable";
    status.className = "dead";
    return;
  }
  try {
    render(doc);
  } catch (err) {
    // Not a connectivity problem — the fetch above succeeded. Reported
    // distinctly so a rendering bug is never mistaken for orcad being down.
    console.error("orcaDeck render failed:", err);
    status.textContent = "render error — see console";
    status.className = "dead";
  }
}

function wireControls() {
  document.getElementById("filter-chip").addEventListener("click", (ev) => {
    const idx = FILTER_MODES.indexOf(filterMode);
    filterMode = FILTER_MODES[(idx + 1) % FILTER_MODES.length];
    ev.target.textContent = FILTER_LABELS[filterMode];
    ev.target.dataset.filter = filterMode;
    if (lastGoodDoc) renderCards(lastGoodDoc.worktrees || []);
  });

  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-backdrop").addEventListener("click", closeModal);
}

// ------------------------------------------------------------- ?mock=puppy

// A static showcase of every mascot mood, mirroring Clawdeck's own ?mock=
// convention for inspecting its crab. Swaps in for the live dashboard
// entirely — no /v1/state poll, no clock — the content in index.html
// explains each mood's trigger/duration; this just wires up the live
// mascot clones and the one-shot bounce demo button.
function initPuppyMock() {
  document.getElementById("hero").hidden = true;
  document.getElementById("app").hidden = true;
  document.getElementById("mock-puppy").hidden = false;

  // The static placeholder spans in the markup (.icon-chat/.icon-check) have
  // no content of their own — they're SVG-only classes. Swap in the real,
  // same-code-path icon nodes rather than hand-duplicating the paths here.
  document.querySelectorAll("h2 > .icon-chat").forEach((el) => el.replaceWith(chatIcon()));
  document.querySelectorAll("h2 > .icon-check").forEach((el) => el.replaceWith(checkIcon()));

  // Clone the WHOLE wrap (front + side + chat decoration + splash), not just
  // the front SVG — otherwise the Working preview would have no side-view to
  // show and the Needs-attention preview no chat bubble to pop up. Every id
  // inside must be stripped: several previews exist at once, and ids must be
  // unique per document.
  const realWrap = document.getElementById("mascot-wrap");
  document.querySelectorAll(".mock-mood-preview[data-mood]").forEach((slot) => {
    const clone = realWrap.cloneNode(true);
    clone.removeAttribute("id");
    clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    setMascotMood(clone, slot.dataset.mood);
    slot.appendChild(clone);
    if ("bounceTarget" in slot.dataset) {
      const btn = document.getElementById("mock-bounce-btn");
      btn.addEventListener("click", () => triggerMascotBounce(clone));
    }
  });
}

// ------------------------------------------------------------- ?mock=panel

// A fabricated /v1/state document for screenshots (the README, mainly) —
// real data would mean a real repo/branch/session name in a public image.
// Every field here is fictional; only the SHAPE matches what orcad actually
// serves. Renders through the exact same render() as live data, no special
// cases, so a screenshot of this is honestly what the panel looks like.
function fakePanelDoc() {
  const now = Date.now();
  const ago = (ms) => now - ms;
  const agent = (overrides) =>
    Object.assign(
      {
        paneKey: Math.random().toString(36).slice(2),
        parentPaneKey: null,
        agentType: "claude",
        state: "done",
        workingMode: null,
        interrupted: false,
        displayName: null,
        taskTitle: null,
        prompt: null,
        lastAssistantMessage: null,
        toolName: null,
        toolInput: null,
        stateStartedAt: ago(60000),
        updatedAt: ago(30000),
        terminalHandle: "term_mock",
        connected: true,
        writable: true,
        children: [],
      },
      overrides
    );
  const wt = (overrides) =>
    Object.assign(
      {
        worktreeId: Math.random().toString(36).slice(2),
        repo: "repo",
        displayName: "session",
        branch: "refs/heads/main",
        path: "/repo",
        status: "active",
        isMainWorktree: false,
        lastActivityAt: ago(120000),
        lastOutputAt: ago(60000),
        agents: [],
      },
      overrides
    );

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    error: null,
    stale: false,
    rateLimits: [
      { provider: "claude", label: "Claude", windows: { session: { usedPercent: 34, resetDescription: "9:10 PM" }, weekly: { usedPercent: 21, resetDescription: "Fri 1:00 AM" } } },
      { provider: "opencodeGo", label: "OpenCode", windows: { session: { usedPercent: 12, resetDescription: "11:45 PM" } } },
    ],
    worktrees: [
      wt({
        repo: "api-gateway", displayName: "Rate limit bug", branch: "refs/heads/fix/rate-limit-bug",
        agents: [agent({ state: "waiting", prompt: "any update?", lastAssistantMessage: "Found it — the retry loop doesn't back off. Want me to add jittered backoff or just cap the retries?", stateStartedAt: ago(90000), updatedAt: ago(20000) })],
      }),
      wt({
        repo: "checkout-flow", displayName: "Add Apple Pay", branch: "refs/heads/feat/apple-pay",
        agents: [agent({ state: "working", toolName: "Bash", toolInput: "npm test -- checkout", stateStartedAt: ago(45000), updatedAt: ago(3000) })],
      }),
      wt({
        repo: "docs-site", displayName: "Rewrite quickstart", branch: "refs/heads/docs/quickstart",
        agents: [agent({ state: "working", workingMode: "monitoring", agentType: "opencode", toolName: "Bash", toolInput: "mkdocs serve", updatedAt: ago(8000) })],
      }),
      wt({
        repo: "billing-service", displayName: "Fix invoice rounding", branch: "refs/heads/fix/invoice-rounding",
        lastActivityAt: ago(3600000), lastOutputAt: ago(3600000),
        agents: [agent({ state: "done", toolName: "Bash", toolInput: "pytest tests/billing -q", updatedAt: ago(3600000) })],
      }),
      wt({
        repo: "onboarding-redesign", displayName: "Wizard step 3", branch: "refs/heads/feat/wizard-step-3",
        lastActivityAt: ago(5400000), lastOutputAt: ago(5400000),
        agents: [
          agent({
            state: "done", lastAssistantMessage: "Dispatched two subagents — one for the form validation, one for the tests. Both finished clean.",
            updatedAt: ago(5400000),
            children: [
              agent({ state: "done", agentType: "opencode", toolName: "Edit", toolInput: "src/wizard/Step3.tsx", updatedAt: ago(5450000) }),
              agent({ state: "done", toolName: "Bash", toolInput: "npm test -- wizard", updatedAt: ago(5500000) }),
            ],
          }),
        ],
      }),
      wt({ repo: "mobile-app", displayName: "main", branch: "refs/heads/main", isMainWorktree: true, status: "inactive", lastActivityAt: ago(9 * 3600000), lastOutputAt: ago(9 * 3600000), agents: [] }),
      wt({ repo: "internal-tools", displayName: "main", branch: "refs/heads/main", isMainWorktree: true, status: "inactive", lastActivityAt: ago(26 * 3600000), lastOutputAt: ago(26 * 3600000), agents: [] }),
    ],
  };
}

function initPanelMock() {
  render(fakePanelDoc());
  tickClock();
  setInterval(tickClock, 1000);
}

// --------------------------------------------------------------------- boot

// The only code in this file that touches the document at load time. Keeping
// it behind a `document` check is what lets tests/panel_status.test.js
// require this file in plain node and exercise the status ladder directly —
// no build step, and no second copy of the rules to drift out of sync with
// the one the panel actually runs.
function boot() {
  TOKEN = getToken();
  wireControls();

  const mockMode = new URLSearchParams(window.location.search).get("mock");
  if (mockMode === "puppy") {
    initPuppyMock();
  } else if (mockMode === "panel") {
    initPanelMock();
  } else {
    poll();
    setInterval(poll, POLL_MS);

    // The clock ticks at 1 Hz on its own, independent of the 2s data poll — a
    // clock that only moved when orcad answered would stutter and lag behind
    // real time, same reasoning as Clawdeck's own 1 Hz tick() (sidecrab.js).
    tickClock();
    setInterval(tickClock, 1000);
  }
}

if (typeof document !== "undefined") boot();

// `module` exists under node and nowhere in a browser, so this is inert when
// index.html loads the file as a plain <script>.
if (typeof module !== "undefined") {
  module.exports = {
    STALE_AFTER_MS,
    STATUS_RANK,
    STATUS_LABEL,
    agentStatus,
    rollup,
    matchesFilter,
    computeMood,
    consumeFinishedWorktrees,
    prevBandByWorktree,
  };
}
