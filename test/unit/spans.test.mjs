import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildSpans,
  recordingLane,
  spanAggregation,
  gateSliceBudgets,
  diffSpanSlices,
  resolveSpanSelector,
} from "../../dist/model/spans.js";
import { querySpans } from "../../dist/commands/query.js";
import { tmpDir } from "./helpers.mjs";

// --- Fixtures: the two stored breakdown shapes the adapter folds into one ---

const slice = (ms) => ({ ms });
const jsSlice = (ms, byPackage = {}) => ({ ms, byPackage });

// A chrome --breakdown recording: seven-slice SpanBreakdowns, every slice measured. The measure
// span also carries a frame side track (chrome-only), which must survive the adapter.
const chromeBreakdown = (wallMs) => ({
  wallMs,
  slices: {
    js: jsSlice(1, { "react-dom": 0.6, app: 0.4 }),
    style: slice(0.1),
    layout: slice(0.2),
    paint: slice(0.05),
    gc: slice(0.02),
    other: slice(0.03),
    idle: slice(wallMs - 1.4),
  },
});
const chromeBreakdowns = [
  { label: "run", kind: "run", breakdown: chromeBreakdown(7) },
  {
    label: "inp",
    kind: "measure",
    breakdown: chromeBreakdown(1.2),
    frames: { presented: 1, presentedPartial: 0, dropped: 0, noUpdate: 0, total: 1, frames: [] },
  },
];

// A firefox CpuModel.breakdown: six slices (js/style/layout/browser/gc/idle), no paint concept.
const firefoxCpu = {
  wallMs: 21.8,
  slices: {
    js: jsSlice(5, { "(native)": 3.1, "@emotion/hash": 0.9 }),
    style: slice(0.5),
    layout: slice(7),
    browser: slice(4.3),
    gc: slice(0),
    idle: slice(5),
  },
};

// Firefox WITH user measures: stored as seven-slice Breakdowns on Recording.breakdowns, paint
// not-measured (null) -- paint is off-main-thread on firefox, so the bar says so, never a fake 0.
const firefoxMeasureBreakdowns = [
  {
    label: "run",
    kind: "run",
    breakdown: {
      wallMs: 20,
      slices: {
        js: jsSlice(5),
        style: slice(1),
        layout: slice(2),
        paint: null,
        gc: slice(0),
        other: slice(1),
        idle: slice(11),
      },
    },
  },
  {
    label: "work",
    kind: "measure",
    breakdown: {
      wallMs: 3,
      slices: {
        js: jsSlice(2),
        style: slice(0.2),
        layout: slice(0.3),
        paint: null,
        gc: slice(0),
        other: slice(0.1),
        idle: slice(0.4),
      },
    },
  },
];

// A node CPU-only model: four slices (js/browser/gc/idle) -- no DOM, so style/layout are not split.
const nodeCpu = {
  wallMs: 10,
  slices: {
    js: jsSlice(8, { "react-dom": 5, app: 3 }),
    browser: slice(1),
    gc: slice(0.5),
    idle: slice(0.5),
  },
};

const SUPERSET_KEYS = ["gc", "idle", "js", "layout", "other", "paint", "style"];

// --- The unified shape: superset keys on every lane ---

test("buildSpans: chrome breakdowns yield the superset shape, all slices measured, frames pass through", () => {
  const result = buildSpans(chromeBreakdowns, undefined, "chrome");
  assert.equal(result.source, "breakdowns");
  assert.equal(result.target, "chrome");
  assert.equal(result.spans.length, 2);

  const run = result.spans.find((span) => span.kind === "run");
  assert.deepEqual(Object.keys(run.slices).sort(), SUPERSET_KEYS);
  // Chrome measures every slice, so none is the not-measured null.
  for (const key of ["style", "layout", "paint"])
    assert.notEqual(run.slices[key], null, `${key} is measured on chrome`);
  assert.ok(run.slices.js.byPackage["react-dom"] > 0, "js keeps its by-package split");

  const inp = result.spans.find((span) => span.kind === "measure");
  assert.ok(inp.frames, "the frame side track survives the adapter");
});

