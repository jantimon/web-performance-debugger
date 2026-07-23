import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { querySpan } from "../../dist/commands/query.js";
import { tmpDir } from "./helpers.mjs";

// `query span <label>`: one span's full anatomy. These pin the JSON contract -- the bar present vs
// capture-mode-honest null, Measured counts, the kind-collision listing, and the not-available CPU windowing
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

/** Capture the human report (no --json) as one string, for asserting presentation notes. */
async function captureText(runner) {
  const priorLog = console.log;
  let out = "";
  console.log = (line = "") => {
    out += `${line}\n`;
  };
  try {
    await runner();
  } finally {
    console.log = priorLog;
  }
  return out;
}

// --- the bar present, and the run-window hot list from a sibling CPU model ---

test("query span run: the reconciling bar is present, and hot functions come from the sibling CPU model", async () => {
  const file = writeRec("anatomy-bd.json", {
    meta: { schemaVersion: "4", target: "chrome", iterations: 2, passes: ["breakdown"] },
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
      meta: { schemaVersion: "4", iterations: 2 },
      sampleCount: 120,
      jsSelfMs: 12,
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

// --- a step's headline wall is the median, the bar's own window is the iteration-0 window ---

// The bar tiles iteration 0 only; on an outlier iteration 0 (a retry inside the timed action) that
// window can be ~70x the step's median. The headline everywhere must be the median (span.wallMs); the
// bar's iteration-0 window rides breakdownWallMs and is labeled as such, so the two never conflate.
function divergentStepRec(name) {
  return writeRec(name, {
    meta: { schemaVersion: "4", target: "chrome", iterations: 3, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      { label: "run", kind: "run", aggregation: "sum", wallMs: 40, counts: measuredCounts, breakdown: breakdown(40) },
      {
        label: "add rows",
        kind: "step",
        index: 0,
        aggregation: "first",
        // median of the three samples; iteration 0 (2023.43) was an outlier the bar tiles.
        wallMs: 16.03,
        perIteration: [15, 16.03, 2023.43],
        counts: measuredCounts,
        breakdown: breakdown(2023.43),
      },
    ],
  });
}

test("query span <step>: the JSON headline is the median wall, with the iteration-0 window on breakdownWallMs", async () => {
  const file = divergentStepRec("anatomy-step-median.json");
  const anatomy = await captureJson(() => querySpan(file, "step:add rows", { json: true }));
  assert.equal(anatomy.kind, "step");
  assert.equal(anatomy.wallMs, 16.03, "the headline is the median, never the 2023.43 ms iteration-0 window");
  assert.equal(anatomy.breakdownWallMs, 2023.43, "the bar's own window is disclosed separately");
});

test("query span <step>: the human wall line shows the median and the provenance tag describes it truthfully", async () => {
  const file = divergentStepRec("anatomy-step-median-text.json");
  const text = await captureText(() => querySpan(file, "step:add rows", {}));
  assert.match(text, /wall: 16\.03 ms.*median of 3 samples/, "the median rides the wall line, and the tag names it");
  assert.doesNotMatch(text, /wall: 2023\.4/, "the iteration-0 window is never the headline wall");
  // The bar names its own window the iteration-0 window, so it is not read as the step's cost.
  assert.match(text, /iteration-0 window 2023\.4 ms/, "the bar labels its tiled window explicitly");
  // The idle-share tag is a property of the tiled window, so it never rides the median wall line.
  assert.doesNotMatch(text, /window, not work/, "no idle-share tag beside a median the window does not describe");
});

// --- Measured counts preserved (null vs measured 0) ---

test("query span: counts preserve the Measured contract (null not-measured, 0 measured)", async () => {
  const file = writeRec("anatomy-counts.json", {
    meta: { schemaVersion: "4", target: "chrome", iterations: 1, passes: ["breakdown"] },
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

// --- the bar absent in a capture mode that built none, plus forced attribution from the event log ---

test("query span run (--deep): no bar (slices null), forced read-sites from the event log, no cpu model => hot null", async () => {
  const file = writeRec("anatomy-deep.json", {
    meta: { schemaVersion: "4", target: "chrome", iterations: 1, passes: ["deep"] },
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
  assert.equal(anatomy.slices, null, "a --deep run built no reconciling bar: capture-mode-honest null, never a fabricated bar");
  assert.ok(Array.isArray(anatomy.forced) && anatomy.forced.length === 1, "forced read-sites come from the deep event log");
  assert.equal(anatomy.forced[0].at, "src/app.js:10");
  assert.equal(anatomy.forced[0].count, 2, "both flushes at the line roll up");
  assert.ok(anatomy.thrash, "a --deep run carries a thrash rollup (count 0 when nothing thrashed)");
  assert.equal(anatomy.hot, null, "no sibling CPU model on --deep => hot is not available");
});

// --- not-available CPU windowing for a non-run span without stored hot refs ---

test("query span <step>: hot is null on a step span with no stored refs (e.g. a capture mode with no per-span tally)", async () => {
  const file = writeRec("anatomy-step.json", {
    meta: { schemaVersion: "4", target: "chrome", iterations: 2, passes: ["breakdown"] },
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
      meta: { schemaVersion: "4", iterations: 2 },
      sampleCount: 50,
      jsSelfMs: 6,
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
    meta: { schemaVersion: "4", target: "chrome", iterations: 4, passes: ["breakdown"] },
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
      meta: { schemaVersion: "4", iterations: 4 },
      sampleCount: 500,
      jsSelfMs: 50,
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
    meta: { schemaVersion: "4", target: "chrome", iterations: 5, passes: ["breakdown"] },
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
      meta: { schemaVersion: "4", iterations: 5 },
      sampleCount: 20,
      jsSelfMs: 4,
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
  assert.equal(anatomy.hot.suppressionReason, "below-floor", "a thin-but-nonzero pool: raise --iterations is the honest fix");
});

// A step window with real JS in its bar but ZERO pooled samples is the navigation coverage gap: the
// V8 sampler reset on a cross-document navigation, so this pre-navigation window carries no samples.
// The suppressed tally must say `not-covered`, NEVER "below-floor"/raise-iterations (which cannot help).
test("query span <step>: a zero-pool tally over a JS-bearing window reports not-covered, not raise-iterations", async () => {
  const file = writeRec("anatomy-uncovered.json", {
    meta: { schemaVersion: "4", target: "chrome", iterations: 3, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      { label: "run", kind: "run", aggregation: "sum", wallMs: 7, counts: measuredCounts, breakdown: breakdown(7) },
      {
        label: "search",
        kind: "step",
        index: 0,
        aggregation: "first",
        wallMs: 60,
        counts: measuredCounts,
        // 40 ms of JS in the bar, but the sampler covered none of it.
        breakdown: {
          wallMs: 60,
          slices: {
            js: { ms: 40, byPackage: {} },
            style: { ms: 1 }, layout: { ms: 1 }, paint: { ms: 1 },
            gc: { ms: 0 }, other: { ms: 6 }, idle: { ms: 11 },
          },
        },
        hot: { scope: "step-window", pooledSamples: 0, occurrences: 1, suppressed: true },
      },
    ],
  });
  writeFileSync(
    path.join(tmpDir, "anatomy-uncovered.cpu.json"),
    JSON.stringify({
      meta: { schemaVersion: "4", iterations: 3 },
      sampleCount: 300,
      jsSelfMs: 60,
      sampleIntervalUs: 200,
      functions: [{ id: 0, fn: "render", package: "app", selfMs: 60, selfPct: 100, totalMs: 60 }],
      breakdown: breakdown(7),
    }),
    "utf8",
  );
  const anatomy = await captureJson(() => querySpan(file, "step:search", { json: true }));
  assert.equal(anatomy.hot.suppressed, true);
  assert.equal(anatomy.hot.pooledSamples, 0);
  assert.equal(
    anatomy.hot.suppressionReason,
    "not-covered",
    "40 ms of JS with zero samples is a sampler coverage gap, not a thin pool",
  );
});

// The other zero-pool case: a window that genuinely ran no JS. Nothing to rank, and NOT a coverage
// gap, so the reason is `no-js` (never "below-floor", never "not-covered").
test("query span <measure>: a zero-pool tally over an idle window reports no-js", async () => {
  const file = writeRec("anatomy-idle.json", {
    meta: { schemaVersion: "4", target: "chrome", iterations: 3, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      { label: "run", kind: "run", aggregation: "sum", wallMs: 7, counts: measuredCounts, breakdown: breakdown(7) },
      {
        label: "wait",
        kind: "measure",
        aggregation: "median",
        wallMs: 50,
        samples: 3,
        counts: nullCounts,
        breakdown: {
          wallMs: 50,
          slices: {
            js: { ms: 0, byPackage: {} },
            style: { ms: 0 }, layout: { ms: 0 }, paint: { ms: 0 },
            gc: { ms: 0 }, other: { ms: 0 }, idle: { ms: 50 },
          },
        },
        hot: { scope: "measure-pooled", pooledSamples: 0, occurrences: 3, suppressed: true },
      },
    ],
  });
  writeFileSync(
    path.join(tmpDir, "anatomy-idle.cpu.json"),
    JSON.stringify({
      meta: { schemaVersion: "4", iterations: 3 },
      sampleCount: 300,
      jsSelfMs: 60,
      sampleIntervalUs: 200,
      functions: [{ id: 0, fn: "render", package: "app", selfMs: 60, selfPct: 100, totalMs: 60 }],
      breakdown: breakdown(7),
    }),
    "utf8",
  );
  const anatomy = await captureJson(() => querySpan(file, "measure:wait", { json: true }));
  assert.equal(anatomy.hot.suppressionReason, "no-js", "an idle window ran nothing to rank");
});

// --- kind collision: a bare label matching more than one kind is refused, the qualified form works ---

test("query span: a bare label colliding across kinds lists the matches and asks for kind:label", async () => {
  const file = writeRec("anatomy-collide.json", {
    meta: { schemaVersion: "4", target: "chrome", iterations: 1, passes: ["breakdown"] },
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
    meta: { schemaVersion: "4", target: "chrome", iterations: 1, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [{ label: "run", kind: "run", aggregation: "sum", wallMs: 1, counts: nullCounts, breakdown: breakdown(1) }],
  });
  await assert.rejects(() => querySpan(file, "nope", { json: true }), /No span 'nope'.*run:run/s);
});

// --- presentation: the one-frame floor surfaces the sub-frame spread (frame-floor.md) ---

test("query span: a wall/INP median at the frame floor surfaces the min sample and js slice", async () => {
  const file = writeRec("anatomy-floor.json", {
    // new-headless => 16.6ms one-frame floor; the median pins to it, the min sample escapes it.
    meta: {
      schemaVersion: "4",
      target: "chrome",
      iterations: 5,
      passes: ["breakdown"],
      headless: true,
      headlessMode: "new",
    },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      {
        label: "inp:frame",
        kind: "measure",
        aggregation: "median",
        wallMs: 16.6,
        counts: nullCounts,
        breakdown: breakdown(16.6),
        inpMs: 16.6,
        stats: { samples: 5, minMs: 2.7, medianMs: 16.6, meanMs: 13.8, maxMs: 16.7 },
      },
    ],
  });
  const text = await captureText(() => querySpan(file, "inp:frame", {}));
  assert.match(text, /wall sits on the ~16\.6 ms frame floor/, "names the floor under wall");
  assert.match(text, /min sample 2\.7 ms/, "surfaces the faster sample the median hid");
  assert.match(text, /js 1 ms/, "surfaces the js slice as the sub-frame work signal");
  assert.match(text, /INP sits on the ~16\.6 ms one-frame floor/, "names the floor under INP");
});

test("query span: real sub-frame-or-above work prints no floor note", async () => {
  const file = writeRec("anatomy-nofloor.json", {
    meta: {
      schemaVersion: "4",
      target: "chrome",
      iterations: 5,
      passes: ["breakdown"],
      headless: true,
      headlessMode: "new",
    },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      {
        label: "heavy",
        kind: "measure",
        aggregation: "median",
        wallMs: 25,
        counts: nullCounts,
        breakdown: breakdown(25),
        stats: { samples: 5, minMs: 24, medianMs: 25, meanMs: 25, maxMs: 26 },
      },
    ],
  });
  const text = await captureText(() => querySpan(file, "heavy", {}));
  assert.doesNotMatch(text, /one-frame floor/, "25ms is real work above the frame, not floored");
});

// --- presentation: firefox forced count carries the marker-derived / sampled-site caveat ---

test("query span: firefox forced count discloses it is marker-derived with a sampled read site", async () => {
  const firefoxCounts = { ...nullCounts, forcedLayoutCount: 1 };
  const file = writeRec("anatomy-ffforced.json", {
    meta: {
      schemaVersion: "4",
      target: "firefox",
      browser: "firefox",
      iterations: 1,
      passes: ["gecko"],
      headless: true,
    },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      {
        label: "mount",
        kind: "measure",
        aggregation: "first",
        wallMs: 8,
        counts: firefoxCounts,
        breakdown: breakdown(8),
      },
    ],
  });
  const text = await captureText(() => querySpan(file, "mount", {}));
  assert.match(text, /forced layout\/style is marker-derived/, "names the count provenance");
  assert.match(text, /sampled estimate.*can miss cheap reads/s, "warns the site can be missed");
});

// --- Defect: a measure span's bar shows real style/layout/paint ms but its counts are not windowed ---

test("query span <measure>: discloses that counts are not windowed to a performance.measure span", async () => {
  const file = writeRec("anatomy-measure-counts.json", {
    meta: { schemaVersion: "4", target: "chrome", iterations: 1, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      { label: "run", kind: "run", aggregation: "sum", wallMs: 30, counts: measuredCounts, breakdown: breakdown(30) },
      {
        label: "render list",
        kind: "measure",
        aggregation: "first",
        wallMs: 12,
        counts: nullCounts,
        breakdown: breakdown(12),
      },
    ],
  });
  const text = await captureText(() => querySpan(file, "measure:render list", {}));
  assert.match(text, /counts are not windowed to a performance\.measure span/, "the disclosure prints");
  // The bar is present with real style/layout ms while the counts table reads "—": the disclosure is
  // the bridge, not a fabricated count.
  assert.match(text, /style recalc\s+—/, "counts still read not-measured, never a fake 0");
});

test("query span <measure>: no disclosure over an all-idle bar (no real style/layout/paint to explain)", async () => {
  const idleBar = (wallMs) => ({
    wallMs,
    slices: {
      js: jsSlice(0),
      style: slice(0),
      layout: slice(0),
      paint: slice(0),
      gc: slice(0),
      other: slice(0),
      idle: slice(wallMs),
    },
  });
  const file = writeRec("anatomy-measure-idle.json", {
    meta: { schemaVersion: "4", target: "chrome", iterations: 1, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      { label: "wait", kind: "measure", aggregation: "first", wallMs: 20, counts: nullCounts, breakdown: idleBar(20) },
    ],
  });
  const text = await captureText(() => querySpan(file, "measure:wait", {}));
  assert.doesNotMatch(
    text,
    /counts are not windowed to a performance\.measure span/,
    "an all-idle bar measured no style/layout/paint, so there is no contradiction to disclose",
  );
});

// --- Defect: the per-frame jank flood collapses to one line by default, expands under --frames ---

// A consistent FrameSideTrack: `frames[]` lists every frame, the tallies are its derived counts.
// Three of the six are jank (2 dropped + 1 smoothness-affecting partial); the three clean presented
// frames are the rest. On a real page `frames[]` runs to dozens, which is the flood being collapsed.
const frameRecords = [
  { sequence: 10, state: "presented", affectsSmoothness: false, durMs: 8 },
  { sequence: 11, state: "dropped", affectsSmoothness: true, durMs: 22 },
  { sequence: 12, state: "dropped", affectsSmoothness: true, durMs: 19 },
  { sequence: 13, state: "presentedPartial", affectsSmoothness: true, durMs: 17 },
  { sequence: 14, state: "presented", affectsSmoothness: false, durMs: 7 },
  { sequence: 15, state: "presented", affectsSmoothness: false, durMs: 9 },
];
const jankFrames = {
  presented: 3,
  presentedPartial: 1,
  dropped: 2,
  noUpdate: 0,
  total: 6,
  frames: frameRecords,
};

function frameRec(name) {
  return {
    meta: { schemaVersion: "4", target: "chrome", iterations: 1, passes: ["breakdown"] },
    window: { startTs: 0, endTs: 100 },
    events: [],
    spans: [
      {
        label: "scroll",
        kind: "measure",
        aggregation: "first",
        wallMs: 40,
        counts: nullCounts,
        breakdown: breakdown(40),
        frames: jankFrames,
      },
    ],
  };
}

test("query span: the frame side track collapses jank to one line by default", async () => {
  const file = writeRec("anatomy-frames-default.json", frameRec());
  const text = await captureText(() => querySpan(file, "scroll", {}));
  assert.match(text, /frames: 3 presented · 1 partial · 2 dropped/, "the tally line stays");
  assert.match(text, /3 frame\(s\) dropped or affecting smoothness/, "one summary line, not one per frame");
  assert.doesNotMatch(text, /⚠ frame 11:/, "no per-frame line by default");
  assert.match(text, /--frames to list each/, "points at the opt-in");
});

test("query span --frames: lists each dropped/smoothness-affecting frame", async () => {
  const file = writeRec("anatomy-frames-verbose.json", frameRec());
  const text = await captureText(() => querySpan(file, "scroll", { frames: true }));
  assert.match(text, /⚠ frame 11: dropped/, "each jank frame prints under --frames");
  assert.match(text, /⚠ frame 12: dropped/);
  assert.match(text, /⚠ frame 13: presentedPartial/);
  assert.doesNotMatch(text, /frame\(s\) dropped or affecting smoothness/, "no summary line when expanded");
});

test("query span --json: the frame track keeps every per-frame record regardless of --frames", async () => {
  const file = writeRec("anatomy-frames-json.json", frameRec());
  const anatomy = await captureJson(() => querySpan(file, "scroll", { json: true }));
  assert.equal(anatomy.frames.frames.length, 6, "JSON carries the full per-frame data");
  assert.equal(anatomy.frames.dropped, 2);
});
