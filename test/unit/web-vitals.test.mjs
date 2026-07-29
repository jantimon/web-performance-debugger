import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLayoutShift,
  LAYOUT_SHIFT_SOURCE_CAP,
} from "../../dist/browser/driver.js";
import { mergeLcp } from "../../dist/trace/steps.js";

// --- CLS: the spec session-window maximum (computeLayoutShift, pure) ---

// One layout-shift entry; a single source with a fabricated rect move so attribution has something to
// rank. Timestamps are fabricated to exercise the session-window boundaries directly.
const shift = (value, startTimeMs, opts = {}) => ({
  value,
  hadRecentInput: opts.hadRecentInput ?? false,
  startTimeMs,
  sources: opts.sources ?? [
    {
      tag: "DIV",
      id: opts.id ?? "",
      className: opts.className ?? "",
      previousRect: { x: 0, y: 0, width: 100, height: 100 },
      currentRect: { x: 0, y: 100, width: 100, height: 100 },
    },
  ],
});

test("CLS is null when nothing shifted, or every shift had recent input", () => {
  assert.equal(computeLayoutShift([]), null);
  assert.equal(
    computeLayoutShift([shift(0.3, 100, { hadRecentInput: true })]),
    null,
    "a shift within 500ms of a user input is excluded, so it cannot be the CLS",
  );
  assert.equal(computeLayoutShift([shift(0, 100)]), null, "a zero-value shift is not a shift");
});

test("CLS sums a session window (shifts within the gap/window caps)", () => {
  const layoutShift = computeLayoutShift([shift(0.1, 100), shift(0.15, 200)]);
  assert.ok(layoutShift);
  assert.ok(Math.abs(layoutShift.cls - 0.25) < 1e-9, `cls ${layoutShift.cls}`);
  assert.equal(layoutShift.windowCount, 1);
  assert.equal(layoutShift.shiftCount, 2);
});

test("CLS opens a new session window past the 1s gap cap, and reports the max", () => {
  // Gap of 1500ms > 1000ms: two windows. CLS is the larger.
  const layoutShift = computeLayoutShift([shift(0.1, 0), shift(0.3, 1500)]);
  assert.ok(layoutShift);
  assert.ok(Math.abs(layoutShift.cls - 0.3) < 1e-9, `cls ${layoutShift.cls}`);
  assert.equal(layoutShift.windowCount, 2);
  assert.equal(layoutShift.shiftCount, 1, "the winning window is the single 0.3 shift");
});

test("CLS opens a new session window past the 5s window cap even within the gap cap", () => {
  // Shifts every 900ms (< 1s gap), but the sixth lands >5s after the window's first, opening a new one.
  const entries = [0, 900, 1800, 2700, 3600, 4500, 5400, 6300].map((startTimeMs) =>
    shift(0.05, startTimeMs),
  );
  const layoutShift = computeLayoutShift(entries);
  assert.ok(layoutShift);
  assert.equal(layoutShift.windowCount, 2);
  assert.equal(layoutShift.shiftCount, 6, "the first window holds the six shifts within 5s");
  assert.ok(Math.abs(layoutShift.cls - 0.3) < 1e-9, `cls ${layoutShift.cls}`);
});

test("CLS excludes hadRecentInput entries but keeps the rest of the window", () => {
  const layoutShift = computeLayoutShift([
    shift(0.5, 100, { hadRecentInput: true }),
    shift(0.2, 150),
  ]);
  assert.ok(layoutShift);
  assert.ok(Math.abs(layoutShift.cls - 0.2) < 1e-9, `cls ${layoutShift.cls}`);
  assert.equal(layoutShift.shiftCount, 1);
});

test("CLS selects the winning window and attributes ITS sources", () => {
  const small = shift(0.1, 0, { id: "small" });
  // A separate, larger window 2s later (past the 1s gap): its element must be the one named.
  const big = shift(0.5, 2000, { id: "big" });
  const layoutShift = computeLayoutShift([small, big]);
  assert.ok(layoutShift);
  assert.ok(Math.abs(layoutShift.cls - 0.5) < 1e-9);
  assert.equal(layoutShift.sources[0].node, "div#big");
});

