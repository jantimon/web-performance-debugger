import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, invalidationKind } from "../../dist/trace/classify.js";
import { computeStats, buildSummary } from "../../dist/metrics/summarize.js";
import { forcedLayouts, longTasks, markForced } from "../../dist/trace/analysis.js";
import { computeSpanBreakdown } from "../../dist/trace/breakdown.js";
import { userMeasureSpans } from "../../dist/commands/record.js";
import { NESTED_EVENTS, NESTED_WINDOW, lcg, BREAKDOWN_KINDS, randomNestedEvents } from "./helpers.mjs";

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
// BEFORE the scripting fallback, or a GC event whose category includes "v8" would land in js.
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
  const s = computeStats([4, 1, 3, 2]);
  assert.equal(s.samples, 4);
  assert.equal(s.minMs, 1);
  assert.equal(s.maxMs, 4);
  assert.equal(s.medianMs, 2.5);
  assert.equal(s.meanMs, 2.5);
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
});

test("longTasks finds >=50ms tasks with dominant kind", () => {
  const events = [
    { id: 0, name: "RunTask", ts: 0, dur: 60000, ph: "X", kind: "task" },
    { id: 1, name: "Layout", ts: 10, dur: 40000, ph: "X", kind: "layout" },
    { id: 2, name: "Paint", ts: 20, dur: 5000, ph: "X", kind: "paint" },
    { id: 3, name: "RunTask", ts: 100000, dur: 1000, ph: "X", kind: "task" }, // too short
  ];
  const tasks = longTasks(events, null);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].durMs, 60);
  assert.equal(tasks[0].dominantKind, "layout");
});

test("computeSpanBreakdown: disjoint self-time over nesting, and the `other` remainder", () => {
  const breakdown = computeSpanBreakdown(NESTED_EVENTS, [], NESTED_WINDOW);
  const { js, style, layout, paint, gc, other, idle } = breakdown.slices;
  // FunctionCall self = 30 - 10 (Layout child) = 20; Layout = 10; Paint = 10.
  assert.equal(js.ms, 20);
  assert.equal(layout.ms, 10);
  assert.equal(paint.ms, 10);
  assert.equal(style.ms, 0);
  assert.equal(gc.ms, 0);
  // RunTask self = 100 - 30 (FunctionCall subtree) - 10 (Paint) = 60, the task remainder.
  assert.equal(other.ms, 60);
  // window is 100% busy, so idle is 0.
  assert.equal(idle.ms, 0);
});

test("computeSpanBreakdown: Σ slices + idle == wall EXACTLY (the product promise)", () => {
  // A window with an idle gap: the RunTask covers [0,50000] only, so [50000,100000) is idle and the
  // sum must still close to the wall with zero residual.
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
  // js self-time regions are [10000,20000) and [30000,40000) (FunctionCall minus the Layout child).
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
  // three counted js samples: react-dom x2, app x1 -> 2/3 and 1/3 of the TRACE-measured 20ms.
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
  // same label, merged per label downstream (span-merge), not dropped here.
  assert.deepEqual(spans, [
    { label: "user-span", startTs: 150, endTs: 400 },
    { label: "hydrate", startTs: 200, endTs: 300 },
    { label: "user-span", startTs: 500, endTs: 600 },
  ]);
});

// The one capture that ran gates each count/duration to Measured null vs a number. A --deep-shaped
// capture (counts + forced, durations OFF because .stack distorts them); a breakdown-shaped one
// (counts + durations, forced OFF); the default rung (nothing).
const DEEP = { counts: true, paintCount: true, longTasks: true, invalidations: true, durations: false, forced: true };
const LIGHT = { counts: true, paintCount: true, longTasks: true, invalidations: false, durations: true, forced: false };

// Rendering counts are Measured: a rung that saw a trace reports the exact count, a rung that did
// not (the default rung, or a mode that drops the .stack forced detection) reports null, never 0.
test("buildSummary: capabilities gate forced to a count or to null (never a fake 0)", () => {
  const events = [{ id: 0, name: "Layout", ts: 1, dur: 2000, ph: "X", kind: "layout" }];
  const measured = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: DEEP });
  assert.equal(measured.forcedLayoutCount, 0, "forced measured, and this window forced nothing");
  const notMeasured = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: LIGHT });
  assert.equal(notMeasured.forcedLayoutCount, null, "light trace has no .stack: forced not measured, so null");
  assert.equal(notMeasured.forcedLayoutMs, null);
  // The default rung captures no trace: every count is null.
  const defaultRung = buildSummary({ detailEvents: events, detailWindowStart: null });
  assert.equal(defaultRung.layoutCount, null, "default rung has no trace, so no counts");
});

