import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeThrash,
  renderThrashStep,
  THRASH_HEADLINE_MIN,
  THRASH_SEQUENCE_CAP,
} from "../../dist/trace/thrash.js";

// The layout-thrashing detector as a pure function over a fixture event log (no browser). The event
// shapes mirror what a Chrome --deep trace parses to: invalidation-kind writes with a reason + a
// resolved `.at`, and forced layout/style flushes with a resolved read-site `.at`. All events sit on
// one RunTask; without pid/tid the detector treats every event as main-thread.

let nextId = 0;
function ev(fields) {
  return {
    id: nextId++,
    name: fields.name ?? "?",
    ts: fields.ts,
    dur: fields.dur ?? 0,
    ph: "X",
    kind: fields.kind,
    forced: fields.forced,
    at: fields.at,
    args: fields.reason != null ? { data: { reason: fields.reason } } : undefined,
  };
}
const task = (ts, dur) => ev({ name: "RunTask", kind: "task", ts, dur });
const styleWrite = (ts, at, reason) =>
  ev({ name: "StyleRecalcInvalidationTracking", kind: "invalidation", ts, at, reason });
const layoutWrite = (ts, at, reason) =>
  ev({ name: "LayoutInvalidationTracking", kind: "invalidation", ts, at, reason });
const styleFlush = (ts, at) => ev({ name: "UpdateLayoutTree", kind: "style", ts, forced: true, at });
const layoutFlush = (ts, at) => ev({ name: "Layout", kind: "layout", ts, forced: true, at });

test("detects a write->read thrash step and names the dirtied-by write", () => {
  nextId = 0;
  const events = [
    task(0, 1000),
    styleWrite(10, "app.js:10", "Inline CSS style declaration was mutated"),
    styleFlush(20, "app.js:20"),
  ];
  const { report, dirtiedByReadSite } = analyzeThrash(events, 0);
  assert.equal(report.count, 1);
  assert.equal(report.steps[0].kind, "style");
  assert.equal(report.steps[0].read, "app.js:20");
  assert.deepEqual(report.steps[0].dirtiedBy, [
    { at: "app.js:10", reason: "Inline CSS style declaration was mutated" },
  ]);
  // The dual annotation is also keyed by read-site, for the blame rollup.
  assert.deepEqual(dirtiedByReadSite["app.js:20"], [
    { at: "app.js:10", reason: "Inline CSS style declaration was mutated" },
  ]);
});

// The judgment: the rule matches by KIND (a layout flush needs a layout write, a style flush a
// style write). This is what makes the probe's focus() Layout re-read -- whose gap holds only a
// :focus-recalc STYLE write, no layout write -- a genuine non-thrash. The looser "any layout|style
// write" rule would count it (43/43 vs 42/43 on the probe) and over-report a clean re-read.
test("matches by kind: a :focus-style write before a LAYOUT flush is not a layout-thrash", () => {
  nextId = 0;
  const events = [task(0, 1000), styleWrite(10, "app.js:10", "PseudoClass"), layoutFlush(20, "app.js:20")];
  assert.equal(analyzeThrash(events, 0).report.count, 0);
});

test("a forced flush with no write in its gap is not a thrash step", () => {
  nextId = 0;
  const events = [task(0, 1000), styleFlush(20, "app.js:20")];
  const { report, dirtiedByReadSite } = analyzeThrash(events, 0);
  assert.equal(report.count, 0);
  assert.deepEqual(dirtiedByReadSite, {});
});

// A layout write DOES thrash a layout flush; but the layout-kind record's stack names the forcing
// READ, not the write, so it is never surfaced as a dirtied-by (dirtied-by comes from style-kind
// mutation records only). The step is real; its dirtiedBy is empty.
test("a layout write thrashes a layout flush, with an empty dirtied-by", () => {
  nextId = 0;
  const events = [
    task(0, 1000),
    layoutWrite(10, "app.js:99", "Added to layout"),
    layoutFlush(20, "app.js:20"),
  ];
  const { report } = analyzeThrash(events, 0);
  assert.equal(report.count, 1);
  assert.equal(report.steps[0].kind, "layout");
  assert.deepEqual(report.steps[0].dirtiedBy, []);
});

test('a removeChild detach ("Removed from layout") names the write from the layout record', () => {
  nextId = 0;
  const events = [
    task(0, 1000),
    layoutWrite(10, "app.js:7", "Removed from layout"),
    layoutFlush(20, "app.js:20"),
  ];
  const { report } = analyzeThrash(events, 0);
  assert.equal(report.count, 1);
  assert.deepEqual(report.steps[0].dirtiedBy, [{ at: "app.js:7", reason: "Removed from layout" }]);
});

