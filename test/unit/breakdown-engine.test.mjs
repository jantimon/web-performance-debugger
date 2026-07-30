import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, invalidationKind } from "../../dist/trace/classify.js";
import { computeStats, buildSummary } from "../../dist/metrics/summarize.js";
import { forcedLayouts, markForced, representativeEventId } from "../../dist/trace/analysis.js";
import { computeSpanBreakdown } from "../../dist/trace/breakdown.js";
import { userMeasureSpans } from "../../dist/commands/record.js";
import { NESTED_EVENTS, NESTED_WINDOW, lcg, randomNestedEvents } from "./helpers.mjs";

test("classify maps trace event names to kinds", () => {
  assert.equal(classify("Layout", ""), "layout");
  assert.equal(classify("UpdateLayoutTree", ""), "style");
  assert.equal(classify("Paint", ""), "paint");
  assert.equal(classify("RunTask", ""), "task");
  assert.equal(classify("LayoutInvalidationTracking", ""), "invalidation");
  assert.equal(classify("Whatever", "blink.user_timing"), "usertiming");
  assert.equal(classify("Nope", ""), "other");
});

// The gc kind is a sanctioned coupling-point addition for the seven-slice breakdown. [measured on a
// real light-trace capture] the main-thread GC events are MinorGC/MajorGC (from devtools.timeline,
// so no v8.gc category is needed); the V8.GC* family is matched defensively. The check must sit
// BEFORE the scripting fallback, or a GC event whose category includes "v8" would land in js
test("classify maps GC events to the gc kind, ahead of the v8 scripting fallback", () => {
  assert.equal(classify("MinorGC", "disabled-by-default-devtools.timeline"), "gc");
  assert.equal(classify("MajorGC", "disabled-by-default-devtools.timeline"), "gc");
  assert.equal(classify("V8.GCScavenger", "disabled-by-default-v8.gc"), "gc");
  // a non-GC v8 event still classifies as scripting
  assert.equal(classify("v8.run", "v8"), "scripting");
});

test("invalidationKind classifies by name", () => {
  assert.equal(invalidationKind("LayoutInvalidationTracking"), "layout");
  assert.equal(invalidationKind("PaintInvalidationTracking"), "paint");
  assert.equal(invalidationKind("StyleRecalcInvalidationTracking"), "style");
});

test("computeStats: null below 2 samples, correct median/mean", () => {
  assert.equal(computeStats([]), null);
  assert.equal(computeStats([5]), null);
  const stats = computeStats([4, 1, 3, 2]);
  assert.equal(stats.samples, 4);
  assert.equal(stats.minMs, 1);
  assert.equal(stats.maxMs, 4);
  assert.equal(stats.medianMs, 2.5);
  assert.equal(stats.meanMs, 2.5);
});

test("markForced + forcedLayouts group by source", () => {
  const events = [
    { id: 0, name: "Layout", ts: 10, dur: 1000, ph: "X", kind: "layout", at: "a.js:1:1" },
    { id: 1, name: "Layout", ts: 20, dur: 2000, ph: "X", kind: "layout", at: "a.js:1:1" },
    { id: 2, name: "Layout", ts: 30, dur: 500, ph: "X", kind: "layout" }, // no stack -> not forced
  ];
  markForced(events);
  assert.equal(events[0].forced, true);
  assert.equal(events[2].forced, undefined);
  const groups = forcedLayouts(events, null);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].at, "a.js:1:1");
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].durMs, 3); // (1000 + 2000) / 1000
  // The representative event id is the WIDEST (max-dur) flush at the line: id 1 (dur 2000), not id 0
  assert.equal(groups[0].eventId, 1, "forcedLayouts carries the widest flush's id per group");
});

