import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCpuModel,
  windowCumulativeCpuProfile,
  packageRollup,
} from "../../dist/profile/cpuprofile.js";
import { cpuDiffCmd } from "../../dist/commands/cpudiff.js";
import { SCHEMA_VERSION } from "../../dist/schema.js";
import { breakdownProfile, tmpDir, captureExitCode } from "./helpers.mjs";

const sys = (functionName) => ({
  functionName,
  scriptId: "0",
  url: "",
  lineNumber: -1,
  columnNumber: -1,
});
const frame = (functionName, url, lineNumber) => ({
  functionName,
  scriptId: "1",
  url,
  lineNumber,
  columnNumber: 0,
});

// A single-stream (node inspector) profile shaped like the real no-op capture: the FIRST sample lands
// on `post (node:inspector)` ~9 ms after profiler start (the sampler-startup prefix, spent before the
// first run()), carrying the whole prefix as timeDeltas[0]; the real run() samples follow at 200us
// A single-stream timeDeltas[i] is the gap from the previous sample, so timeDeltas[0] IS the prefix
function nodeProfileWithStartPrefix() {
  return {
    startTime: 0,
    endTime: 10000,
    nodes: [
      { id: 1, callFrame: sys("(root)"), children: [2, 3] },
      { id: 2, callFrame: frame("post", "node:inspector", 0), children: [] },
      { id: 3, callFrame: frame("run", "node:app", 5), children: [] },
    ],
    // sample 0 = post at ts 9333 (prefix); samples 1..3 = run() at 9533/9733/9933
    samples: [2, 3, 3, 3],
    timeDeltas: [9333, 200, 200, 200],
  };
}

// The real no-op capture: the loop ran under one sampling interval, so the ONLY sample is the
// out-of-window profiler-start prefix on `post (node:inspector)`. A correct window keeps nothing
function nodeNoopProfile() {
  return {
    startTime: 0,
    endTime: 9500,
    nodes: [
      { id: 1, callFrame: sys("(root)"), children: [2] },
      { id: 2, callFrame: frame("post", "node:inspector", 0), children: [] },
    ],
    samples: [2],
    timeDeltas: [9333],
  };
}

// B-01: the profiler-start prefix must not be attributed to the first observed frame
test("windowCumulativeCpuProfile drops the start prefix off the first frame (B-01)", async () => {
  const raw = nodeProfileWithStartPrefix();

  // Unwindowed, the whole profile bills the ~9 ms prefix to `post (node:inspector)`: the defect
  const before = await buildCpuModel(raw, {
    profilePath: "x.cpuprofile",
    meta: { schemaVersion: SCHEMA_VERSION },
    sampleIntervalUs: 200,
    root: os.tmpdir(),
    runtime: "node",
  });
  const postBefore = before.functions.find((fn) => fn.fn === "post");
  assert.ok(postBefore && postBefore.selfMs > 9, "unwindowed: the start prefix lands on post (the defect)");

  // The application window is the timed loop [9333, 9933] on the profiler's clock: it begins at the
  // prefix sample (ts 9333, taken during Profiler.start, before run()) and covers the run() samples
  const windowed = windowCumulativeCpuProfile(raw, 9333, 9933);

  // Self time per node on the windowed profile: the prefix frame (node 2) gets nothing
  const selfUsByNode = new Map();
  for (let index = 0; index < windowed.samples.length; index++)
    selfUsByNode.set(
      windowed.samples[index],
      (selfUsByNode.get(windowed.samples[index]) ?? 0) + windowed.timeDeltas[index],
    );
  assert.equal(selfUsByNode.get(2) ?? 0, 0, "the prefix frame gets no self-time after windowing");
  assert.ok((selfUsByNode.get(3) ?? 0) > 0, "in-window run() work survives");

  const after = await buildCpuModel(windowed, {
    profilePath: "x.cpuprofile",
    meta: { schemaVersion: SCHEMA_VERSION },
    sampleIntervalUs: 200,
    root: os.tmpdir(),
    runtime: "node",
  });
  const postAfter = after.functions.find((fn) => fn.fn === "post");
  assert.ok(!postAfter || postAfter.selfMs === 0, "windowed: no prefix lands on post");
  // totalMs equals the window width, reconciling with the loop's own bounds
  assert.equal(after.totalMs, 0.6, "totalMs is the window width (600us), not the prefixed span");
});