// The aggregation contract: a recording mixes span kinds with different iteration semantics, so
// every entry must self-declare what its numbers represent. run = a total over the loop ("sum");
// step/measure = one iteration ("first"). iterations is stamped from the recording meta.
test("buildSpans: aggregation is per-kind (run=sum, step/measure=first) and iterations propagates", () => {
  const bars = [
    { label: "run", kind: "run", breakdown: chromeBreakdown(7) },
    { label: "open", kind: "step", breakdown: chromeBreakdown(3) },
    { label: "inp", kind: "measure", breakdown: chromeBreakdown(1.2) },
  ];
  const result = buildSpans(bars, undefined, "chrome", 7);
  const byKind = Object.fromEntries(result.spans.map((span) => [span.kind, span]));
  assert.equal(byKind.run.aggregation, "sum", "the run window spans every iteration => a total");
  assert.equal(byKind.step.aggregation, "first", "a step is windowed to the first iteration");
  assert.equal(byKind.measure.aggregation, "first", "a measure keeps its first in-window occurrence");
  for (const span of result.spans)
    assert.equal(span.iterations, 7, "iterations is stamped on every span from the recording meta");
});

test("spanAggregation: run is a sum, step and measure are first; a repeated measure is a median", () => {
  assert.equal(spanAggregation("run"), "sum");
  assert.equal(spanAggregation("step"), "first");
  assert.equal(spanAggregation("measure"), "first", "a single-occurrence measure is its first pair");
  assert.equal(spanAggregation("measure", 1), "first", "one sample is still first, not median");
  assert.equal(spanAggregation("measure", 4), "median", "a repeated measure reports its median sample");
  assert.equal(spanAggregation("run", 4), "sum", "the run span is a sum regardless of samples");
  assert.equal(spanAggregation("step", 4), "first", "a step never becomes a median");
});

test("buildSpans: a merged measure surfaces aggregation median + samples + wall spread", () => {
  const bars = [
    { label: "run", kind: "run", breakdown: chromeBreakdown(20) },
    {
      label: "inp:frame",
      kind: "measure",
      breakdown: chromeBreakdown(3),
      samples: 5,
      wallMinMs: 1,
      wallMaxMs: 9,
    },
  ];
  const result = buildSpans(bars, undefined, "chrome", 5);
  const measure = result.spans.find((span) => span.kind === "measure");
  assert.equal(measure.aggregation, "median", "the merged bar declares itself a median pick");
  assert.equal(measure.samples, 5, "samples counts real occurrences");
  assert.equal(measure.wallMinMs, 1, "the wall spread min passes through");
  assert.equal(measure.wallMaxMs, 9, "the wall spread max passes through");
  assert.ok(measure.wallMinMs <= measure.wallMs && measure.wallMs <= measure.wallMaxMs, "wall is within the spread");
  // The run span carries no merge fields (unique label), so it is untouched.
  const run = result.spans.find((span) => span.kind === "run");
  assert.equal(run.samples, undefined, "the run span carries no samples field");
  assert.equal(run.aggregation, "sum");
});

test("buildSpans: an old-shape measure (no samples) loads as aggregation first, no fabricated spread", () => {
  const bars = [{ label: "work", kind: "measure", breakdown: chromeBreakdown(3) }];
  const measure = buildSpans(bars, undefined, "chrome", 3).spans[0];
  assert.equal(measure.aggregation, "first", "no samples field => the old first-occurrence contract");
  assert.equal(measure.samples, undefined, "no samples field is invented");
  assert.equal(measure.wallMinMs, undefined, "no spread is fabricated");
  assert.equal(measure.wallMaxMs, undefined);
});

test("buildSpans: the CpuModel-synthesized run span is a sum; iterations defaults to 1", () => {
  const one = buildSpans(undefined, firefoxCpu, "firefox");
  assert.equal(one.spans[0].aggregation, "sum", "a synthesized run bar brackets the whole timed loop");
  assert.equal(one.spans[0].iterations, 1, "iterations defaults to 1 when the caller omits it");
  const many = buildSpans(undefined, firefoxCpu, "firefox", 5);
  assert.equal(many.spans[0].iterations, 5, "an explicit iteration count reaches the synthesized span");
  assert.equal(many.spans[0].aggregation, "sum");
});

test("buildSpans: firefox CpuModel bar synthesizes the run span; paint is not-measured (null), never 0", () => {
  const result = buildSpans(undefined, firefoxCpu, "firefox");
  assert.equal(result.source, "cpu-model");
  assert.equal(result.spans.length, 1);

  const run = result.spans[0];
  assert.equal(run.label, "run");
  assert.equal(run.kind, "run");
  assert.deepEqual(Object.keys(run.slices).sort(), SUPERSET_KEYS);
  // Firefox splits style/layout, so they are measured.
  assert.equal(run.slices.style.ms, 0.5);
  assert.equal(run.slices.layout.ms, 7);
  // A CpuModel bar carries no main-thread paint concept: null, NOT a fabricated 0.
  assert.equal(run.slices.paint, null);
  // browser -> the unified `other`.
  assert.equal(run.slices.other.ms, 4.3);
  assert.equal(run.wallMs, 21.8);
});