// The blame -> `query get` representative: the widest (max-duration) flush's id wins, so a drill
// lands on the biggest flush a row aggregates. A synthesized --breakdown sampled event (id 0,
// sampled:true) is never addressable, so a row of only those carries no id (absent, never a fake 0)
test("representativeEventId: widest flush wins; synthesized sampled rows carry none", () => {
  // Real-id flushes: the max-dur one (id 7) is the representative, regardless of order
  const real = [
    { id: 5, ts: 10, dur: 1000, kind: "layout" },
    { id: 7, ts: 20, dur: 3000, kind: "layout" },
    { id: 6, ts: 30, dur: 2000, kind: "layout" },
  ];
  assert.equal(representativeEventId(real), 7);

  // A real id of 0 (a chrome --deep / firefox ts-order first event) is addressable and kept
  assert.equal(representativeEventId([{ id: 0, ts: 1, dur: 500, kind: "layout" }]), 0);

  // Chrome --breakdown sampled rows: every event is synthesized with id 0 + sampled:true -> no id
  const sampled = [
    { id: 0, ts: 10, dur: 1000, kind: "layout", sampled: true },
    { id: 0, ts: 20, dur: 4000, kind: "layout", sampled: true },
  ];
  assert.equal(representativeEventId(sampled), undefined);

  // Firefox sampled read-site events carry REAL (reassigned) ids, so they stay addressable
  const firefoxSampled = [
    { id: 3, ts: 10, dur: 1000, kind: "layout", sampled: true },
    { id: 8, ts: 20, dur: 2000, kind: "layout", sampled: true },
  ];
  assert.equal(representativeEventId(firefoxSampled), 8);

  assert.equal(representativeEventId([]), undefined);
});

test("computeSpanBreakdown: disjoint self-time over nesting, and the `other` remainder", () => {
  const breakdown = computeSpanBreakdown(NESTED_EVENTS, [], NESTED_WINDOW);
  const { js, style, layout, paint, gc, other, idle } = breakdown.slices;
  // FunctionCall self = 30 - 10 (Layout child) = 20; Layout = 10; Paint = 10
  assert.equal(js.ms, 20);
  assert.equal(layout.ms, 10);
  assert.equal(paint.ms, 10);
  assert.equal(style.ms, 0);
  assert.equal(gc.ms, 0);
  // RunTask self = 100 - 30 (FunctionCall subtree) - 10 (Paint) = 60, the task remainder
  assert.equal(other.ms, 60);
  // window is 100% busy, so idle is 0
  assert.equal(idle.ms, 0);
});

test("computeSpanBreakdown: Σ slices + idle == wall EXACTLY (the product promise)", () => {
  // A window with an idle gap: the RunTask covers [0,50000] only, so [50000,100000) is idle and the
  // sum must still close to the wall with zero residual
  const events = [
    { id: 0, name: "RunTask", ts: 0, dur: 50000, ph: "X", kind: "task" },
    { id: 1, name: "FunctionCall", ts: 10000, dur: 20000, ph: "X", kind: "scripting" },
  ];
  const breakdown = computeSpanBreakdown(events, [], { startTs: 0, endTs: 100000 });
  const { js, style, layout, paint, gc, other, idle } = breakdown.slices;
  assert.equal(js.ms, 20); // FunctionCall self
  assert.equal(other.ms, 30); // RunTask remainder (50 - 20)
  assert.equal(idle.ms, 50); // [50000,100000) uncovered
  const sum = js.ms + style.ms + layout.ms + paint.ms + gc.ms + other.ms + idle.ms;
  assert.ok(Math.abs(sum - breakdown.wallMs) < 1e-9, `sum ${sum} must equal wall ${breakdown.wallMs}`);
  assert.equal(breakdown.residualMs, undefined, "an exact tiling carries no residual");
});

test("computeSpanBreakdown: js slice is split by sampled package, samples outside js excluded", () => {
  // js self-time regions are [10000,20000) and [30000,40000) (FunctionCall minus the Layout child)
  const samples = [
    { traceTs: 15000, package: "react-dom" }, // inside a js region
    { traceTs: 15500, package: "react-dom" }, // inside a js region
    { traceTs: 35000, package: "app" }, // inside a js region
    { traceTs: 25000, package: "react-dom" }, // inside the Layout region -> NOT a js sample
    { traceTs: 55000, package: "app" }, // inside the Paint region -> NOT a js sample
    { traceTs: 12000, package: null }, // in a js region but unattributable -> excluded from the split
  ];
  const breakdown = computeSpanBreakdown(NESTED_EVENTS, samples, NESTED_WINDOW);
  const { js } = breakdown.slices;
  assert.equal(js.ms, 20);
  // three counted js samples: react-dom x2, app x1 -> 2/3 and 1/3 of the TRACE-measured 20ms
  assert.ok(Math.abs(js.byPackage["react-dom"] - (20 * 2) / 3) < 1e-9);
  assert.ok(Math.abs(js.byPackage["app"] - (20 * 1) / 3) < 1e-9);
  const pkgSum = Object.values(js.byPackage).reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(pkgSum - js.ms) < 1e-9, "byPackage must sum to js.ms");
});