// A near-no-op window (loop ran <1 sampling interval, so the only sample is the out-of-window prefix)
// windows to an empty profile: 0 samples, jsSelfMs 0. This is the honest answer, not a phantom
test("windowCumulativeCpuProfile: a no-op window drops every out-of-window sample (B-01)", async () => {
  const raw = nodeNoopProfile();
  // The whole no-op loop ran in [9400, 9420], after the out-of-window prefix sample (ts 9333)
  const windowed = windowCumulativeCpuProfile(raw, 9400, 9420);
  assert.equal(windowed.samples.length, 0, "a no-op window keeps no samples");
  const model = await buildCpuModel(windowed, {
    profilePath: "x.cpuprofile",
    meta: { schemaVersion: SCHEMA_VERSION },
    sampleIntervalUs: 200,
    root: os.tmpdir(),
    runtime: "node",
  });
  assert.equal(model.jsSelfMs, 0, "a no-op profile reports 0 JS self-time, never the prefix");
});

// B-02: the JS self-time headline equals the axis its package rollup tiles, so the shares reconcile
test("jsSelfMs is the package-rollup denominator and reconciles to 100% (B-02)", async () => {
  // breakdownProfile: react-dom (js 1ms) + app (js 2ms) + idle 3ms + gc 1.5ms + (program) 0.5ms
  const model = await buildCpuModel(breakdownProfile(), {
    profilePath: "x.cpuprofile",
    meta: { schemaVersion: SCHEMA_VERSION },
    sampleIntervalUs: 200,
    root: os.tmpdir(),
  });

  const rollup = packageRollup(model);
  const rollupSelf = rollup.reduce((sum, entry) => sum + entry.selfMs, 0);
  // The headline IS the sum of the package rows (JS-only), so they reconcile exactly
  assert.ok(Math.abs(rollupSelf - model.jsSelfMs) < 1e-9, "package rows sum to jsSelfMs");
  const rollupPct = rollup.reduce((sum, entry) => sum + entry.selfPct, 0);
  assert.ok(Math.abs(rollupPct - 100) < 1e-6, "the package shares add to 100%");

  // jsSelfMs is JS-only; activeMs is the non-idle total, so it is strictly larger here (gc + program)
  assert.equal(model.jsSelfMs, 3, "jsSelfMs excludes gc and engine work (react-dom 1 + app 2)");
  assert.equal(model.activeMs, 5, "activeMs is the non-idle sampled total (js 3 + gc 1.5 + program 0.5)");
  assert.ok(model.jsSelfMs < model.activeMs, "the JS headline is not the non-idle total");
});

/** Write a minimal CpuModel fixture the way cpu-diff reads it (jsSelfMs + a single function) */
function writeModel(name, jsSelfMs, activeMs, functions) {
  const model = {
    profile: `${name}.cpuprofile`,
    meta: { tool: "wpd", version: "0", schemaVersion: SCHEMA_VERSION, capture: "node-cpu", iterations: 1, target: "a.mjs", runtime: "node" },
    sampleCount: 1,
    sampleIntervalUs: 200,
    totalMs: activeMs,
    jsSelfMs,
    activeMs,
    system: { idleMs: 0, gcMs: activeMs - jsSelfMs, programMs: 0 },
    functions,
    edges: [],
  };
  const file = path.join(tmpDir, name);
  writeFileSync(file, JSON.stringify(model), "utf8");
  return file;
}

const runFn = (selfMs) => [
  { id: 0, fn: "run", source: "a.mjs:1", file: "a.mjs", package: "app", selfMs, totalMs: selfMs, selfPct: 100 },
];

// B-02 gate policy: a change that is entirely gc/native (jsSelfMs unchanged) must not trip the JS gate
test("cpu-diff: a gc/native-only change does not trip the JS-self gate (B-02)", async () => {
  const base = writeModel("cpudiff-gc-base.cpu.json", 10, 10, runFn(10));
  // Same JS self-time, but the non-idle total ballooned by 30 ms of gc
  const current = writeModel("cpudiff-gc-cur.cpu.json", 10, 40, runFn(10));
  const code = await captureExitCode(() => cpuDiffCmd(base, current, { failOnRegression: true }));
  assert.equal(code, undefined, "a pure gc/native delta is not a JS regression");
});

// B-01 consequence: two identical near-no-op profiles must not manufacture a regression verdict
test("cpu-diff: two identical no-op profiles produce no regression (B-01)", async () => {
  const base = writeModel("cpudiff-noop-base.cpu.json", 0, 0, []);
  const current = writeModel("cpudiff-noop-cur.cpu.json", 0, 0, []);
  const code = await captureExitCode(() => cpuDiffCmd(base, current, { failOnRegression: true }));
  assert.equal(code, undefined, "identical no-op runs are not a regression");
});

