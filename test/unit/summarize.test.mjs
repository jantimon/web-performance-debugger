import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummary, traceRenderingWork } from "../../dist/metrics/summarize.js";
import { buildRecordingSpans } from "../../dist/record/spans-build.js";
import { mainThread } from "../../dist/trace/main-thread.js";
import { classify } from "../../dist/trace/classify.js";

// Trace-sourced layout/style counts and durations, windowed on the breakdown bar's single main
// thread. Fixtures reproduce the probe relationships that gate deleting the CDP getMetrics path:
// count parity (§24 probe E), the ParseAuthorStyleSheet exclusion for count AND duration (§26 probe
// F), and the OOPIF main-thread scoping (§25 probe E2). See docs/dev/rendering-counts.md.

const marker = (pid, tid) => ({
  id: 0,
  name: "wpd:run:start",
  ts: 0,
  dur: 0,
  ph: "R",
  kind: "usertiming",
  pid,
  tid,
});
const layout = (id, dur, pid, tid) => ({ id, name: "Layout", ts: id, dur, ph: "X", kind: "layout", pid, tid });
const recalc = (id, dur, pid, tid) => ({ id, name: "UpdateLayoutTree", ts: id, dur, ph: "X", kind: "style", pid, tid });
const parse = (id, dur, pid, tid) => ({ id, name: "ParseAuthorStyleSheet", ts: id, dur, ph: "X", kind: "style", pid, tid });

// §25 probe E2 Q2: getMetrics is per-process (top only); an all-pids trace sum double-scopes the
// OOPIF's layout. Counting on the bar's main thread reproduces top-process getMetrics exactly.
test("traceRenderingWork counts layout on the main thread only, excluding an OOPIF thread", () => {
  const events = [marker(48371, 1)];
  for (let index = 0; index < 6; index++) events.push(layout(index + 1, 1000, 48371, 1)); // top process
  for (let index = 0; index < 12; index++) events.push(layout(index + 100, 1000, 48373, 1)); // OOPIF process

  const main = mainThread(events);
  assert.deepEqual({ pid: main.pid, tid: main.tid, via: main.via }, { pid: 48371, tid: 1, via: "marker" });

  const onMain = traceRenderingWork(events, null, main);
  assert.equal(onMain.layoutCount, 6, "reproduces top-process getMetrics LayoutCount (6), not 6+12");

  const allPids = traceRenderingWork(events, null, null);
  assert.equal(allPids.layoutCount, 18, "an unfiltered sum double-scopes the OOPIF (6 + 12)");
});

// buildSummary is the regression gate: with the CDP counter path deleted, the reported layoutCount
// must equal the pre-deletion top-process number, sourced from the trace, main-thread windowed. The
// OOPIF's 12 are excluded exactly as getMetrics excluded them (§25 disclosure rule 3).
const TRACE_CAP = {
  counts: true,
  paintCount: true,
  longTasks: true,
  invalidations: true,
  durations: true,
  forced: true,
};
test("buildSummary: trace-sourced layoutCount is main-thread windowed, matching top-process getMetrics", () => {
  const events = [marker(48371, 1)];
  for (let index = 0; index < 6; index++) events.push(layout(index + 1, 1000, 48371, 1));
  for (let index = 0; index < 12; index++) events.push(layout(index + 100, 1000, 48373, 1));

  const summary = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: TRACE_CAP });
  assert.equal(summary.layoutCount, 6);

  // The default rung (no capabilities) captures no trace: the count is Measured null, never a fake 0.
  const defaultRung = buildSummary({ detailEvents: events, detailWindowStart: null });
  assert.equal(defaultRung.layoutCount, null, "no trace on the default rung, so no count");
});