test("buildSpans: firefox stored measure breakdowns win over the CpuModel bar; paint is not-measured (null)", () => {
  // Both a stored breakdowns array AND a cpu bar exist; the richer stored bars must be preferred.
  const result = buildSpans(firefoxMeasureBreakdowns, firefoxCpu, "firefox");
  assert.equal(result.source, "breakdowns");
  const work = result.spans.find((span) => span.label === "work");
  assert.ok(work, "the user performance.measure span is present");
  // F04: adding a performance.measure must NOT turn firefox paint into a measured 0. Paint is
  // off-main-thread on firefox, so a stored bar reports it not-measured (null), same as the
  // synthesized run bar -- never a fake 0 that a --max-slice paint gate would pass on.
  assert.equal(work.slices.paint, null);
  const run = result.spans.find((span) => span.label === "run");
  assert.equal(run.slices.paint, null, "the firefox run stored bar is also not-measured");
});

test("buildSpans: node CPU-only model splits nothing it cannot see; style/layout/paint are null, not 0", () => {
  const result = buildSpans(undefined, nodeCpu, "node");
  assert.equal(result.source, "cpu-model");
  const run = result.spans[0];
  assert.equal(run.slices.style, null, "node does not split style");
  assert.equal(run.slices.layout, null, "node does not split layout");
  assert.equal(run.slices.paint, null, "node has no main-thread paint");
  // The slices it CAN measure stay real numbers (incl. a real 0), never nulled.
  assert.equal(run.slices.js.ms, 8);
  assert.equal(run.slices.gc.ms, 0.5);
});

test("buildSpans: an old recording with neither bars nor a cpu model returns null", () => {
  assert.equal(buildSpans(undefined, undefined, "chrome"), null);
  assert.equal(buildSpans([], undefined, "chrome"), null, "an empty breakdowns array is still nothing");
});

test("buildSpans: never empty when any bar exists (the run span is always synthesized)", () => {
  // Empty stored breakdowns must fall back to the cpu bar rather than come back empty.
  assert.ok(buildSpans([], firefoxCpu, "firefox").spans.length >= 1);
  assert.ok(buildSpans(undefined, nodeCpu, "node").spans.length >= 1);
  assert.equal(buildSpans([], nodeCpu, "node").spans[0].kind, "run");
});

test("recordingLane: the engine axis comes from browser/runtime, not meta.target", () => {
  // meta.target holds the recorded module path, so the lane must be derived from browser/runtime.
  assert.equal(recordingLane({ browser: "firefox" }), "firefox");
  assert.equal(recordingLane({ runtime: "node" }), "node");
  assert.equal(recordingLane({}), "chrome", "absent browser/runtime => the chrome default");
  assert.equal(recordingLane({ runtime: "chrome" }), "chrome");
});

// --- F32: span selectors and joins key on kind+label, so a user measure named "run" never
// collides with the run span ---

// A SpanEntry with just the slice(s) a budget/diff reads.
const spanEntry = (label, kind, jsMs) => ({
  label,
  kind,
  wallMs: 10,
  aggregation: spanAggregation(kind),
  iterations: 1,
  slices: {
    js: jsSlice(jsMs),
    style: slice(0), layout: slice(0), paint: slice(0), gc: slice(0), other: slice(0), idle: slice(10 - jsMs),
  },
});

test("resolveSpanSelector: a bare label colliding across kinds errors, listing the qualified forms (F32)", () => {
  const spans = [spanEntry("run", "run", 5), spanEntry("run", "measure", 2)];
  assert.throws(() => resolveSpanSelector(spans, "run"), /matches 2 spans of different kinds.*run:run.*measure:run/s);
  // The qualified form picks exactly one.
  assert.equal(resolveSpanSelector(spans, "measure:run").kind, "measure");
  assert.equal(resolveSpanSelector(spans, "run:run").kind, "run");
});

test("resolveSpanSelector: a bare label that is unambiguous still resolves (F32)", () => {
  const spans = [spanEntry("run", "run", 5), spanEntry("mount", "step", 3)];
  assert.equal(resolveSpanSelector(spans, "mount").kind, "step");
  assert.equal(resolveSpanSelector(spans, "run").kind, "run");
});

test("gateSliceBudgets: a colliding bare label errors instead of gating the wrong span (F32)", () => {
  const spans = [spanEntry("run", "run", 5), spanEntry("run", "measure", 2)];
  assert.throws(() => gateSliceBudgets(spans, { js: 3 }, "run"), /qualified form/);
  // The qualified selector gates exactly the measure span (js 2 <= 3 => ok).
  const [gate] = gateSliceBudgets(spans, { js: 3 }, "measure:run");
  assert.equal(gate.ok, true);
  assert.equal(gate.value, 2);
});