/** Write a CpuModel with a chosen sampler interval, so the resolving floor (10 samples) can be varied */
function writeModelAt(name, jsSelfMs, sampleIntervalUs) {
  const model = {
    profile: `${name}.cpuprofile`,
    meta: { tool: "wpd", version: "0", schemaVersion: SCHEMA_VERSION, capture: "node-cpu", iterations: 1, target: "a.mjs", runtime: "node" },
    sampleCount: 1,
    sampleIntervalUs,
    totalMs: jsSelfMs,
    jsSelfMs,
    activeMs: jsSelfMs,
    system: { idleMs: 0, gcMs: 0, programMs: 0 },
    functions: runFn(jsSelfMs),
    edges: [],
  };
  const file = path.join(tmpDir, name);
  writeFileSync(file, JSON.stringify(model), "utf8");
  return file;
}

/** Run cpu-diff --format json, returning { code, result } with console.log captured */
async function runDiff(base, current, opts = {}) {
  const priorLog = console.log;
  const priorExit = process.exitCode;
  const lines = [];
  console.log = (line) => lines.push(line);
  process.exitCode = undefined;
  try {
    await cpuDiffCmd(base, current, { failOnRegression: true, format: "json", ...opts });
    return { code: process.exitCode, result: JSON.parse(lines.join("\n")) };
  } finally {
    console.log = priorLog;
    process.exitCode = priorExit;
  }
}

// Resolving floor: below 10 samples of JS self-time on BOTH sides, a net delta is quantization, not
// signal, so the JS-self gate does not fire and the output discloses it. At 200us that floor is 2ms
test("cpu-diff resolving floor: both sides below the floor do not gate, with a disclosure note", async () => {
  // 0.4 -> 1.6ms is a +1.2ms net (> the 0.5ms noise floor), but both sit under the 2ms resolving floor
  const base = writeModelAt("cpudiff-floor-below-base.cpu.json", 0.4, 200);
  const current = writeModelAt("cpudiff-floor-below-cur.cpu.json", 1.6, 200);
  const { code, result } = await runDiff(base, current);
  assert.equal(code, undefined, "below resolving power, the net delta is not a regression");
  assert.ok(result.netJsSelfMs > 0.5, "the raw net delta still clears the 0.5ms noise floor");
  assert.equal(result.notes.length, 1, "a single disclosure note is carried");
  assert.match(result.notes[0], /resolving floor/, "the note names the resolving floor");
  assert.match(result.notes[0], /not evaluable at this scale/, "the note says the gate is not evaluable");
  assert.match(result.notes[0], /~2ms at the recorded interval/, "the note states the floor ms at the recorded interval");
});

test("cpu-diff resolving floor: one side above the floor gates normally, no note", async () => {
  // current is 5ms (above the 2ms floor), so the delta is real signal and the gate fires
  const base = writeModelAt("cpudiff-floor-above-base.cpu.json", 0.4, 200);
  const current = writeModelAt("cpudiff-floor-above-cur.cpu.json", 5, 200);
  const { code, result } = await runDiff(base, current);
  assert.equal(code, 1, "with one side above resolving power, a regression gates");
  assert.equal(result.notes.length, 0, "no resolving-floor note when the gate is evaluable");
});

test("cpu-diff resolving floor: a side sitting exactly at the floor counts as resolvable (gates)", async () => {
  // base == 2.0ms == the floor: the below-floor test is strict `<`, so exactly-at-the-floor is NOT
  // below, the gate is evaluable, and a real +1ms regression fires
  const base = writeModelAt("cpudiff-floor-boundary-base.cpu.json", 2.0, 200);
  const current = writeModelAt("cpudiff-floor-boundary-cur.cpu.json", 3.0, 200);
  const { code, result } = await runDiff(base, current);
  assert.equal(code, 1, "a side at exactly the floor is resolvable, so the regression gates");
  assert.equal(result.notes.length, 0, "no note when a side sits at (not below) the floor");
});

test("cpu-diff resolving floor: differing intervals use the LARGER implied floor", async () => {
  // base at a 1000us interval (~firefox) implies a 10ms floor; current at 200us implies 2ms. Both
  // sides (3ms, 8ms) sit under the LARGER 10ms floor, so the +5ms net does not gate. Had the smaller
  // 2ms floor won, both would read above it and the gate would fire on quantization
  const base = writeModelAt("cpudiff-floor-interval-base.cpu.json", 3, 1000);
  const current = writeModelAt("cpudiff-floor-interval-cur.cpu.json", 8, 200);
  const { code, result } = await runDiff(base, current);
  assert.equal(code, undefined, "the larger implied floor (10ms) covers both sides, so no gate");
  assert.equal(result.notes.length, 1, "the disclosure note is carried");
  assert.match(result.notes[0], /~10ms at the recorded interval/, "the note reports the larger implied floor");
});