test("computeSpanBreakdown: zero samples in the js regions leaves byPackage empty, not fabricated", () => {
  const breakdown = computeSpanBreakdown(NESTED_EVENTS, [{ traceTs: 55000, package: "app" }], NESTED_WINDOW);
  assert.deepEqual(breakdown.slices.js.byPackage, {}, "a sample outside js contributes no package");
  assert.equal(breakdown.slices.js.ms, 20, "the js ms is still the trace-measured value");
});

// At an EQUAL start ts the sort tiebreaker (`|| right.end - left.end`) must put the longer
// (container) interval first, or the disjoint sweep pushes the child onto the stack as if it were
// the parent and the inner slice vanishes. Input order is deliberately child-first so only the
// comparator decides; inverting the tiebreaker (`left.end - right.end`) sorts the child first and
// zeroes the inner layout, which this pins
test("computeSpanBreakdown: at an equal start the container sorts before the child (the tiebreaker)", () => {
  const events = [
    { id: 0, name: "Layout", ts: 0, dur: 40000, ph: "X", kind: "layout" }, // inner child (shorter)
    { id: 1, name: "RunTask", ts: 0, dur: 100000, ph: "X", kind: "task" }, // outer container (longer)
  ];
  const breakdown = computeSpanBreakdown(events, [], { startTs: 0, endTs: 100000 });
  assert.equal(breakdown.slices.layout.ms, 40, "the nested layout keeps its 40ms self-time");
  assert.equal(breakdown.slices.other.ms, 60, "the container's remainder is the other slice");
  assert.equal(breakdown.slices.idle.ms, 0, "the window is fully covered");
});

// The js segments are half-open [start, end): a sample AT a segment's `end` belongs to the next
// segment, never this one (the `ts >= segment.end` boundary in inAnySegment). NESTED_EVENTS' first js
// region is [10000,20000); 20000 is the start of the Layout region, so a sample there must NOT count
// toward js. Relaxing the boundary to `ts > segment.end` would wrongly fold it into js, splitting the
// share; a distinct package on the boundary sample makes that split visible
test("computeSpanBreakdown: a sample exactly at a js-segment end lands in the next segment, not js", () => {
  const samples = [
    { traceTs: 15000, package: "react" }, // strictly inside the first js region
    { traceTs: 20000, package: "app" }, // AT the js-region end == Layout-region start -> not a js sample
  ];
  const breakdown = computeSpanBreakdown(NESTED_EVENTS, samples, NESTED_WINDOW);
  // Only react is counted, so it owns the whole 20ms js slice; app never enters the split
  assert.deepEqual(breakdown.slices.js.byPackage, { react: 20 });
});

test("computeSpanBreakdown: 50 random nested flame charts each tile the window with no residual", () => {
  const rand = lcg(0x9e3779b9);
  for (let iteration = 0; iteration < 50; iteration++) {
    const { events, window } = randomNestedEvents(rand);
    const breakdown = computeSpanBreakdown(events, [], window);
    const { js, style, layout, paint, gc, other, idle } = breakdown.slices;
    const sum = js.ms + style.ms + layout.ms + paint.ms + gc.ms + other.ms + idle.ms;
    assert.ok(
      Math.abs(sum - breakdown.wallMs) < 1e-9,
      `case ${iteration}: Σ ${sum} must equal wall ${breakdown.wallMs}`,
    );
    assert.equal(breakdown.residualMs, undefined, `case ${iteration}: an exact tiling carries no residual`);
  }
});

test("userMeasureSpans: pairs user measures, excludes wpd:*, drops out-of-window, keeps EVERY occurrence", () => {
  const usertiming = (name, ph, ts) => ({ id: ts, name, ts, dur: 0, ph, kind: "usertiming" });
  const events = [
    usertiming("wpd:run", "b", 100), // wpd's own measure -> excluded
    usertiming("user-span", "b", 150),
    usertiming("user-span", "e", 400),
    usertiming("wpd:run", "e", 1000),
    usertiming("hydrate", "b", 200),
    usertiming("hydrate", "e", 300),
    usertiming("user-span", "b", 500), // a repeat of the same name -> its own sample, kept
    usertiming("user-span", "e", 600),
    usertiming("late", "b", 900),
    usertiming("late", "e", 1200), // ends after the run window -> dropped
  ];
  const spans = userMeasureSpans(events, 100, 1000);
  // Every in-window occurrence is returned in end-event order; the repeat is a second sample of the
  // same label, merged per label downstream (span-merge), not dropped here
  assert.deepEqual(spans, [
    { label: "user-span", startTs: 150, endTs: 400 },
    { label: "hydrate", startTs: 200, endTs: 300 },
    { label: "user-span", startTs: 500, endTs: 600 },
  ]);
});

