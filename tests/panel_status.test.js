// The panel's status ladder, which is where "the Done animation never plays"
// actually lived: `workingMode: "monitoring"` was read as "needs attention",
// so any session with a background task pinned the whole deck in attention —
// and the mascot's hop was gated on nothing needing attention anywhere.
//
// Run with: node --test "tests/*.test.js"
//
// Every expectation here is checked against Orca's own bundled source rather
// than against how the panel happens to behave:
//   agent-status-types.js        the four states a hook can report
//   claude-roster-state.js       what mints workingMode "monitoring"
//   claude-events.js             what sets interrupted (a human's Ctrl+C)
//   agent-status-freshness.js    AGENT_STATUS_STALE_AFTER_MS
//   worktree-status.js           permission > working > monitoring >
//                                interrupted > done
const test = require("node:test");
const assert = require("node:assert");
const panel = require("../panel/panel.js");

// Real wall-clock, because rollup()/consumeFinishedWorktrees() read
// Date.now() themselves — a frozen base would make every fixture look
// decades stale and decay to "unverifiable". agentStatus() still gets an
// explicit `now` so the staleness boundary itself is checked exactly.
const NOW = Date.now();
const FRESH = NOW - 1000;
const STALE = NOW - 40 * 60 * 1000;

const agent = (o) => Object.assign({ updatedAt: FRESH, children: [] }, o);
const worktree = (id, agents) => ({ worktreeId: id, agents });

const status = (o) => panel.agentStatus(agent(o), NOW);

test("needs attention is exactly Orca's permission: blocked or waiting", () => {
  assert.equal(status({ state: "blocked" }), "permission");
  assert.equal(status({ state: "waiting" }), "permission");
});

test("monitoring is a busy state, not an attention state", () => {
  // Orca mints this only once the lead turn is already done AND a background
  // shell task or session cron is still running. Its own label for it is
  // "Monitoring background tasks".
  assert.equal(status({ state: "working", workingMode: "monitoring" }), "monitoring");
  assert.equal(status({ state: "working" }), "working");
  assert.ok(panel.STATUS_RANK.monitoring > panel.STATUS_RANK.working);
  assert.ok(panel.STATUS_RANK.monitoring > panel.STATUS_RANK.permission);
});

test("interrupted is a human's Ctrl+C, ranked below monitoring", () => {
  assert.equal(status({ state: "done", interrupted: true }), "interrupted");
  assert.ok(panel.STATUS_RANK.interrupted > panel.STATUS_RANK.monitoring);
  assert.ok(panel.STATUS_RANK.interrupted < panel.STATUS_RANK.done);
});

test("non-done statuses decay after 30 minutes; done never does", () => {
  assert.equal(panel.STALE_AFTER_MS, 30 * 60 * 1000);
  assert.equal(status({ state: "working", updatedAt: STALE }), "unverifiable");
  assert.equal(status({ state: "waiting", updatedAt: STALE }), "unverifiable");
  assert.equal(status({ state: "working", workingMode: "monitoring", updatedAt: STALE }), "unverifiable");
  assert.equal(status({ state: "done", updatedAt: STALE }), "done");
});

test("a worktree's band is the best rank any of its agents holds", () => {
  const band = (agents) => panel.rollup(worktree("w", agents)).band;
  assert.equal(band([agent({ state: "waiting" })]), panel.STATUS_RANK.permission);
  assert.equal(
    band([agent({ state: "working", workingMode: "monitoring" }), agent({ state: "working" })]),
    panel.STATUS_RANK.working
  );
  assert.equal(band([agent({ state: "working", workingMode: "monitoring" })]), panel.STATUS_RANK.monitoring);
  assert.equal(band([agent({ state: "done" })]), panel.STATUS_RANK.done);
  assert.equal(band([]), panel.STATUS_RANK.idle);
});

test("every band is reachable behind some filter chip", () => {
  for (let band = 0; band <= panel.STATUS_RANK.idle; band++) {
    assert.ok(
      ["all", "working", "attention", "done"].some((mode) => panel.matchesFilter(band, mode)),
      `band ${band} is hidden by every chip`
    );
  }
});

test("a session finishing hops even while another still needs attention", () => {
  // The regression this file exists for: the hop is a per-worktree event, not
  // a property of the deck-wide mood.
  const working = [agent({ state: "working" })];
  const done = [agent({ state: "done" })];
  const blocked = [agent({ state: "waiting" })];

  panel.prevBandByWorktree.clear();
  panel.consumeFinishedWorktrees([worktree("a", working), worktree("b", blocked)]);
  assert.equal(panel.consumeFinishedWorktrees([worktree("a", done), worktree("b", blocked)]), true);
  assert.equal(panel.computeMood({ worktrees: [worktree("a", done), worktree("b", blocked)] }), "attn");
});

test("the hop fires once per finish, and never on first sight", () => {
  const working = [agent({ state: "working" })];
  const done = [agent({ state: "done" })];

  panel.prevBandByWorktree.clear();
  assert.equal(panel.consumeFinishedWorktrees([worktree("a", done)]), false, "first poll is not a transition");

  panel.prevBandByWorktree.clear();
  panel.consumeFinishedWorktrees([worktree("a", working)]);
  assert.equal(panel.consumeFinishedWorktrees([worktree("a", done)]), true);
  assert.equal(panel.consumeFinishedWorktrees([worktree("a", done)]), false, "no repeat while it stays done");
});

test("a run someone killed with Ctrl+C is not a finish", () => {
  panel.prevBandByWorktree.clear();
  panel.consumeFinishedWorktrees([worktree("a", [agent({ state: "working" })])]);
  assert.equal(
    panel.consumeFinishedWorktrees([worktree("a", [agent({ state: "done", interrupted: true })])]),
    false
  );
});

test("worktrees that disappear stop being remembered", () => {
  panel.prevBandByWorktree.clear();
  panel.consumeFinishedWorktrees([worktree("a", [agent({ state: "working" })])]);
  panel.consumeFinishedWorktrees([worktree("b", [agent({ state: "working" })])]);
  assert.equal(panel.prevBandByWorktree.has("a"), false);
});

test("a deck whose only busy session is monitoring is not in attention", () => {
  const mood = panel.computeMood({
    worktrees: [worktree("a", [agent({ state: "working", workingMode: "monitoring" })])],
  });
  assert.equal(mood, "working");
});

// ---------------------------------------------------------------- petting

// The only pure logic in the petting reaction: which way to lean. Everything
// else it does is a CSS class the browser animates.
test("the mascot leans toward the side that was touched", () => {
  const root = { getBoundingClientRect: () => ({ left: 100, width: 80 }) };
  assert.equal(panel.petDirection(root, { clientX: 110 }), -1, "left half leans left");
  assert.equal(panel.petDirection(root, { clientX: 170 }), 1, "right half leans right");
  assert.equal(panel.petDirection(root, { clientX: 140 }), 1, "dead centre resolves right");
});

test("a pet with no coordinates still picks a direction", () => {
  // The mock page's button and any synthesised click arrive without clientX;
  // a NaN here would silently break the whole animation via calc().
  const root = { getBoundingClientRect: () => ({ left: 100, width: 80 }) };
  assert.equal(panel.petDirection(root, null), 1);
  assert.equal(panel.petDirection(root, {}), 1);
  assert.equal(panel.petDirection({ getBoundingClientRect: () => ({ left: 0, width: 0 }) }, { clientX: 5 }), 1);
});