test("diffSpanSlices: joins on kind+label, never crossing a measure 'run' with the run span (F32)", () => {
  const base = [spanEntry("run", "run", 5), spanEntry("run", "measure", 2)];
  const current = [spanEntry("run", "run", 6), spanEntry("run", "measure", 2)];
  const diff = diffSpanSlices(base, current);
  const labels = diff.spans.map((span) => span.label).sort();
  assert.deepEqual(labels, ["measure:run", "run:run"], "both spans matched by kind+label, displayed qualified");
  const runSpan = diff.spans.find((span) => span.label === "run:run");
  assert.equal(runSpan.slices.find((slice) => slice.slice === "js").delta, 1, "run js 5→6 = +1");
  const measureSpan = diff.spans.find((span) => span.label === "measure:run");
  assert.equal(measureSpan.slices.find((slice) => slice.slice === "js").delta, 0, "measure js 2→2 = 0, not crossed");
});

// --- The command: --label filtering, the never-empty guarantee, and the empty-case error ---

function writeRec(name, recording) {
  const file = path.join(tmpDir, name);
  writeFileSync(file, JSON.stringify(recording), "utf8");
  return file;
}

async function captureJson(runner) {
  const priorLog = console.log;
  let out = "";
  console.log = (line) => {
    out += `${line}\n`;
  };
  try {
    await runner();
  } finally {
    console.log = priorLog;
  }
  return out;
}

test("query spans --label keeps the exact match; a miss is an empty array, not an error", async () => {
  const file = writeRec("spans-chrome.json", {
    meta: { schemaVersion: "3", target: "chrome", iterations: 4 },
    spans: chromeBreakdowns,
  });

  const hit = JSON.parse(await captureJson(() => querySpans(file, { json: true, label: "inp" })));
  assert.equal(hit.spans.length, 1);
  assert.equal(hit.spans[0].label, "inp");
  // meta.iterations reaches the entry, and a measure span declares itself the first occurrence.
  assert.equal(hit.spans[0].iterations, 4, "iterations comes from the recording meta");
  assert.equal(hit.spans[0].aggregation, "first", "a measure span is the first in-window occurrence");

  const miss = JSON.parse(await captureJson(() => querySpans(file, { json: true, label: "nope" })));
  assert.equal(miss.spans.length, 0, "a label miss is an empty array (consumer decides), not a throw");
});

test("query spans synthesizes the run span from a sibling cpu model (never empty when a bar exists)", async () => {
  const file = writeRec("spans-ff.json", {
    meta: { schemaVersion: "3", target: "firefox", browser: "firefox" },
    spans: [],
  });
  // loadCpuModel finds `<base>.cpu.json` beside the recording; it must carry a functions array.
  writeFileSync(
    path.join(tmpDir, "spans-ff.cpu.json"),
    JSON.stringify({ meta: { schemaVersion: "3" }, functions: [], breakdown: firefoxCpu }),
    "utf8",
  );
  const parsed = JSON.parse(await captureJson(() => querySpans(file, { json: true })));
  assert.equal(parsed.source, "cpu-model");
  assert.ok(parsed.spans.length >= 1);
  assert.equal(parsed.spans[0].label, "run");
  assert.equal(parsed.spans[0].slices.paint, null);
});

test("query spans errors (non-zero) on a recording that holds no bar at all", async () => {
  const file = writeRec("spans-no-bar.json", {
    meta: { schemaVersion: "3", target: "chrome" },
    spans: [],
  });
  await assert.rejects(() => querySpans(file, { json: true }), /no per-span breakdown/);
});

// F35: a CORRUPT sibling CPU model must surface, not be swallowed into "no per-span breakdown" (which
// reads as a capture mode that never sampled). Only the ENOCPUMODEL "no model here" case is the empty case.
test("query spans surfaces a corrupt sibling cpu model instead of reporting 'no breakdown' (F35)", async () => {
  const file = writeRec("spans-corrupt-sibling.json", {
    meta: { schemaVersion: "3", target: "chrome" },
    spans: [],
  });
  writeFileSync(path.join(tmpDir, "spans-corrupt-sibling.cpu.json"), "{ this is not valid json", "utf8");
  await assert.rejects(
    () => querySpans(file, { json: true }),
    (error) => {
      assert.doesNotMatch(error.message, /no per-span breakdown/, "corrupt must not read as 'no breakdown'");
      return true;
    },
  );
});
