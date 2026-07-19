import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { buildBreakdowns } from "../../dist/record/breakdown-spans.js";
import { SourceMapResolver } from "../../dist/trace/sourcemap.js";

// buildBreakdowns pushes exactly ONE samplerCoverageGap note when a step/measure span attributes JS
// (its trace-measured bar shows real js ms) that the CPU sampler never covered (zero pooled samples
// over a window that should have caught >= 2). That is the navigation-reset symptom: the V8 profiler
// resets on each cross-document navigation, so Profiler.stop returns only post-last-navigation
// samples, and an iteration-0 step window before that navigation gets none. See notes.samplerCoverageGap.
//
// Clocks are microseconds on the trace axis (events) and the profile axis (raw), which share
// base::TimeTicks, so a sample's absolute ts = startTime + Σ timeDeltas is directly comparable to a
// span window. sampleIntervalUs 1000 => intervalMs 1, so the >= 2-expected-samples threshold is
// js.ms >= 2.
const INTERVAL_US = 1000;
const MAIN_PID = 100;
const MAIN_TID = 200;

// One driver step "boot", window [0, 30ms], carrying 10ms of real JS (a FunctionCall) on the main
// thread. run:start on the same thread with in-window layout so mainThread() resolves via marker (no
// heuristic note), keeping the note set to samplerCoverageGap alone.
function stepEvents() {
  const on = (event) => ({ ...event, pid: MAIN_PID, tid: MAIN_TID });
  return [
    on({ id: 0, name: "wpd:run:start", ts: 0, dur: 0, ph: "R", kind: "usertiming" }),
    on({ id: 1, name: "RunTask", ts: 0, dur: 30000, ph: "X", kind: "task" }),
    on({ id: 2, name: "Layout", ts: 1000, dur: 500, ph: "X", kind: "layout" }),
    on({ id: 3, name: "FunctionCall", ts: 5000, dur: 10000, ph: "X", kind: "scripting" }),
  ];
}

const bootStep = {
  index: 0,
  label: "boot",
  perIteration: [30],
  wallMs: 30,
  inpMs: null,
  interaction: null,
  startTs: 0,
  endTs: 30000,
};

const RUN_WINDOW = { startTs: 0, endTs: 100000 };

// A 12-sample profile of one rankable user frame (node: url keeps resolution fully offline). The only
// difference between the two cases is startTime, which slides the whole sample block relative to the
// step window: after it (the sampler never reached the step) vs. inside it (the sampler covered it).
function rawProfile(startTime) {
  const root = { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 };
  const appfn = { functionName: "appfn", scriptId: "1", url: "node:app", lineNumber: 0, columnNumber: 0 };
  return {
    startTime,
    endTime: startTime + 12000,
    nodes: [
      { id: 1, callFrame: root, children: [2] },
      { id: 2, callFrame: appfn, children: [] },
    ],
    samples: Array(12).fill(2),
    timeDeltas: Array(12).fill(1000),
  };
}

function contextWith(notes) {
  return {
    serverUrl: "http://127.0.0.1:1",
    root: os.tmpdir(),
    maps: new SourceMapResolver(),
    notes,
    sampleIntervalUs: INTERVAL_US,
  };
}

const isCoverageGap = (note) =>
  note.includes("The V8 CPU profiler resets on each cross-document navigation");

test("buildBreakdowns: a step the sampler never reached pushes exactly one samplerCoverageGap note", async () => {
  // First sample lands at 41ms (startTime 40ms + first 1ms delta), well past the step's [0,30ms]
  // window, so the step's pooled hot samples are 0 while its bar still shows 10ms of js.
  const notes = [];
  const breakdowns = await buildBreakdowns(
    stepEvents(),
    rawProfile(40000),
    RUN_WINDOW,
    [bootStep],
    contextWith(notes),
  );

  const step = breakdowns.find((bar) => bar.kind === "step" && bar.label === "boot");
  assert.ok(step, "the boot step bar was built");
  assert.ok(step.breakdown.slices.js.ms >= 2, "the step bar attributes real js (>= 2 expected samples)");
  assert.equal(step.hot.pooledSamples, 0, "the sampler landed no samples in the step window");
  assert.equal(step.hot.suppressed, true, "so its per-span hot list is suppressed");

  const gapNotes = notes.filter(isCoverageGap);
  assert.equal(gapNotes.length, 1, "exactly one samplerCoverageGap note");
  assert.match(gapNotes[0], /1 step\/measure span/, "and it names the one affected span");
});

test("buildBreakdowns: a step the sampler DID cover pushes no samplerCoverageGap note", async () => {
  // Same profile, startTime 0: the 12 samples now fall at 1..12ms, inside the step's [0,30ms] window,
  // so the sampler covered it and there is no gap to disclose.
  const notes = [];
  const breakdowns = await buildBreakdowns(
    stepEvents(),
    rawProfile(0),
    RUN_WINDOW,
    [bootStep],
    contextWith(notes),
  );

  const step = breakdowns.find((bar) => bar.kind === "step" && bar.label === "boot");
  assert.ok(step, "the boot step bar was built");
  assert.notEqual(step.hot.pooledSamples, 0, "the sampler covered the step window");

  assert.equal(notes.filter(isCoverageGap).length, 0, "no samplerCoverageGap note");
});
