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

// --- not-available CPU windowing for a non-run span ---

test("query span <step>: hot is null on a step span (per-span CPU windowing is not reconstructed)", async () => {
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
      functions: [{ id: 0, fn: "render", package: "app", selfMs: 6, selfPct: 100, totalMs: 6 }],
      breakdown: breakdown(7),
    }),
    "utf8",
  );
  const anatomy = await captureJson(() => querySpan(file, "step:open", { json: true }));
  assert.equal(anatomy.kind, "step");
  assert.ok(anatomy.slices, "the step still has its stored bar");
  assert.equal(anatomy.hot, null, "hot is not-available for a step span even when a CPU model exists");
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