// The classic style->layout thrash the probe produces: one write, then BOTH a forced style recalc
// and a forced layout, both read at the same line. Both count; the read-site's dirtied-by rolls up
// to the one genuine write, ignoring the layout record that names the read.
test("style->layout thrash: both flushes count, dirtied-by rolls up per read-site", () => {
  nextId = 0;
  const events = [
    task(0, 1000),
    styleWrite(10, "app.js:10", "Inline CSS style declaration was mutated"),
    styleFlush(20, "app.js:20"),
    layoutWrite(25, "app.js:20", "Style changed"),
    layoutFlush(30, "app.js:20"),
  ];
  const { report, dirtiedByReadSite } = analyzeThrash(events, 0);
  assert.equal(report.count, 2);
  assert.deepEqual(dirtiedByReadSite["app.js:20"], [
    { at: "app.js:10", reason: "Inline CSS style declaration was mutated" },
  ]);
});

test("the gap resets at each flush: a write consumed by one flush does not thrash the next", () => {
  nextId = 0;
  const events = [
    task(0, 1000),
    styleWrite(10, "app.js:10", "x"),
    styleFlush(20, "app.js:20"),
    styleFlush(30, "app.js:30"),
  ];
  assert.equal(analyzeThrash(events, 0).report.count, 1);
});

// The enclosing RunTask begins just before the run:start mark (measured on the real probe), so the
// detector must see the full stream: a pre-window write in the same task still dirties an in-window
// flush, while a flush BEFORE the window start is not reported.
test("windowing: a pre-window write counts, a pre-window flush does not", () => {
  nextId = 0;
  const inWindowFlush = [
    task(-5, 1000),
    styleWrite(-2, "app.js:10", "x"),
    styleFlush(20, "app.js:20"),
  ];
  assert.equal(
    analyzeThrash(inWindowFlush, 0).report.count,
    1,
    "a pre-window write in the same task still dirties the in-window flush",
  );

  nextId = 0;
  const preWindowFlush = [
    task(-5, 1000),
    styleWrite(-4, "app.js:10", "x"),
    styleFlush(-3, "app.js:20"),
    styleFlush(20, "app.js:21"),
  ];
  assert.equal(
    analyzeThrash(preWindowFlush, 0).report.count,
    0,
    "the pre-window flush is not reported and it consumed the only write",
  );
});

test("sequence rendering caps distinct writes per step at 4 with +N more", () => {
  const dirtiedBy = ["w1", "w2", "w3", "w4", "w5", "w6"].map((at) => ({ at, reason: null }));
  const rendered = renderThrashStep({ kind: "style", read: "r", dirtiedBy });
  assert.equal(rendered, "write w1, w2, w3, w4, +2 more → read r (style)");
});

test("sequence rendering: write(reasoned) → read, and read-only for an empty write", () => {
  assert.equal(
    renderThrashStep({
      kind: "style",
      read: "app.js:20",
      dirtiedBy: [{ at: "app.js:10", reason: "Inline CSS style declaration was mutated" }],
    }),
    "write app.js:10 (Inline CSS style declaration was mutated) → read app.js:20 (style)",
  );
  assert.equal(
    renderThrashStep({ kind: "layout", read: "app.js:20", dirtiedBy: [] }),
    "read app.js:20 (layout)",
  );
  assert.equal(
    renderThrashStep({ kind: "style", read: "r", dirtiedBy: [{ at: "w1" }, { at: "w2", reason: "z" }] }),
    "write w1, w2 (z) → read r (style)",
  );
});

test("cap behavior: steps are capped and `omitted` counts the rest", () => {
  const build = (count) => {
    nextId = 0;
    const events = [task(0, 100000)];
    let ts = 10;
    for (let step = 0; step < count; step++) {
      events.push(styleWrite(ts++, `w:${step}`, "x"));
      events.push(styleFlush(ts++, `r:${step}`));
    }
    return events;
  };
  const capped = analyzeThrash(build(5), 0, 2).report;
  assert.equal(capped.count, 5, "count is the true total, not the capped length");
  assert.equal(capped.steps.length, 2);
  assert.equal(capped.omitted, 3);

  // The default cap keeps THRASH_SEQUENCE_CAP steps and omits the rest.
  const many = analyzeThrash(build(THRASH_SEQUENCE_CAP + 4), 0).report;
  assert.equal(many.steps.length, THRASH_SEQUENCE_CAP);
  assert.equal(many.omitted, 4);
});

test("the headline threshold N is a named constant", () => {
  assert.equal(THRASH_HEADLINE_MIN, 3);
});

// No invalidation records at all (a lane that cannot observe them, e.g. Firefox / --breakdown):
// the detector reads empty, never a fabricated thrash.
test("no invalidation records yields an empty, not-available result", () => {
  nextId = 0;
  const events = [task(0, 1000), styleFlush(10, "app.js:10"), layoutFlush(20, "app.js:10")];
  const { report, dirtiedByReadSite } = analyzeThrash(events, 0);
  assert.equal(report.count, 0);
  assert.deepEqual(report.steps, []);
  assert.deepEqual(dirtiedByReadSite, {});
});