// The one capture that ran gates each count/duration to Measured null vs a number. A --deep-shaped
// capture (counts + forced, durations OFF because .stack distorts them); a breakdown-shaped one
// (counts + durations, forced OFF); the default capture mode (nothing)
const DEEP = { counts: true, paintCount: true, longTasks: true, invalidations: true, durations: false, forced: true };
const LIGHT = { counts: true, paintCount: true, longTasks: true, invalidations: false, durations: true, forced: false };

// Rendering counts are Measured: a capture mode that saw a trace reports the exact count, a capture mode that did
// not (the default capture mode, or a mode that drops the .stack forced detection) reports null, never 0
test("buildSummary: capabilities gate forced to a count or to null (never a fake 0)", () => {
  const events = [{ id: 0, name: "Layout", ts: 1, dur: 2000, ph: "X", kind: "layout" }];
  const measured = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: DEEP });
  assert.equal(measured.forcedLayoutCount, 0, "forced measured, and this window forced nothing");
  const notMeasured = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: LIGHT });
  assert.equal(notMeasured.forcedLayoutCount, null, "light trace has no .stack: forced not measured, so null");
  assert.equal(notMeasured.forcedLayoutMs, null);
  // The default capture mode captures no trace: every count is null
  const defaultMode = buildSummary({ detailEvents: events, detailWindowStart: null });
  assert.equal(defaultMode.layoutCount, null, "default capture mode has no trace, so no counts");
});

// Counts come from the trace, main-thread windowed, when the capture captured one
test("buildSummary: trace counts are Measured on capabilities.counts, null without", () => {
  const events = [
    { id: 0, name: "Layout", ts: 1, dur: 2000, ph: "X", kind: "layout" },
    { id: 1, name: "Paint", ts: 2, dur: 1000, ph: "X", kind: "paint" },
  ];
  const withTrace = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: LIGHT });
  assert.equal(withTrace.layoutCount, 1);
  assert.equal(withTrace.paintCount, 1);
  const noTrace = buildSummary({ detailEvents: events, detailWindowStart: null });
  assert.equal(noTrace.layoutCount, null, "default capture mode: no trace, no count");
  assert.equal(noTrace.paintCount, null);
});

// The HARD GUARD: durations are structurally refusable on a .stack trace. A --deep capture reports
// the exact style COUNT but a null style DURATION (the .stack trace inflates it up to +38%); a light
// (--breakdown) capture reports both. Either way ParseAuthorStyleSheet is excluded (real style time,
// not a recalc). See docs/dev/rendering-counts.md and §25 disclosure rule 2
test("buildSummary: .stack (--deep) capture reports counts but refuses durations; light reports both", () => {
  const events = [
    { id: 0, name: "UpdateLayoutTree", ts: 1, dur: 2000, ph: "X", kind: "style" },
    { id: 1, name: "UpdateLayoutTree", ts: 3, dur: 3000, ph: "X", kind: "style" },
    { id: 2, name: "ParseAuthorStyleSheet", ts: 5, dur: 9000, ph: "X", kind: "style" },
  ];
  const light = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: LIGHT });
  assert.equal(light.styleCount, 2, "only the two recalcs count, not the parse");
  assert.equal(light.styleMs, 5, "light trace: duration sums the recalcs (2ms + 3ms), not the parse");

  const deep = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: DEEP });
  assert.equal(deep.styleCount, 2, "--deep still counts exactly (counts are exact on the .stack trace)");
  assert.equal(deep.styleMs, null, "--deep refuses the distorted style duration (durations off on .stack)");
  assert.equal(deep.layoutMs, null, "and layout duration too");
});

// Driver steps are heterogeneous ("mount" vs "inp"), so the ONLY meaningful aggregation is each step
// against itself, and it must not leak into the bench-shaped top-level stats. Under schema 5 each step
// carries its own perIteration/stats on its step span (built via computeStats over the step window),
// so the run summary keeps no cross-step median: bench perIteration/stats stay empty on a driver run
test("buildSummary: a driver run keeps no bench-shaped top-level stats (steps aggregate on their spans)", () => {
  const summary = buildSummary({ detailEvents: [], detailWindowStart: null });
  assert.deepEqual(summary.perIteration, []);
  assert.equal(summary.stats, null);
});
