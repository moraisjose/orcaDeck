// The panel's compatibility baseline, enforced rather than just documented.
//
// README: "built to run on legacy WebKit too, all the way back to iOS 10
// Safari — that old tablet in a drawer can be a dashboard again." That is a
// headline feature, and it breaks silently: legacy WebKit does not throw on a
// construct it doesn't know, it drops the declaration or never fires the
// event. Nothing appears in a console anyone is reading, and the panel on the
// desk keeps working, so the break is only ever found by someone standing in
// front of the old iPad.
//
// It has been found that way twice. The mascot's petting shipped on
// `pointerdown` (Safari 13+) and with `var()` inside @keyframes (Safari 16+),
// so on an iOS 12 iPad touching it did nothing whatsoever; and the Done
// splash has been mispositioned since the first release because it used
// `inset: 0` (Safari 14.1+) — a trap the modal CSS already had a comment
// warning about. Comments did not hold the line, so this does.
//
// Run with: node --test "tests/*.test.js"
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PANEL = path.join(__dirname, "..", "panel");
const css = fs.readFileSync(path.join(PANEL, "styles.css"), "utf8");
const js = fs.readFileSync(path.join(PANEL, "panel.js"), "utf8");

const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

// Lines that are wholly a comment are excluded, so a rule can still be
// *described* in prose without tripping its own guard.
function codeLines(source, lineComment) {
  return source
    .split("\n")
    .map((line, i) => ({ n: i + 1, text: line }))
    .filter(({ text }) => {
      const t = text.trim();
      if (lineComment && t.startsWith("//")) return false;
      return !t.startsWith("*") && !t.startsWith("/*");
    });
}

function keyframeBlocks(source) {
  const out = [];
  const re = /@keyframes\s+[\w-]+\s*\{/g;
  let m;
  while ((m = re.exec(source))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) break;
    }
    out.push({ name: m[0], body: source.slice(start, i) });
  }
  return out;
}

test("no custom properties inside @keyframes (Safari 16+)", () => {
  // Legacy WebKit drops the entire keyframe rather than the one declaration,
  // so an animation written this way does nothing at all.
  const blocks = keyframeBlocks(stripCssComments(css));
  assert.ok(blocks.length > 0, "expected to find some @keyframes to check");
  const offenders = blocks.filter((b) => b.body.includes("var(")).map((b) => b.name);
  assert.deepEqual(offenders, [], `var() inside @keyframes: ${offenders.join(", ")}`);
});

test("no `inset` shorthand (Safari 14.1+)", () => {
  const bad = codeLines(stripCssComments(css), false).filter(({ text }) => /(^|[;{\s])inset\s*:/.test(text));
  assert.deepEqual(bad.map((l) => l.n), [], "use top/right/bottom/left longhands");
});

test("no :is() or :where() (Safari 14+)", () => {
  const bad = codeLines(stripCssComments(css), false).filter(({ text }) => /:(is|where)\(/.test(text));
  assert.deepEqual(bad.map((l) => l.n), []);
});

test("flexbox gap keeps its @supports fallback", () => {
  // gap in flexbox is Safari 14.1+. The fallback block is what keeps the
  // layout from collapsing on everything older.
  assert.ok(css.includes("@supports not (gap: 1px)"), "the gap fallback block is gone");
});

test("pointer events are feature-detected, never assumed (Safari 13+)", () => {
  const uses = codeLines(js, true).filter(({ text }) => /["']pointer(down|up|move|cancel)["']/.test(text));
  if (uses.length) {
    assert.ok(
      /window\.PointerEvent/.test(js),
      "pointer events are used with no `window.PointerEvent` guard and no fallback path"
    );
    assert.ok(/["']touchstart["']/.test(js), "no touchstart fallback for engines without Pointer Events");
  }
});

test("no optional chaining or nullish coalescing (Safari 13.1+)", () => {
  // These are syntax errors on older engines, which takes the WHOLE script
  // down — not just the feature that used them.
  const bad = codeLines(js, true).filter(({ text }) => /\?\.[a-zA-Z_[(]/.test(text) || /\?\?/.test(text));
  assert.deepEqual(bad.map((l) => l.n), []);
});

test("no JS newer than the baseline", () => {
  const banned = [
    ["flatMap(", "Safari 12"],
    ["Object.fromEntries", "Safari 12.1"],
    ["replaceAll(", "Safari 13.1"],
    ["globalThis", "Safari 12.1"],
    ["structuredClone", "Safari 15.4"],
    ["getAnimations(", "Safari 13.1"],
    ["ResizeObserver", "Safari 13.1"],
  ];
  const lines = codeLines(js, true);
  const offenders = [];
  for (const [token, since] of banned) {
    for (const { n, text } of lines) {
      if (text.includes(token)) offenders.push(`${token} (${since}) on line ${n}`);
    }
  }
  assert.deepEqual(offenders, []);
});
