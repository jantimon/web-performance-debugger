import { test } from "node:test";
import assert from "node:assert/strict";

// Tests run against the compiled output (pretest builds it). No browser needed.
import { classify, invalidationKind } from "../dist/trace/classify.js";
import { computeStats, buildSummary } from "../dist/metrics/summarize.js";
import { forcedLayouts, longTasks, markForced } from "../dist/trace/analysis.js";
import { serialize, deserialize } from "../dist/output/format.js";
import { buildCpuModel, packageRollup, functionJoinKey } from "../dist/profile/cpuprofile.js";
import { diffCmd } from "../dist/commands/diff.js";
import { assertCmd } from "../dist/commands/assert.js";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION } from "../dist/index.js";

test("classify maps trace event names to kinds", () => {
  assert.equal(classify("Layout", ""), "layout");
  assert.equal(classify("UpdateLayoutTree", ""), "style");
  assert.equal(classify("Paint", ""), "paint");
  assert.equal(classify("RunTask", ""), "task");
  assert.equal(classify("LayoutInvalidationTracking", ""), "invalidation");
  assert.equal(classify("Whatever", "blink.user_timing"), "usertiming");
  assert.equal(classify("Nope", ""), "other");
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

test("buildSummary prefers CDP counts, falls back to trace", () => {
  const events = [
    { id: 0, name: "Layout", ts: 1, dur: 2000, ph: "X", kind: "layout" },
    { id: 1, name: "Paint", ts: 2, dur: 1000, ph: "X", kind: "paint" },
  ];
  const withCdp = buildSummary({ detailEvents: events, detailWindowStart: null, cdpDelta: { LayoutCount: 7 } });
  assert.equal(withCdp.layoutCount, 7); // CDP wins
  assert.equal(withCdp.paintCount, 1); // trace
  const noCdp = buildSummary({ detailEvents: events, detailWindowStart: null, cdpDelta: {} });
  assert.equal(noCdp.layoutCount, 1); // trace fallback
});

test("serialize/deserialize round-trips json and toon", () => {
  const obj = { a: 1, b: [{ x: 1 }, { x: 2 }], c: "hi" };
  assert.deepEqual(deserialize(serialize(obj, "json"), ".json"), obj);
  assert.deepEqual(deserialize(serialize(obj, "toon"), ".toon"), obj);
});

test("public entrypoint exposes the schema version anchor", () => {
  assert.equal(SCHEMA_VERSION, "1");
});

test("package exports map points at files that exist", () => {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
  const root = pkg.exports["."];
  for (const target of [root.types, root.import]) {
    const resolved = fileURLToPath(new URL(target, pkgUrl));
    assert.doesNotThrow(() => readFileSync(resolved), `missing exports target ${target}`);
  }
});

test("published types declare the documented public shapes", () => {
  const dts = readFileSync(new URL("../dist/index.d.ts", import.meta.url), "utf8");
  for (const name of ["CpuModel", "CpuOverview", "BlameEntry", "CpuDiffResult", "RawCpuProfile", "LastPointer"]) {
    assert.match(dts, new RegExp(`\\b${name}\\b`), `index.d.ts should re-export ${name}`);
  }
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

// A synthetic V8 profile: root -> alpha -> beta -> alpha (direct recursion), plus idle and gc.
// node: urls keep frame resolution fully offline (no sourcemap/fs I/O).
function syntheticProfile() {
  const sys = (functionName) => ({ functionName, scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 });
  const app = (functionName, lineNumber) => ({ functionName, scriptId: "1", url: "node:app", lineNumber, columnNumber: 0 });
  return {
    startTime: 0,
    endTime: 8500,
    nodes: [
      { id: 1, callFrame: sys("(root)"), children: [2, 5, 6] },
      { id: 2, callFrame: app("alpha", 0), children: [3] },
      { id: 3, callFrame: app("beta", 10), children: [4] },
      { id: 4, callFrame: app("alpha", 0), children: [] },
      { id: 5, callFrame: sys("(idle)") },
      { id: 6, callFrame: sys("(garbage collector)") },
    ],
    samples: [4, 3, 2, 5, 6],
    timeDeltas: [1000, 2000, 500, 4000, 1000],
  };
}

test("buildCpuModel: self/total time, recursion-safe totals, system buckets, edges", async () => {
  const model = await buildCpuModel(syntheticProfile(), {
    profilePath: "synthetic.cpuprofile",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
    sampleIntervalUs: 50,
    root: os.tmpdir(),
    runtime: "node",
  });

  // scripting = all sampled self time minus idle: (1000+2000+500+1000) / 1000
  assert.equal(model.scriptingMs, 4.5);
  assert.equal(model.system.idleMs, 4);
  assert.equal(model.system.gcMs, 1);

  // ranked by self time desc: beta (2.0) before alpha (1.5)
  assert.equal(model.functions.length, 2);
  const beta = model.functions.find((fn) => fn.fn === "beta");
  const alpha = model.functions.find((fn) => fn.fn === "alpha");
  assert.equal(beta.selfMs, 2);
  assert.equal(beta.totalMs, 3);
  assert.equal(alpha.selfMs, 1.5); // 0.5 (outer) + 1.0 (recursed inner)
  // total counts the alpha subtree ONCE despite the recursion (3.5, not 4.5)
  assert.equal(alpha.totalMs, 3.5);

  // both frames are node: urls => one "(node)" package bucket
  const rollup = packageRollup(model);
  assert.equal(rollup.length, 1);
  assert.equal(rollup[0].key, "(node)");
  assert.equal(rollup[0].selfMs, 3.5);
  assert.equal(rollup[0].functions, 2);

  // edges only between ranked functions (root/idle/gc dropped, not rerouted)
  assert.equal(model.edges.length, 2);
});

test("functionJoinKey joins on file, not source line (cpu-diff stays stable across line shifts)", () => {
  const before = { fn: "render", file: "src/app.js", source: "src/app.js:40", package: "app" };
  const after = { fn: "render", file: "src/app.js", source: "src/app.js:47", package: "app" };
  assert.equal(functionJoinKey(before), functionJoinKey(after));
  assert.equal(functionJoinKey(before), "render src/app.js");
});

// --- CI-gating paths: write minimal recordings to a temp dir and drive the real commands. ---
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "wpd-test-"));

function writeRecording(name, summaryOverrides) {
  const summary = {
    wallMs: null, inpMs: null, scriptingMs: 0,
    layoutCount: 0, styleCount: 0, paintCount: 0, compositeCount: 0,
    forcedLayoutCount: 0, layoutInvalidations: 0, paintInvalidations: 0, styleInvalidations: 0,
    longTaskCount: 0, totalEvents: 0, perIteration: [], stats: null,
    ...summaryOverrides,
  };
  const file = path.join(tmpDir, name);
  writeFileSync(file, JSON.stringify({ summary }), "utf8");
  return file;
}

// Run a command with console.log silenced and process.exitCode isolated; returns the exit code.
async function captureExitCode(run) {
  const priorExit = process.exitCode;
  const priorLog = console.log;
  process.exitCode = undefined;
  console.log = () => {};
  try {
    await run();
    return process.exitCode;
  } finally {
    console.log = priorLog;
    process.exitCode = priorExit;
  }
}

test("diff: advisory wall/INP/scripting deltas do NOT fail the gate (H1)", async () => {
  const baseline = writeRecording("base-advisory.json", { wallMs: 10, inpMs: 5, scriptingMs: 20 });
  const current = writeRecording("cur-advisory.json", { wallMs: 99, inpMs: 88, scriptingMs: 77 });
  const code = await captureExitCode(() => diffCmd(baseline, current, { failOnRegression: true }));
  assert.equal(code, undefined); // coarse metrics regressed, but they are advisory-only
});

test("diff: a real CDP count regression DOES fail the gate", async () => {
  const baseline = writeRecording("base-count.json", { layoutCount: 1 });
  const current = writeRecording("cur-count.json", { layoutCount: 9 });
  const code = await captureExitCode(() => diffCmd(baseline, current, { failOnRegression: true }));
  assert.equal(code, 1);
});

test("assert: a threshold on a not-measured metric FAILS (does not silently pass)", async () => {
  const rec = writeRecording("assert-null-inp.json", { inpMs: null });
  const code = await captureExitCode(() => assertCmd(rec, { inp: 100 }));
  assert.equal(code, 1);
});

test("assert: a satisfied threshold on a measured metric passes", async () => {
  const rec = writeRecording("assert-ok.json", { forcedLayoutCount: 0 });
  const code = await captureExitCode(() => assertCmd(rec, { forced: 0 }));
  assert.equal(code, undefined);
});