test("CLS attribution ranks sources by area-weighted score, capped, summing to the window score", () => {
  const sources = [
    { tag: "DIV", id: "huge", className: "", previousRect: { x: 0, y: 0, width: 400, height: 400 }, currentRect: { x: 0, y: 200, width: 400, height: 400 } },
    { tag: "P", id: "mid", className: "lead", previousRect: { x: 0, y: 0, width: 100, height: 100 }, currentRect: { x: 0, y: 50, width: 100, height: 100 } },
    { tag: "SPAN", id: "small", className: "", previousRect: { x: 0, y: 0, width: 10, height: 10 }, currentRect: { x: 0, y: 5, width: 10, height: 10 } },
    { tag: "I", id: "tiny", className: "", previousRect: { x: 0, y: 0, width: 2, height: 2 }, currentRect: { x: 0, y: 1, width: 2, height: 2 } },
  ];
  const layoutShift = computeLayoutShift([shift(0.4, 100, { sources })]);
  assert.ok(layoutShift);
  assert.ok(layoutShift.sources.length <= LAYOUT_SHIFT_SOURCE_CAP, "top sources capped");
  assert.equal(layoutShift.sources[0].node, "div#huge", "largest moved area ranks first");
  // The descriptor carries the first class name.
  assert.equal(layoutShift.sources[1].node, "p#mid.lead");
  // Scores descend.
  for (let index = 1; index < layoutShift.sources.length; index++)
    assert.ok(layoutShift.sources[index - 1].score >= layoutShift.sources[index].score);
  // The kept sources' scores never exceed the window score (they are shares of it).
  const keptScore = layoutShift.sources.reduce((sum, source) => sum + source.score, 0);
  assert.ok(keptScore <= layoutShift.cls + 1e-9, `kept ${keptScore} <= cls ${layoutShift.cls}`);
  assert.ok(layoutShift.sources[0].currentRect.y === 200, "rects preserved from the largest occurrence");
});

// --- LCP: the per-iteration merge (mergeLcp, pure) ---

const lcpStep = (renderTimeMs, extra = {}) => ({
  lcp: { tag: "H1", size: 186466, renderTimeMs, startTimeMs: renderTimeMs, ...extra },
});

test("mergeLcp returns undefined for a step that carried no LCP (soft/none step)", () => {
  assert.equal(mergeLcp([{}, {}]), undefined);
});

test("mergeLcp on a single iteration keeps the entry and a degenerate series", () => {
  const merged = mergeLcp([lcpStep(24)]);
  assert.ok(merged);
  assert.equal(merged.tag, "H1");
  assert.equal(merged.renderTimeMs, 24);
  assert.deepEqual(merged.perIteration, [24]);
  assert.equal(merged.stats, null, "below 2 samples, stats is null (same contract as wall)");
});

test("mergeLcp grows the render-time series and stats across iterations", () => {
  // The field case: one boot LCP that swung 536 -> 3644 between runs.
  const merged = mergeLcp([lcpStep(536), lcpStep(3644)]);
  assert.ok(merged);
  assert.deepEqual(merged.perIteration, [536, 3644]);
  assert.equal(merged.stats.samples, 2);
  assert.equal(merged.stats.minMs, 536);
  assert.equal(merged.stats.maxMs, 3644);
  assert.equal(merged.stats.medianMs, 2090);
  // Identity/timing is the lower-median occurrence VERBATIM (a real sample), so renderTimeMs is 536,
  // NOT the computed median 2090.
  assert.equal(merged.renderTimeMs, 536);
});

test("mergeLcp keeps a missed iteration null in the series, never 0", () => {
  const merged = mergeLcp([lcpStep(100, { id: "hero" }), {}]);
  assert.ok(merged);
  assert.deepEqual(merged.perIteration, [100, null]);
  assert.equal(merged.stats, null, "one usable sample: stats null");
  assert.equal(merged.id, "hero", "identity comes from the iteration that fired");
});

test("mergeLcp reports a bare suppressed marker when every iteration hit the anomaly", () => {
  const merged = mergeLcp([{ lcp: { suppressed: true } }, { lcp: { suppressed: true } }]);
  assert.deepEqual(merged, { suppressed: true });
});

test("mergeLcp treats a suppressed iteration as a null sample, not a lost identity", () => {
  const merged = mergeLcp([{ lcp: { suppressed: true } }, lcpStep(50, { tag: "P" })]);
  assert.ok(merged);
  assert.ok(!merged.suppressed);
  assert.deepEqual(merged.perIteration, [null, 50]);
  assert.equal(merged.tag, "P");
});