// §26 probe F: CDP RecalcStyleDuration EXCLUDES the stylesheet parse. The excluded variant tracks
// CDP; the included variant overshoots by exactly the ParseAuthorStyleSheet dur. The count rule
// (§24) and the duration rule share the one STYLE_PARSE_NAMES filter, so both drop the parse.
test("traceRenderingWork excludes ParseAuthorStyleSheet from styleCount AND styleUs", () => {
  const recalcUs = 3700;
  const parseUs = 7380;
  const events = [];
  for (let index = 0; index < 5; index++) events.push(recalc(index + 1, recalcUs, 100, 1));
  events.push(parse(10, parseUs, 100, 1));

  const work = traceRenderingWork(events, null, null);
  assert.equal(work.styleCount, 5, "the 5 recalcs count, the parse does not (== RecalcStyleCount)");
  assert.equal(work.styleUs, 5 * recalcUs, "styleUs sums the recalcs only (== RecalcStyleDuration)");

  // The included variant (naive Σ dur over every style-kind event) overshoots by exactly the parse
  // dur: that is the divergence the exclusion prevents, and why the parse is fenced out of styleUs.
  const includedUs = events
    .filter((event) => event.kind === "style")
    .reduce((sum, event) => sum + event.dur, 0);
  assert.equal(includedUs, work.styleUs + parseUs);
});

// §24 probe E count parity: the forcedLayout10 row (9 layout / 9 style) reproduces exactly; a parse
// mixed in never moves the style count.
test("traceRenderingWork reproduces the §24 count parity (9 layout / 9 style), parse never counted", () => {
  const events = [];
  for (let index = 0; index < 9; index++) {
    events.push(layout(index + 1, 500, 100, 1));
    events.push(recalc(index + 100, 500, 100, 1));
  }
  events.push(parse(500, 9000, 100, 1)); // a lazy <link rel=stylesheet> parsed in-window: +0 to the count
  const work = traceRenderingWork(events, null, null);
  assert.equal(work.layoutCount, 9);
  assert.equal(work.styleCount, 9);
});

// Parity depends on only UpdateLayoutTree being a recalc: the legacy RecalcStyles/RecalcStyle names
// are removed from the taxonomy, so classify never labels them `style` and they cannot be counted.
test("classify does not treat legacy RecalcStyles names as style (only UpdateLayoutTree recalcs)", () => {
  assert.equal(classify("UpdateLayoutTree", ""), "style");
  assert.notEqual(classify("RecalcStyles", ""), "style");
  assert.notEqual(classify("RecalcStyle", ""), "style");
});

// Sampled Firefox read-site blame annotations are not measured flushes; counting them would
// double-count the one-per-flush Reflow/Styles markers. inWindow is start-onward, so a pre-window
// event is excluded.
test("traceRenderingWork skips sampled annotations and pre-window events", () => {
  const events = [
    layout(1, 1000, 100, 1),
    { ...layout(2, 1000, 100, 1), sampled: true },
    { ...recalc(3, 1000, 100, 1), sampled: true },
    { ...layout(4, 1000, 100, 1), ts: -50 }, // before the window start
  ];
  const work = traceRenderingWork(events, 0, null);
  assert.equal(work.layoutCount, 1, "one real in-window layout; sampled and pre-window dropped");
  assert.equal(work.styleCount, 0, "the only recalc is a sampled annotation");
});

// With the CDP counter path deleted, counts and durations come from the trace alone (no CDP source
// to shadow them). The single-axis invariant: on a light trace both counts and durations are
// measured; on a .stack (--deep) trace the counts stay exact but the durations are refused (null).
test("buildSummary sources counts/durations from the trace; --deep refuses the distorted durations", () => {
  const events = [marker(100, 1), layout(1, 2000, 100, 1), recalc(2, 3000, 100, 1)];
  const light = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: TRACE_CAP });
  assert.equal(light.layoutCount, 1);
  assert.equal(light.layoutMs, 2);
  assert.equal(light.styleCount, 1);
  assert.equal(light.styleMs, 3);

  const deep = buildSummary({
    detailEvents: events,
    detailWindowStart: null,
    capabilities: { ...TRACE_CAP, durations: false },
  });
  assert.equal(deep.layoutCount, 1, "counts stay exact on a .stack trace");
  assert.equal(deep.layoutMs, null, "durations are refused on a .stack trace");
  assert.equal(deep.styleMs, null);
});