// Counts come from the trace, main-thread windowed, when the capture captured one.
test("buildSummary: trace counts are Measured on capabilities.counts, null without", () => {
  const events = [
    { id: 0, name: "Layout", ts: 1, dur: 2000, ph: "X", kind: "layout" },
    { id: 1, name: "Paint", ts: 2, dur: 1000, ph: "X", kind: "paint" },
  ];
  const withTrace = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: LIGHT });
  assert.equal(withTrace.layoutCount, 1);
  assert.equal(withTrace.paintCount, 1);
  const noTrace = buildSummary({ detailEvents: events, detailWindowStart: null });
  assert.equal(noTrace.layoutCount, null, "default rung: no trace, no count");
  assert.equal(noTrace.paintCount, null);
});

// The HARD GUARD: durations are structurally refusable on a .stack trace. A --deep capture reports
// the exact style COUNT but a null style DURATION (the .stack trace inflates it up to +38%); a light
// (--breakdown) capture reports both. Either way ParseAuthorStyleSheet is excluded (real style time,
// not a recalc). See docs/dev/rendering-counts.md and §25 disclosure rule 2.
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

// Driver steps are heterogeneous ("mount" vs "inp"), so the ONLY meaningful aggregation is each
// step against itself. A median pooled across steps, or leaking into the bench-shaped top-level
// stats, would render a meaningless number as a real one.
test("buildSummary: perStep aggregates each step against itself, never across steps", () => {
  const base = { detailEvents: [], detailWindowStart: null };
  const summary = buildSummary({
    ...base,
    perStep: [
      { label: "mount", perIteration: [40, 44, 42] },
      { label: "inp", perIteration: [5, 9, 7] },
    ],
  });

  const stepOf = (label) => summary.perStep.find((step) => step.label === label);
  // each step's own median, computed only from its own samples
  assert.equal(stepOf("mount").stats.medianMs, 42);
  assert.equal(stepOf("inp").stats.medianMs, 7);
  assert.equal(stepOf("mount").stats.samples, 3);
  // raw samples are kept, not collapsed to the statistic
  assert.deepEqual(stepOf("inp").perIteration, [5, 9, 7]);

  // per-step walls must not leak into the bench-shaped top-level stats either (pooling all six
  // samples would yield a real-looking median of 24.5 that describes no actual work)
  assert.deepEqual(summary.perIteration, []);
  assert.equal(summary.stats, null);
});

test("buildSummary: a step measured once has stats null but keeps its sample", () => {
  const summary = buildSummary({
    detailEvents: [],
    detailWindowStart: null,
    perStep: [{ label: "mount", perIteration: [36.7] }],
  });
  // same contract as the bench stats: no statistic below 2 samples, rather than a fake one
  assert.equal(summary.perStep[0].stats, null);
  assert.deepEqual(summary.perStep[0].perIteration, [36.7]);
});

test("longTasks blames the source by duration, not event count", () => {
  // cheap.js fires 3 short layouts (high count); hot.js fires 1 long one (high duration).
  // The blamed `at` must be the expensive site, matching how dominantKind is chosen.
  const events = [
    { id: 0, name: "RunTask", ts: 0, dur: 60000, ph: "X", kind: "task" },
    { id: 1, name: "Layout", ts: 1, dur: 1000, ph: "X", kind: "layout", at: "cheap.js:1" },
    { id: 2, name: "Layout", ts: 2, dur: 1000, ph: "X", kind: "layout", at: "cheap.js:1" },
    { id: 3, name: "Layout", ts: 3, dur: 1000, ph: "X", kind: "layout", at: "cheap.js:1" },
    { id: 4, name: "Layout", ts: 4, dur: 30000, ph: "X", kind: "layout", at: "hot.js:1" },
  ];
  const tasks = longTasks(events, null);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].at, "hot.js:1");
  assert.equal(tasks[0].dominantKind, "layout");
});
