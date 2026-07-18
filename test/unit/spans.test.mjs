import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildSpans, recordingLane } from "../../dist/model/spans.js";
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

// Firefox WITH user measures: stored as seven-slice Breakdowns on Recording.breakdowns, paint a
// MEASURED 0 (off-main-thread, genuinely no main-thread paint) -- distinct from not-measured.
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
        paint: slice(0),
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
        paint: slice(0),
        gc: slice(0),
        other: slice(0.1),
        idle: slice(0.4),
      },
    },
  },
];

// A node rung-1 model: four slices (js/browser/gc/idle) -- no DOM, so style/layout are not split.
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

test("buildSpans: firefox stored measure breakdowns win over the CpuModel bar; paint is a measured 0", () => {
  // Both a stored breakdowns array AND a cpu bar exist; the richer stored bars must be preferred.
  const result = buildSpans(firefoxMeasureBreakdowns, firefoxCpu, "firefox");
  assert.equal(result.source, "breakdowns");
  const work = result.spans.find((span) => span.label === "work");
  assert.ok(work, "the user performance.measure span is present");
  // On firefox stored bars, paint is a MEASURED 0 (off-thread), distinct from the synthesized-null.
  assert.notEqual(work.slices.paint, null);
  assert.equal(work.slices.paint.ms, 0);
});

test("buildSpans: node rung-1 model splits nothing it cannot see; style/layout/paint are null, not 0", () => {
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
  const file = writeRec("spans-chrome.json", { meta: { target: "chrome" }, breakdowns: chromeBreakdowns });

  const hit = JSON.parse(await captureJson(() => querySpans(file, { json: true, label: "inp" })));
  assert.equal(hit.spans.length, 1);
  assert.equal(hit.spans[0].label, "inp");

  const miss = JSON.parse(await captureJson(() => querySpans(file, { json: true, label: "nope" })));
  assert.equal(miss.spans.length, 0, "a label miss is an empty array (consumer decides), not a throw");
});

test("query spans synthesizes the run span from a sibling cpu model (never empty when a bar exists)", async () => {
  const file = writeRec("spans-ff.json", { meta: { target: "firefox", browser: "firefox" } });
  // loadCpuModel finds `<base>.cpu.json` beside the recording; it must carry a functions array.
  writeFileSync(
    path.join(tmpDir, "spans-ff.cpu.json"),
    JSON.stringify({ functions: [], breakdown: firefoxCpu }),
    "utf8",
  );
  const parsed = JSON.parse(await captureJson(() => querySpans(file, { json: true })));
  assert.equal(parsed.source, "cpu-model");
  assert.ok(parsed.spans.length >= 1);
  assert.equal(parsed.spans[0].label, "run");
  assert.equal(parsed.spans[0].slices.paint, null);
});

test("query spans errors (non-zero) on a recording that holds no bar at all", async () => {
  const file = writeRec("spans-old.json", { meta: { target: "chrome" } });
  await assert.rejects(() => querySpans(file, { json: true }), /no per-span breakdown/);
});