// F28: the GENERAL count loop (paint/forced/invalidation/long-task/total) scoped to the same main
// thread as layout/style, so an OOPIF's own-process paint/forced work is filtered out, never summed
// into the main-thread window.
const paint = (id, dur, pid, tid) => ({ id, name: "Paint", ts: id, dur, ph: "X", kind: "paint", pid, tid });
const forcedLayout = (id, dur, pid, tid) => ({ ...layout(id, dur, pid, tid), forced: true });
test("buildSummary scopes paint/forced/total to the main thread, excluding an OOPIF process (F28)", () => {
  const events = [marker(1, 1)];
  // top process (the selected main thread): 2 paints, 1 forced layout
  events.push(paint(10, 500, 1, 1), paint(11, 500, 1, 1), forcedLayout(12, 500, 1, 1));
  // OOPIF process: 5 paints, 3 forced layouts -- must NOT count toward the main-thread window
  for (let index = 0; index < 5; index++) events.push(paint(index + 100, 500, 2, 1));
  for (let index = 0; index < 3; index++) events.push(forcedLayout(index + 200, 500, 2, 1));

  const summary = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: TRACE_CAP });
  assert.equal(summary.paintCount, 2, "only the top-process paints count, not the OOPIF's 5");
  assert.equal(summary.forcedLayoutCount, 1, "only the top-process forced layout counts, not the OOPIF's 3");
  // totalEvents is main-thread scoped too: marker + 2 paint + 1 forced = 4, never the OOPIF's 8 mixed in.
  assert.equal(summary.totalEvents, 4, "totalEvents excludes the OOPIF process (would be 12 unfiltered)");
});

// F29: a step's counts are scoped to the RUN-selected thread, not re-picked by the heuristic on the
// step's own marker-less window. Here the OOPIF thread does more layout inside the step window, so a
// per-step heuristic would pick it; the run's marker selection (top process) must win, so the step's
// counts match the thread its bar sits on.
test("buildRecordingSpans: a step's counts follow the run-selected thread, not the step heuristic (F29)", () => {
  const events = [marker(1, 1)]; // run:start on the top process (main thread)
  events.push(layout(10, 500, 1, 1)); // 1 layout on the main thread inside the step window
  for (let index = 0; index < 5; index++) events.push(layout(index + 100, 500, 2, 1)); // 5 on the OOPIF

  // Sanity: on the step window alone (no marker) the heuristic picks the busier OOPIF thread.
  const stepWindowEvents = events.filter((event) => event.name !== "wpd:run:start");
  assert.equal(mainThread(stepWindowEvents).pid, 2, "heuristic alone would pick the OOPIF thread");

  const runSummary = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: TRACE_CAP });
  const spans = buildRecordingSpans({
    summary: runSummary,
    mergedSteps: [
      {
        index: 0,
        label: "mount",
        perIteration: [10],
        wallMs: 10,
        inpMs: null,
        interaction: null,
        startTs: 5,
        endTs: 300,
      },
    ],
    detailEvents: events,
    capabilities: TRACE_CAP,
    bars: [],
    runWindowEnd: 400,
  });
  const step = spans.find((span) => span.kind === "step");
  assert.ok(step, "the step span is present");
  assert.equal(step.counts.layoutCount, 1, "step counts on the run's main thread (1), not the OOPIF's 5");
});

// F27: a step whose end marker was lost (endTs null) must window its counts to the run end -- the
// same bound its bar uses (breakdown-spans.ts `step.endTs ?? runWindow.endTs`) -- rather than running
// open to trace end, which would fold settle-tail work after the run window into the step.
test("buildRecordingSpans: a start-only step windows counts to the run end, not trace end (F27)", () => {
  const events = [marker(1, 1)];
  events.push(layout(50, 500, 1, 1)); // inside the run window [5, 100]
  events.push(layout(150, 500, 1, 1)); // settle-tail layout AFTER run end: must not count for the step

  const runSummary = buildSummary({ detailEvents: events, detailWindowStart: null, capabilities: TRACE_CAP });
  const spans = buildRecordingSpans({
    summary: runSummary,
    mergedSteps: [
      {
        index: 0,
        label: "mount",
        perIteration: [10],
        wallMs: 10,
        inpMs: null,
        interaction: null,
        startTs: 5,
        endTs: null, // the wpd:step:0:end mark was lost from the trace
      },
    ],
    detailEvents: events,
    capabilities: TRACE_CAP,
    bars: [],
    runWindowEnd: 100,
  });
  const step = spans.find((span) => span.kind === "step");
  assert.equal(step.counts.layoutCount, 1, "bounded to the run end (1), not open to trace end (2)");
});
