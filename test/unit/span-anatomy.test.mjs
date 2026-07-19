import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { querySpan } from "../../dist/commands/query.js";
import { tmpDir } from "./helpers.mjs";

// `query span <label>`: one span's full anatomy. These pin the JSON contract -- the bar present vs
// rung-honest null, Measured counts, the kind-collision listing, and the not-available CPU windowing
// for a non-run span -- against the compiled command.

const slice = (ms) => ({ ms });
const jsSlice = (ms, byPackage = {}) => ({ ms, byPackage });
const breakdown = (wallMs) => ({
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

// A measured 0 stays 0; a not-measured field is null (--breakdown drops the `.stack` forced count).
const measuredCounts = {
  layoutCount: 5,
  styleCount: 0,
  paintCount: 2,
  forcedLayoutCount: null,
  layoutInvalidations: 3,
  styleInvalidations: null,
  longTaskCount: 1,
};
const nullCounts = {
  layoutCount: null,
  styleCount: null,
  paintCount: null,
  forcedLayoutCount: null,
  layoutInvalidations: null,
  styleInvalidations: null,
  longTaskCount: null,
};

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
  return JSON.parse(out);
}

// --- the bar present, and the run-window hot list from a sibling CPU model ---

test("query span run: the reconciling bar is present, and hot functions come from the sibling CPU model", async () => {
  const file = writeRec("anatomy-bd.json", {
    meta: { schemaVersion: "3", target: "chrome", iterations: 2, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      {
        label: "run",
        kind: "run",
        aggregation: "sum",
        wallMs: 7,
        counts: measuredCounts,
        breakdown: breakdown(7),
      },
      {
        label: "open",
        kind: "step",
        index: 0,
        aggregation: "first",
        wallMs: 3,
        counts: measuredCounts,
        breakdown: breakdown(3),
      },
    ],
  });
  writeFileSync(
    path.join(tmpDir, "anatomy-bd.cpu.json"),
    JSON.stringify({
      meta: { schemaVersion: "3", iterations: 2 },
      sampleCount: 120,
      scriptingMs: 12,
      functions: [
        { id: 0, fn: "render", package: "app", selfMs: 8, selfPct: 66, totalMs: 10, file: "src/app.js", source: "src/app.js:5" },
        { id: 1, fn: "diff", package: "react-dom", selfMs: 4, selfPct: 33, totalMs: 4 },
      ],
      breakdown: breakdown(7),
    }),
    "utf8",
  );

  const anatomy = await captureJson(() => querySpan(file, "run", { json: true }));
  assert.equal(anatomy.label, "run");
  assert.equal(anatomy.kind, "run");
  assert.equal(anatomy.aggregation, "sum", "the run window is a total across iterations");
  assert.equal(anatomy.iterations, 2);
  assert.ok(anatomy.slices, "the stored bar yields unified slices");
  assert.ok(anatomy.slices.js.byPackage["react-dom"] > 0, "the js slice keeps its by-package split");
  // The run span's hot list IS the CPU model window (the sampler brackets the whole timed loop).
  assert.ok(anatomy.hot, "hot functions are present for the run span");
  assert.equal(anatomy.hot.scope, "run-window");
  assert.equal(anatomy.hot.functions.length, 2);
  assert.equal(anatomy.hot.functions[0].fn, "render");
});

// --- Measured counts preserved (null vs measured 0) ---

test("query span: counts preserve the Measured contract (null not-measured, 0 measured)", async () => {
  const file = writeRec("anatomy-counts.json", {
    meta: { schemaVersion: "3", target: "chrome", iterations: 1, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      {
        label: "run",
        kind: "run",
        aggregation: "sum",
        wallMs: 7,
        counts: measuredCounts,
        breakdown: breakdown(7),
      },
    ],
  });
  const anatomy = await captureJson(() => querySpan(file, "run", { json: true }));
  assert.equal(anatomy.counts.styleCount, 0, "a measured 0 stays 0");
  assert.equal(anatomy.counts.forcedLayoutCount, null, "not-measured stays null, never a fake 0");
  assert.equal(anatomy.counts.layoutCount, 5);
});

// --- the bar absent on a rung that built none, plus forced attribution from the event log ---

test("query span run (--deep): no bar (slices null), forced read-sites from the event log, no cpu model => hot null", async () => {
  const file = writeRec("anatomy-deep.json", {
    meta: { schemaVersion: "3", target: "chrome", iterations: 1, passes: ["deep"] },
    window: { startTs: 0, endTs: 1000 },
    events: [
      { id: 1, name: "Layout", kind: "layout", ts: 50, dur: 2000, ph: "X", forced: true, at: "src/app.js:10" },
      { id: 2, name: "Layout", kind: "layout", ts: 60, dur: 1000, ph: "X", forced: true, at: "src/app.js:10" },
    ],
    spans: [
      {
        label: "run",
        kind: "run",
        aggregation: "sum",
        wallMs: 12,
        counts: { ...measuredCounts, forcedLayoutCount: 2 },
      },
    ],
  });
  const anatomy = await captureJson(() => querySpan(file, "run", { json: true }));
  assert.equal(anatomy.slices, null, "a --deep run built no reconciling bar: rung-honest null, never a fabricated bar");
  assert.ok(Array.isArray(anatomy.forced) && anatomy.forced.length === 1, "forced read-sites come from the deep event log");
  assert.equal(anatomy.forced[0].at, "src/app.js:10");
  assert.equal(anatomy.forced[0].count, 2, "both flushes at the line roll up");
  assert.ok(anatomy.thrash, "a --deep run carries a thrash rollup (count 0 when nothing thrashed)");
  assert.equal(anatomy.hot, null, "no sibling CPU model on --deep => hot is not available");
});

// --- not-available CPU windowing for a non-run span without stored hot refs ---

test("query span <step>: hot is null on a step span with no stored refs (e.g. a rung with no per-span tally)", async () => {
  const file = writeRec("anatomy-step.json", {
    meta: { schemaVersion: "3", target: "chrome", iterations: 2, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      { label: "run", kind: "run", aggregation: "sum", wallMs: 7, counts: measuredCounts, breakdown: breakdown(7) },
      { label: "open", kind: "step", index: 0, aggregation: "first", wallMs: 3, counts: measuredCounts, breakdown: breakdown(3) },
    ],
  });
  writeFileSync(
    path.join(tmpDir, "anatomy-step.cpu.json"),
    JSON.stringify({
      meta: { schemaVersion: "3", iterations: 2 },
      sampleCount: 50,
      scriptingMs: 6,
      sampleIntervalUs: 200,
      functions: [{ id: 0, fn: "render", package: "app", selfMs: 6, selfPct: 100, totalMs: 6 }],
      breakdown: breakdown(7),
    }),
    "utf8",
  );
  const anatomy = await captureJson(() => querySpan(file, "step:open", { json: true }));
  assert.equal(anatomy.kind, "step");
  assert.ok(anatomy.slices, "the step still has its stored bar");
  assert.equal(anatomy.hot, null, "no stored refs => hot is not-available for the step span");
});

// --- a step/measure span with stored hot refs resolves them via the sibling CpuModel ---

test("query span <measure>: stored hot refs resolve to span-local shares via the sibling CpuModel", async () => {
  const file = writeRec("anatomy-meashot.json", {
    meta: { schemaVersion: "3", target: "chrome", iterations: 4, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      { label: "run", kind: "run", aggregation: "sum", wallMs: 7, counts: measuredCounts, breakdown: breakdown(7) },
      {
        label: "work",
        kind: "measure",
        aggregation: "median",
        wallMs: 3,
        samples: 4,
        counts: nullCounts,
        breakdown: breakdown(3),
        // pooled 40 ranked JS samples across 4 occurrences: id 0 = 30, id 1 = 10.
        hot: {
          scope: "measure-pooled",
          pooledSamples: 40,
          occurrences: 4,
          functions: [
            { id: 0, samples: 30, selfMs: 6 },
            { id: 1, samples: 10, selfMs: 2 },
          ],
        },
      },
    ],
  });
  writeFileSync(
    path.join(tmpDir, "anatomy-meashot.cpu.json"),
    JSON.stringify({
      meta: { schemaVersion: "3", iterations: 4 },
      sampleCount: 500,
      scriptingMs: 50,
      sampleIntervalUs: 200,
      functions: [
        { id: 0, fn: "thrash", package: "app", selfMs: 40, selfPct: 80, totalMs: 45, file: "src/app.js", source: "src/app.js:5" },
        { id: 1, fn: "churn", package: "app", selfMs: 10, selfPct: 20, totalMs: 10 },
      ],
      breakdown: breakdown(7),
    }),
    "utf8",
  );
  const anatomy = await captureJson(() => querySpan(file, "measure:work", { json: true }));
  assert.equal(anatomy.hot.scope, "measure-pooled");
  assert.equal(anatomy.hot.pooledSamples, 40);
  assert.equal(anatomy.hot.occurrences, 4, "the pooled occurrence count is disclosed");
  assert.equal(anatomy.hot.scriptingMs, 8, "pooledSamples * interval = 40 * 200us = 8ms of span-local scripting");
  assert.equal(anatomy.hot.functions.length, 2);
  // Identity from the model, self time SPAN-LOCAL (share of the span's pooled samples, not run-wide).
  assert.equal(anatomy.hot.functions[0].fn, "thrash", "name resolved via the sibling CpuModel");
  assert.equal(anatomy.hot.functions[0].source, "src/app.js:5");
  assert.equal(anatomy.hot.functions[0].selfMs, 6, "span-local selfMs from the stored ref, not the model's 40");
  assert.equal(anatomy.hot.functions[0].selfPct, 75, "share of pooled samples: 30/40");
  assert.equal(anatomy.hot.functions[1].selfPct, 25, "share of pooled samples: 10/40");
});

test("query span <measure>: a suppressed hot tally reports the floor honestly, no fabricated functions", async () => {
  const file = writeRec("anatomy-suphot.json", {
    meta: { schemaVersion: "3", target: "chrome", iterations: 5, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      { label: "run", kind: "run", aggregation: "sum", wallMs: 7, counts: measuredCounts, breakdown: breakdown(7) },
      {
        label: "trivial",
        kind: "measure",
        aggregation: "median",
        wallMs: 1,
        samples: 5,
        counts: nullCounts,
        breakdown: breakdown(1),
        hot: { scope: "measure-pooled", pooledSamples: 4, occurrences: 5, suppressed: true },
      },
    ],
  });
  writeFileSync(
    path.join(tmpDir, "anatomy-suphot.cpu.json"),
    JSON.stringify({
      meta: { schemaVersion: "3", iterations: 5 },
      sampleCount: 20,
      scriptingMs: 4,
      sampleIntervalUs: 200,
      functions: [{ id: 0, fn: "noop", package: "app", selfMs: 4, selfPct: 100, totalMs: 4 }],
      breakdown: breakdown(7),
    }),
    "utf8",
  );
  const anatomy = await captureJson(() => querySpan(file, "measure:trivial", { json: true }));
  assert.equal(anatomy.hot.suppressed, true, "below the pooled floor: suppressed, never a top-N from noise");
  assert.equal(anatomy.hot.functions, undefined, "no functions when suppressed");
  assert.equal(anatomy.hot.pooledSamples, 4, "the floor's evidence is disclosed for the raise-iterations hint");
});

// --- kind collision: a bare label matching more than one kind is refused, the qualified form works ---

test("query span: a bare label colliding across kinds lists the matches and asks for kind:label", async () => {
  const file = writeRec("anatomy-collide.json", {
    meta: { schemaVersion: "3", target: "chrome", iterations: 1, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      { label: "dup", kind: "run", aggregation: "sum", wallMs: 1, counts: nullCounts, breakdown: breakdown(1) },
      { label: "dup", kind: "measure", aggregation: "first", wallMs: 1, counts: nullCounts, breakdown: breakdown(1) },
    ],
  });
  await assert.rejects(
    () => querySpan(file, "dup", { json: true }),
    /matches 2 spans of different kinds.*run:dup.*measure:dup/s,
    "a bare collision names both qualified forms",
  );
  // The qualified form resolves to exactly one span.
  const anatomy = await captureJson(() => querySpan(file, "run:dup", { json: true }));
  assert.equal(anatomy.kind, "run");
  assert.equal(anatomy.label, "dup");
});

test("query span: an unknown label errors, listing the available spans", async () => {
  const file = writeRec("anatomy-miss.json", {
    meta: { schemaVersion: "3", target: "chrome", iterations: 1, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [{ label: "run", kind: "run", aggregation: "sum", wallMs: 1, counts: nullCounts, breakdown: breakdown(1) }],
  });
  await assert.rejects(() => querySpan(file, "nope", { json: true }), /No span 'nope'.*run:run/s);
});
