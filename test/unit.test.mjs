import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Tests run against the compiled output (pretest builds it). No browser needed.
import { classify, invalidationKind } from "../dist/trace/classify.js";
import { computeStats, buildSummary } from "../dist/metrics/summarize.js";
import { forcedLayouts, longTasks, markForced } from "../dist/trace/analysis.js";
import { serialize, deserialize } from "../dist/output/format.js";
import {
  buildCpuModel,
  packageRollup,
  functionJoinKey,
  DEFAULT_CPU_INTERVAL_US,
} from "../dist/profile/cpuprofile.js";
import {
  parseGeckoLocation,
  parseGecko,
  geckoToRawCpuProfile,
  geckoToRenderingEvents,
} from "../dist/profile/gecko.js";
import { attachStacks } from "../dist/trace/stacks.js";
import { SourceMapResolver } from "../dist/trace/sourcemap.js";
import { findWindow } from "../dist/trace/parse.js";
import { labelWindows, mergeSteps } from "../dist/trace/steps.js";
import { diffCmd } from "../dist/commands/diff.js";
import { assertCmd } from "../dist/commands/assert.js";
import { countProvenance } from "../dist/commands/summaryView.js";
import { blameSemanticFor, noteCountScope } from "../dist/commands/record.js";
import { capsFor } from "../dist/browser/backend.js";
import { interactionBreakdown } from "../dist/browser/driver.js";
import { createServer } from "node:http";
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

// Driver steps are heterogeneous ("mount" vs "inp"), so the ONLY meaningful aggregation is each
// step against itself. A median pooled across steps, or leaking into the bench-shaped top-level
// stats, would render a meaningless number as a real one.
test("buildSummary: perStep aggregates each step against itself, never across steps", () => {
  const base = { detailEvents: [], detailWindowStart: null, cdpDelta: {} };
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
    cdpDelta: {},
    perStep: [{ label: "mount", perIteration: [36.7] }],
  });
  // same contract as the bench stats: no statistic below 2 samples, rather than a fake one
  assert.equal(summary.perStep[0].stats, null);
  assert.deepEqual(summary.perStep[0].perIteration, [36.7]);
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
  // StepTiming is the element type of the public RecordingSummary.perStep: without it a consumer
  // cannot name the shape without importing from dist/model/, which this package calls internal.
  for (const name of ["CpuModel", "CpuOverview", "BlameEntry", "CpuDiffResult", "RawCpuProfile", "LastPointer", "StepTiming"]) {
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

// Pseudo-URLs (inline data: modules, blob:, wasm, V8/extension internals) are not on disk.
// They must bucket by scheme, never fs-walk to a stray package.json (which would mis-blame
// them on the tool's own cwd package, as seen profiling blob-iframe SPAs).
function pseudoUrlProfile() {
  const frame = (functionName, url, lineNumber) => ({
    functionName,
    scriptId: "1",
    url,
    lineNumber,
    columnNumber: 0,
  });
  return {
    startTime: 0,
    endTime: 5000,
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 }, children: [2, 3, 4, 5, 6] },
      // an inline ESM data-URI module (the dashboard's own bundle reports like this)
      { id: 2, callFrame: frame("createElement", "data:text/javascript;base64,dmFyIHg9MTs=", 4), children: [] },
      { id: 3, callFrame: frame("render", "blob:null/2737de37-cf4c-4d3e", 0), children: [] },
      { id: 4, callFrame: frame("compiled", "wasm://wasm/88844f8e:1", 0), children: [] },
      { id: 5, callFrame: frame("SafeBuiltins", "extensions::SafeBuiltins", 7), children: [] },
      { id: 6, callFrame: frame("appfn", "node:app", 0), children: [] },
    ],
    samples: [2, 3, 4, 5, 6],
    timeDeltas: [1000, 1000, 1000, 1000, 1000],
  };
}

test("pseudo-URL frames bucket by scheme, never on the cwd package", async () => {
  const model = await buildCpuModel(pseudoUrlProfile(), {
    profilePath: "synthetic.cpuprofile",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
    sampleIntervalUs: 50,
    root: os.tmpdir(),
    runtime: "node",
  });

  const pkgOf = (fnName) => model.functions.find((entry) => entry.fn === fnName)?.package;
  assert.equal(pkgOf("createElement"), "(inline)");
  assert.equal(pkgOf("render"), "(blob)");
  assert.equal(pkgOf("compiled"), "(wasm)");
  assert.equal(pkgOf("SafeBuiltins"), "(native)");
  assert.equal(pkgOf("appfn"), "(node)");

  // the giant base64 payload must not leak into the stored source
  const inline = model.functions.find((entry) => entry.fn === "createElement");
  assert.ok(!inline.source.includes("base64"), "inline source must be trimmed");

  // every bucket is a synthetic "(...)" group; nothing resolved to a real package name
  for (const group of packageRollup(model)) {
    assert.match(group.key, /^\(.+\)$/, `unexpected real package bucket: ${group.key}`);
  }
});

// A minified bundle served over http is the case that matters most and was untested: every
// existing test dodges the remote path via node:/pseudo urls or a dead FIXTURE_ORIGIN. These
// serve real bundles and drive the real fetch.
//
// One segment ("AAAAA" = genCol 0 -> source 0, line 0, col 0, name 0) is enough: a CDP frame at
// lineNumber 0 / columnNumber 0 becomes line 1 / column 1, and resolveFrame looks up line 1,
// column 0 -- exactly this segment.
function sourcemapFor(source, name) {
  return JSON.stringify({
    version: 3,
    file: "bundle.js",
    sources: [source],
    names: [name],
    mappings: "AAAAA",
  });
}

/** Five bundles, each a different sourcemap-acquisition story. */
async function startBundleServer() {
  const routes = {
    // the map is announced by the conventional trailing comment
    "/comment.js": ["function Bh(){}\n//# sourceMappingURL=comment.js.map", {}],
    "/comment.js.map": [sourcemapFor("node_modules/lodash/lodash.js", "lodashInner"), {}],
    // no comment at all: the map is announced ONLY by the response header, as many
    // production builds do (they strip the comment and keep the header)
    "/header.js": ["function zv(){}", { SourceMap: "/header.js.map" }],
    "/header.js.map": [sourcemapFor("node_modules/react-dom/index.js", "reactRender"), {}],
    // resolves, but to app code outside node_modules
    "/app.js": ["function Wl(){}\n//# sourceMappingURL=app.js.map", {}],
    "/app.js.map": [sourcemapFor("src/App.tsx", "AppRoot"), {}],
    // carries no map reference whatsoever
    "/nomap.js": ["function Qk(){}", {}],
    // names a map that is not deployed (404)
    "/brokenmap.js": ["function Xy(){}\n//# sourceMappingURL=gone.js.map", {}],
  };
  const server = createServer((request, response) => {
    const route = routes[request.url];
    if (!route) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    const [body, headers] = route;
    response.writeHead(200, { "content-type": "application/javascript", ...headers });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function remoteBundleProfile(origin) {
  const frame = (functionName, file) => ({
    functionName,
    scriptId: "1",
    url: `${origin}/${file}`,
    lineNumber: 0,
    columnNumber: 0,
  });
  return {
    startTime: 0,
    endTime: 5000,
    nodes: [
      {
        id: 1,
        callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 },
        children: [2, 3, 4, 5, 6],
      },
      { id: 2, callFrame: frame("Bh", "comment.js"), children: [] },
      { id: 3, callFrame: frame("zv", "header.js"), children: [] },
      { id: 4, callFrame: frame("Wl", "app.js"), children: [] },
      { id: 5, callFrame: frame("Qk", "nomap.js"), children: [] },
      { id: 6, callFrame: frame("Xy", "brokenmap.js"), children: [] },
    ],
    samples: [2, 3, 4, 5, 6],
    timeDeltas: [1000, 1000, 1000, 1000, 1000],
  };
}

test("remote sourcemaps resolve packages via comment AND SourceMap header; failures are honest", async () => {
  const server = await startBundleServer();
  try {
    const maps = new SourceMapResolver();
    const model = await buildCpuModel(remoteBundleProfile(server.origin), {
      profilePath: "remote.cpuprofile",
      meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
      sampleIntervalUs: 50,
      // Deliberately NOT the serving origin: makeSourceResolver flags a frame remote only when
      // its url does not start with serverUrl. Passing the real origin would rewrite these to
      // local paths and never exercise the remote path at all.
      serverUrl: "http://127.0.0.1:1",
      root: os.tmpdir(),
      maps,
    });

    const pkgOf = (fnName) => model.functions.find((entry) => entry.fn === fnName)?.package;
    // mapped into node_modules => the real dependency, despite the minified frame name
    assert.equal(pkgOf("lodashInner"), "lodash");
    // ...and the header-only bundle resolves identically
    assert.equal(pkgOf("reactRender"), "react-dom");
    // mapped, but outside node_modules => the app really is the owner
    assert.equal(pkgOf("AppRoot"), "app");

    // Unmapped frames keep their minified names and must NOT be blamed on "app": their owner is
    // genuinely unknown, so they bucket by origin.
    const host = new URL(server.origin).host;
    assert.equal(pkgOf("Qk"), `(${host})`);
    assert.equal(pkgOf("Xy"), `(${host})`);

    // the minified name is kept as a secondary label when the map renamed the function
    assert.equal(model.functions.find((entry) => entry.fn === "lodashInner").minified, "Bh");

    const diagnostics = maps.diagnostics();
    assert.equal(diagnostics.scripts, 5);
    assert.equal(diagnostics.resolved, 3);
    assert.deepEqual(diagnostics.failed, {
      "no-sourcemap-url": [`${server.origin}/nomap.js`],
      "map-fetch-failed": [`${server.origin}/brokenmap.js`],
    });
  } finally {
    await server.close();
  }
});

test("one shared resolver fetches each script once across passes", async () => {
  const server = await startBundleServer();
  try {
    const maps = new SourceMapResolver();
    const context = {
      profilePath: "remote.cpuprofile",
      meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
      sampleIntervalUs: 50,
      serverUrl: "http://127.0.0.1:1",
      root: os.tmpdir(),
      maps,
    };
    await buildCpuModel(remoteBundleProfile(server.origin), context);
    await buildCpuModel(remoteBundleProfile(server.origin), context);
    // Still 5, not 10: the second build reused the cache rather than refetching every bundle.
    assert.equal(maps.diagnostics().scripts, 5);
  } finally {
    await server.close();
  }
});

test("functionJoinKey joins on file, not source line (cpu-diff stays stable across line shifts)", () => {
  const before = { fn: "render", file: "src/app.js", source: "src/app.js:40", package: "app" };
  const after = { fn: "render", file: "src/app.js", source: "src/app.js:47", package: "app" };
  assert.equal(functionJoinKey(before), functionJoinKey(after));
  assert.equal(functionJoinKey(before), "render src/app.js");
});

// --- Cross-pass step merge (label-keyed; indices are per-pass and not comparable) ---

const driverStep = (index, label) => ({
  index,
  label,
  wallMs: 10 + index,
  inpMs: null,
  cdpDelta: { LayoutCount: index },
});

test("labelWindows re-keys a pass's own windows from index to label", () => {
  const steps = [driverStep(0, "mount"), driverStep(1, "hydrate"), driverStep(2, "inp")];
  // findSteps returns windows sorted by index; the trace can lose marks but never invent them,
  // so a window with no step (index 9) is dropped rather than paired with anything.
  const windows = [
    { index: 0, startTs: 100, endTs: 200 },
    { index: 2, startTs: 500, endTs: null },
    { index: 9, startTs: 900, endTs: 999 },
  ];
  // iteration defaults to 0 for hand-built steps: a flow that ran once is iteration 0 by
  // definition, and the merge reads absent as 0 rather than matching nothing.
  assert.deepEqual(labelWindows(steps, windows), [
    { label: "mount", iteration: 0, startTs: 100, endTs: 200 },
    { label: "inp", iteration: 0, startTs: 500, endTs: null },
  ]);
});

// --iterations repeats the flow, so the SAME label recurs once per iteration. Those repetitions
// are the samples that make a median mean anything; keying the trace by `index` would collide
// them, which is why the marks carry their own counter.
test("labelWindows keys by markIndex, so a repeated label stays distinct per iteration", () => {
  const steps = [
    { index: 0, iteration: 0, markIndex: 0, label: "mount", wallMs: 10, inpMs: null, cdpDelta: {} },
    { index: 0, iteration: 1, markIndex: 1, label: "mount", wallMs: 12, inpMs: null, cdpDelta: {} },
  ];
  const windows = [
    { index: 0, startTs: 100, endTs: 200 },
    { index: 1, startTs: 300, endTs: 400 },
  ];
  assert.deepEqual(labelWindows(steps, windows), [
    { label: "mount", iteration: 0, startTs: 100, endTs: 200 },
    { label: "mount", iteration: 1, startTs: 300, endTs: 400 },
  ]);
});

test("mergeSteps: a repeated label becomes one step with its samples, counts from iteration 0", () => {
  const step = (iteration, markIndex, label, wallMs, layouts) => ({
    index: label === "mount" ? 0 : 1,
    iteration,
    markIndex,
    label,
    wallMs,
    inpMs: null,
    cdpDelta: { LayoutCount: layouts },
  });
  const timing = [
    step(0, 0, "mount", 40, 7),
    step(0, 1, "inp", 5, 2),
    // later iterations are warm: faster, and (crucially) their counts must be ignored, not summed
    step(1, 2, "mount", 30, 7),
    step(1, 3, "inp", 9, 2),
    step(2, 4, "mount", 32, 7),
    step(2, 5, "inp", 7, 2),
  ];
  // The trace pass runs ONE iteration, so it contributes one window per label.
  const traced = [
    { label: "mount", iteration: 0, startTs: 100, endTs: 200 },
    { label: "inp", iteration: 0, startTs: 300, endTs: 400 },
  ];
  const merged = mergeSteps(timing, traced);

  assert.equal(merged.length, 2, "one merged step per label, not per measureStep call");
  const mount = merged.find((entry) => entry.label === "mount");
  assert.deepEqual(mount.perIteration, [40, 30, 32], "samples in iteration order, all kept");
  assert.equal(mount.wallMs, 32, "headline is the median (32), not the cold first sample (40)");
  assert.deepEqual(mount.cdpDelta, { LayoutCount: 7 }, "counts come from one iteration, not 21");
  assert.equal(mount.startTs, 100, "window from the trace pass's single iteration");
  assert.equal(merged.find((entry) => entry.label === "inp").wallMs, 7);
});

// The mirror of the counts rule, on the INP axis: taking the worst across iterations would make
// INP climb with --iterations, so raising it to gain confidence would report a regression that
// did not happen.
test("mergeSteps: per-step INP is the median across iterations, not the worst", () => {
  const step = (iteration, markIndex, inpMs) => ({
    index: 0,
    iteration,
    markIndex,
    label: "open menu",
    wallMs: 10,
    inpMs,
    cdpDelta: {},
  });
  const merged = mergeSteps([step(0, 0, 100), step(1, 1, 40), step(2, 2, 48)], undefined);
  assert.equal(merged[0].inpMs, 48, "median of 40/48/100, not the 100ms cold outlier");

  // A step with no interaction stays null rather than becoming 0: they mean different things.
  const noneMeasured = mergeSteps([step(0, 0, null), step(1, 1, null)], undefined);
  assert.equal(noneMeasured[0].inpMs, null);
});

// A flow that measures different steps per iteration produces samples describing different work
// while presenting as one distribution.
test("mergeSteps throws when an iteration measured different steps", () => {
  const step = (iteration, markIndex, label) => ({
    index: 0,
    iteration,
    markIndex,
    label,
    wallMs: 10,
    inpMs: null,
    cdpDelta: {},
  });
  const timing = [
    step(0, 0, "mount"),
    step(0, 1, "inp"),
    step(1, 2, "mount"), // "inp" skipped: a median over 1 sample would be labelled 2
  ];
  assert.throws(() => mergeSteps(timing, undefined), /Iteration 1 measured different steps.*missing: inp/s);
});

test("mergeSteps pairs by label, not by position", () => {
  // The trace pass is a separate browser run: its windows arrive in a different order than the
  // timing pass's steps. A positional/index-keyed merge would attach "inp"'s window to "mount".
  const timing = [driverStep(0, "mount"), driverStep(1, "hydrate"), driverStep(2, "inp")];
  const traced = [
    { label: "inp", startTs: 500, endTs: 600 },
    { label: "mount", startTs: 100, endTs: 200 },
    { label: "hydrate", startTs: 300, endTs: 400 },
  ];
  const merged = mergeSteps(timing, traced);
  assert.deepEqual(
    merged.map((step) => [step.label, step.startTs, step.endTs]),
    [
      ["mount", 100, 200],
      ["hydrate", 300, 400],
      ["inp", 500, 600],
    ],
  );
  // the timing pass still owns wall/CDP; only the window comes from the trace pass
  assert.equal(merged[0].wallMs, 10);
  assert.deepEqual(merged[0].cdpDelta, { LayoutCount: 0 });
});

test("mergeSteps throws when the passes recorded different steps (never emits a null window)", () => {
  const timing = [driverStep(0, "mount"), driverStep(1, "hydrate"), driverStep(2, "inp")];
  // The trace pass took a different path and skipped "hydrate". Index-keyed, "inp" would silently
  // inherit "hydrate"'s window and every count for the unmatched step would read 0 -- which
  // `assert --max-forced 0` reads as a pass.
  const traced = [
    { label: "mount", startTs: 100, endTs: 200 },
    { label: "inp", startTs: 300, endTs: 400 },
  ];
  assert.throws(() => mergeSteps(timing, traced), /different steps.*only in the timing pass: hydrate/s);
});

test("mergeSteps rejects duplicate labels rather than joining the wrong pair", () => {
  const timing = [driverStep(0, "mount"), driverStep(1, "mount")];
  assert.throws(() => mergeSteps(timing, undefined), /Duplicate step label "mount"/);
});

test("mergeSteps degrades (no throw) when the detail pass collected no windows at all", () => {
  // A lane without tracing (e.g. Firefox without --cpu-profile) has nothing to pair with. That is
  // absence, not divergence.
  const timing = [driverStep(0, "mount"), driverStep(1, "inp")];
  const merged = mergeSteps(timing, undefined);
  assert.deepEqual(
    merged.map((step) => [step.label, step.startTs, step.endTs]),
    [
      ["mount", null, null],
      ["inp", null, null],
    ],
  );
});

// --- Count provenance (the same number means different things per target) ---

test("countProvenance never calls a non-CDP count authoritative", () => {
  const recording = (meta) => ({ meta: { passes: ["timing"], ...meta }, summary: {} });

  // Chrome: CDP counters, the only exact ones.
  assert.match(countProvenance(recording({ passes: ["timing", "trace"] })), /authoritative/);
  assert.match(countProvenance(recording({ browser: "chrome" })), /authoritative/);

  // Firefox + gecko pass: summarize falls back to counting Reflow/Styles markers, so the counts
  // are real -- but Gecko batches layout differently, so they must not read as comparable.
  const gecko = countProvenance(recording({ browser: "firefox", passes: ["timing", "gecko"] }));
  assert.match(gecko, /Gecko markers/);
  assert.match(gecko, /not comparable to Chrome/);
  assert.doesNotMatch(gecko, /authoritative/);

  // Firefox with no gecko pass: nothing counts anything, so every count is 0. Saying so is the
  // difference between "clean" and "unmeasured".
  const none = countProvenance(recording({ browser: "firefox", passes: ["timing"] }));
  assert.match(none, /NOT measured/);
  assert.doesNotMatch(none, /authoritative/);
});

// --- Firefox Gecko profile converter (against a real trimmed shutdown dump) ---

test("parseGeckoLocation: named JS, anonymous, native, and non-resolvable urls", () => {
  // named function: line:col is the definition site, 1-based; trailing [NN] stripped
  assert.deepEqual(parseGeckoLocation("hashString (http://h/a.mjs:6:20)[43]"), {
    functionName: "hashString",
    url: "http://h/a.mjs",
    line: 6,
    column: 20,
  });
  // anonymous top-level positioned frame
  assert.deepEqual(parseGeckoLocation("http://h/__blank__:1:8[28]"), {
    functionName: "",
    url: "http://h/__blank__",
    line: 1,
    column: 8,
  });
  // native label: no url, kept as a name so it buckets to (native) downstream
  assert.deepEqual(parseGeckoLocation("XRE_InitChildProcess"), {
    functionName: "XRE_InitChildProcess",
    url: "",
    line: null,
    column: null,
  });
  // self-hosted is JS but not on-disk/fetchable, so the url is dropped (-> (native))
  assert.equal(parseGeckoLocation("get (self-hosted:12:3)").url, "");
});

const geckoFixture = JSON.parse(
  readFileSync(new URL("./fixtures/gecko-shutdown.trimmed.json", import.meta.url), "utf8"),
);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// The fixture's frames carry this served origin (captured at record time); the resolver
// rewrites it back to local source under repoRoot.
const FIXTURE_ORIGIN = "http://127.0.0.1:60832";

test("parseGecko: selects the content thread by its wpd:run marks and reads the window", () => {
  const context = parseGecko(geckoFixture);
  assert.equal(context.thread.name, "GeckoMain");
  assert.ok(context.windowStartMs != null && context.windowEndMs != null, "window resolved");
  assert.ok(context.windowEndMs > context.windowStartMs, "window is a positive interval");
  assert.ok(context.jsCategory >= 0, "JavaScript category located");
});

test("parseGecko throws rather than silently reporting an empty profile", () => {
  // No JavaScript category => no frame can be classified as JS => a model claiming ~0 scripting.
  const noJsCategory = {
    ...geckoFixture,
    meta: { ...geckoFixture.meta, categories: [{ name: "Other" }, { name: "Idle" }] },
  };
  assert.throws(() => parseGecko(noJsCategory), /no 'JavaScript' category/);
  assert.throws(() => parseGecko({ meta: geckoFixture.meta, threads: [] }), /no threads/);
});

test("geckoToRawCpuProfile -> buildCpuModel resolves hot JS to source with 1->0-based line", async () => {
  const context = parseGecko(geckoFixture);
  const raw = geckoToRawCpuProfile(context);
  // window-sliced: the two pre-window samples the fixture includes must be dropped
  assert.ok(raw.samples.length > 0 && raw.samples.length <= context.thread.samples.data.length);
  assert.equal(raw.samples.length, raw.timeDeltas.length);

  const model = await buildCpuModel(raw, {
    profilePath: "fixture.geckoprofile.json",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1", browser: "firefox" },
    sampleIntervalUs: 1000,
    serverUrl: FIXTURE_ORIGIN,
    root: repoRoot,
  });
  assert.ok(model.scriptingMs > 0, "non-zero sampled scripting time");
  const busywork = model.functions.find((fn) => fn.source?.includes("forces-layout.mjs"));
  assert.ok(busywork, "a busywork function resolved to its source file");
  assert.match(busywork.package, /wpd-examples|app/, "attributed to the example workspace package");
  // definition line is what V8 reports: the location string's :6 (hashString) -> resolved :6.
  // The frame stores it 0-based (5) and resolveCallFrame adds 1; assert we land on a real line.
  assert.match(busywork.source, /forces-layout\.mjs:\d+$/, "resolved to file:line");
  // native JS-engine builtins (JSRope::flatten etc.) must bucket as (native), never a real pkg
  const native = model.functions.filter((fn) => fn.package === "(native)");
  for (const fn of native) assert.ok(!fn.source || !fn.source.includes("node_modules"));
});

test("geckoToRenderingEvents -> attachStacks/markForced yields windowed + forced layout blame", async () => {
  const context = parseGecko(geckoFixture);
  const events = geckoToRenderingEvents(context);
  // UserTiming marks become usertiming events so findWindow locates the window
  const window = findWindow(events);
  assert.ok(window.startTs != null && window.endTs != null, "run window found from marks");
  const kinds = new Set(events.map((event) => event.kind));
  assert.ok(kinds.has("usertiming"), "usertiming events present");
  assert.ok(kinds.has("style") || kinds.has("layout"), "at least one Reflow/Styles event");

  await attachStacks(events, FIXTURE_ORIGIN, repoRoot);
  markForced(events);
  const forced = events.filter((event) => event.forced && event.at);
  assert.ok(forced.length > 0, "a style/layout event with a JS cause was flagged forced");
  assert.ok(
    (forced[0].kind === "style" || forced[0].kind === "layout") && forced[0].at.length > 0,
  );
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

// Regression: DEFAULT_CPU_INTERVAL_US was duplicated in commands/record.ts and runtime/node.ts, so
// the 50 -> 200 change landed on the browser lanes only. The node lane -- the very lane the
// interval was measured on -- kept sampling at 50us while --help and the changelog said 200. The
// fix is that there is now exactly ONE definition; this test fails if a lane grows its own again.
test("every lane shares one CPU sampler interval default", async () => {
  assert.equal(typeof DEFAULT_CPU_INTERVAL_US, "number");
  assert.equal(DEFAULT_CPU_INTERVAL_US, 200);

  const files = ["../dist/commands/record.js", "../dist/runtime/node.js"];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.ok(
      !/const\s+DEFAULT_CPU_INTERVAL_US\s*=/.test(source),
      `${file} defines its own DEFAULT_CPU_INTERVAL_US; import the shared one from profile/cpuprofile.js instead`,
    );
  }
});

// The sourcemap warning must fire when the package rollup is a lie and stay quiet when it is not.
// These pin BOTH directions, which the previous version of this comment CLAIMED to do while
// actually testing node builtins twice -- and that gap let a regression ship where the warning went
// silent on exactly the local minified bundle it exists for.
function remoteProfile(url) {
  return {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 }, children: [2] },
      { id: 2, callFrame: { functionName: "hot", scriptId: "1", url, lineNumber: 0, columnNumber: 0 }, hitCount: 1 },
    ],
    startTime: 0,
    endTime: 1000,
    samples: [2],
    timeDeltas: [1000],
  };
}

test("buildCpuModel: an unmapped third-party bundle is counted and bucketed by origin", async () => {
  const model = await buildCpuModel(remoteProfile("https://cdn.example.com/app.min.js"), {
    profilePath: "synthetic.cpuprofile",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
    sampleIntervalUs: DEFAULT_CPU_INTERVAL_US,
    serverUrl: "http://127.0.0.1:1234",
    root: os.tmpdir(),
  });
  // No map resolved and the url is not the served origin, so we do not know whose code this is.
  assert.equal(model.unmappedFrames, 1, "the unattributed frame is counted");
  const hot = model.functions.find((fn) => fn.fn === "hot");
  assert.equal(hot.package, "(cdn.example.com)", "bucketed by origin, never blamed on `app`");
});

test("buildCpuModel: node builtins are not counted as unmapped", async () => {
  const model = await buildCpuModel(remoteProfile("node:internal/streams/readable"), {
    profilePath: "synthetic.cpuprofile",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
    sampleIntervalUs: DEFAULT_CPU_INTERVAL_US,
    root: os.tmpdir(),
    runtime: "node",
  });
  // A builtin has no sourcemap and never will; that is not a broken package rollup.
  assert.equal(model.unmappedFrames, 0, "builtins do not trip the unmapped warning");
  assert.equal(model.functions.find((fn) => fn.fn === "hot").package, "(node)");
});

// A local frame ALWAYS resolves to a path, so unmappedFrames can never flag a local bundle. That is
// what `unmappedBundles` is for, and these two are the regression guard: a minified local bundle
// with no map must be reported, and plain local source with no map must not.
test("SourceMapResolver: a minified local bundle with no map counts as an unmapped bundle", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-map-"));
  const bundle = path.join(dir, "app.min.js");
  writeFileSync(bundle, `function a(n){${"let x=0;".repeat(120)}return n}export{a};\n`);
  const maps = new SourceMapResolver();
  await maps.resolveFrame({ url: `http://x/app.min.js`, source: bundle, line: 1, column: 1 });
  const diagnostics = maps.diagnostics();
  assert.equal(diagnostics.resolved, 0, "no map to resolve");
  assert.equal(diagnostics.unmappedBundles, 1, "minified build output with no map is reported");
});

test("SourceMapResolver: plain local source with no map is not an unmapped bundle", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-map-"));
  const plain = path.join(dir, "probe.mjs");
  writeFileSync(plain, "export function run() {\n  return 1 + 1;\n}\n");
  const maps = new SourceMapResolver();
  await maps.resolveFrame({ url: `http://x/probe.mjs`, source: plain, line: 1, column: 1 });
  const diagnostics = maps.diagnostics();
  assert.equal(diagnostics.resolved, 0, "there is no map, and none is needed");
  assert.equal(diagnostics.unmappedBundles, 0, "hand-written source must not trip the warning");
});

test("blameSemanticFor: names the engine's question, and stays absent when there is no blame", () => {
  const timing = { name: "timing", categories: null, cpu: true };
  const trace = { name: "trace", categories: ["devtools.timeline"] };
  const gecko = { name: "gecko", categories: null, gecko: true };

  assert.equal(blameSemanticFor([timing, trace]), "flush-site", "chrome blames the read");
  assert.equal(blameSemanticFor([timing, gecko]), "invalidation-site", "gecko blames the write");
  // The branch worth pinning: a plan with neither pass produces no blame at all, so claiming a
  // semantic would describe lines that do not exist. --no-trace and --target node land here.
  assert.equal(blameSemanticFor([timing]), undefined, "--no-trace produces no blame");
  assert.equal(blameSemanticFor([]), undefined, "no passes, no blame");
  // Defensive only: record.ts never builds this plan (the chrome branch never pushes a gecko
  // spec, the firefox branch never pushes a trace one). Pins the tie-break in case it ever can.
  assert.equal(blameSemanticFor([gecko, trace]), "invalidation-site", "gecko takes precedence");
});

test("noteCountScope: describes the pass plan that ran, per lane", () => {
  const timing = { name: "timing", categories: null, cpu: true, bracketFirstIteration: true };
  const tracePinned = { name: "trace", categories: ["devtools.timeline"], iterations: 1 };
  const traceAll = { name: "trace", categories: ["devtools.timeline"] };
  const gecko = { name: "gecko", categories: null, gecko: true };
  const bench = (iterations) => ({ driver: false, iterations });
  // Real caps, not hand-rolled objects: the note must stay tied to what the backend can do.
  const chrome = capsFor("chrome");
  const firefoxCaps = capsFor("firefox");

  // Nothing to say at one iteration: there is nothing to scale.
  assert.equal(noteCountScope([timing, tracePinned], bench(1), chrome), null);
  assert.equal(noteCountScope([timing, tracePinned], { driver: true, iterations: 1 }, chrome), null);

  // --iterations repeats run() in BOTH modes, so the scope question is real in both. Driver used
  // to be exempted here, which left `record --iterations 4 --no-isolate` reporting overall counts
  // totalled across 4 with nothing saying so (measured: layoutCount 28 vs 7 per iteration).
  const driverTotals = noteCountScope([traceAll], { driver: true, iterations: 4 }, chrome);
  assert.match(driverTotals, /TOTALS across all 4/);
  assert.match(driverTotals, /Per-step counts are unaffected/, "per-step counts are still per-iteration");

  const isolated = noteCountScope([timing, tracePinned], bench(20), chrome);
  assert.match(isolated, /FIRST timed iteration/, "default lane scopes counts to one iteration");
  assert.match(isolated, /trace pass runs a single iteration/);

  // --no-trace: no trace pass exists, so the note must not claim one runs a single iteration.
  const noTrace = noteCountScope([timing], bench(20), chrome);
  assert.match(noTrace, /FIRST timed iteration/);
  assert.doesNotMatch(noTrace, /trace pass/, "must not describe a pass that never ran");

  // --no-isolate: the only pass carries wall AND counts, so counts really are totals. Claiming
  // per-iteration here would be the mixed-window bug (layout from 1 iteration, forced from N).
  const noIsolate = noteCountScope([traceAll], bench(20), chrome);
  assert.match(noIsolate, /TOTALS across all 20/);
  assert.match(noIsolate, /--no-isolate/);

  // Firefox: the gecko pass is the lane's CPU sampler, so it runs every iteration and totals.
  const firefox = noteCountScope([timing, gecko], bench(20), firefoxCaps);
  assert.match(firefox, /TOTALS across all 20/);
  assert.match(firefox, /CPU sampler/);

  // Firefox with no gecko pass (programmatic cpuProfile:false; the CLI refuses it). timingSpec
  // still carries bracketFirstIteration, but runPass only splits when the backend HAS CDP
  // counters, so promising a CDP bracket here would describe a split that never ran -- next to a
  // sibling note saying every count on this lane is 0.
  assert.equal(
    noteCountScope([timing], bench(20), firefoxCaps),
    null,
    "no CDP counters means no bracket to describe",
  );
});

// prepare() runs ONCE, before the timed loop, so a step it measures has one sample no matter what
// --iterations says. Counting it as part of iteration 0 made the idempotency check see an extra
// label there and fail every repeated run whose prepare() measured anything -- telling the user
// their flow was not idempotent when it was, and that the fix was to drop --iterations.
test("mergeSteps: a step measured in prepare() is single-sample, not an idempotency violation", () => {
  const prepared = {
    index: 0,
    iteration: 0,
    phase: "prepare",
    markIndex: 0,
    label: "boot",
    wallMs: 300,
    inpMs: null,
    cdpDelta: { LayoutCount: 9 },
  };
  const timed = (iteration, markIndex, wallMs) => ({
    index: 1,
    iteration,
    phase: "timed",
    markIndex,
    label: "click",
    wallMs,
    inpMs: null,
    cdpDelta: { LayoutCount: 2 },
  });
  const steps = [prepared, timed(0, 1, 50), timed(1, 2, 40), timed(2, 3, 42)];

  const merged = mergeSteps(steps, undefined);
  assert.equal(merged.length, 2);
  const boot = merged.find((step) => step.label === "boot");
  assert.deepEqual(boot.perIteration, [300], "prepare ran once, so it has one sample");
  assert.equal(boot.wallMs, 300);
  assert.equal(merged.find((step) => step.label === "click").perIteration.length, 3);

  // Its window must still be paired: dropping it would report the step's counts as 0, which reads
  // as "clean" rather than "not measured".
  const windows = [
    { label: "boot", iteration: 0, startTs: 10, endTs: 20 },
    { label: "click", iteration: 0, startTs: 30, endTs: 40 },
  ];
  const withWindows = mergeSteps(steps, windows);
  assert.equal(withWindows.find((step) => step.label === "boot").startTs, 10);
});

// Real shape, measured in headless Chrome on a click whose handler burns 45ms: Chrome emits the
// whole pointer sequence, EVERY entry sharing one duration to the same next paint, but only the
// interaction's own events carry a non-zero interactionId. Picking the max-duration entry would
// therefore tie across all of them and could read processing off `pointerover`, which does nothing.
const eventTiming = (name, startTime, processingStart, processingEnd, duration, interactionId) => ({
  name, startTime, processingStart, processingEnd, duration, interactionId,
});

test("interactionBreakdown: splits INP the way Core Web Vitals does, off the interaction's group", () => {
  const entries = [
    // interactionId 0: not an interaction. Same duration, no processing.
    eventTiming("pointerover", 100.0, 100.1, 100.2, 64, 0),
    eventTiming("mouseover", 100.0, 100.1, 100.1, 64, 0),
    // interactionId 1186: the interaction. The work lives in `click`, not in pointerdown/up.
    eventTiming("pointerdown", 100.0, 100.4, 100.4, 64, 1186),
    eventTiming("pointerup", 144.0, 145.6, 145.6, 64, 1186),
    eventTiming("click", 144.0, 145.6, 190.8, 64, 1186),
  ];
  const split = interactionBreakdown(entries);
  // input delay from the FIRST event of the group (pointerdown), not from pointerover.
  assert.ok(Math.abs(split.inputDelayMs - 0.4) < 0.001, "input delay is the group's first event");
  // processing spans first processingStart -> last processingEnd, so it catches the 45ms click
  // handler even though pointerdown itself did nothing.
  assert.ok(Math.abs(split.processingMs - 90.4) < 0.001, "processing spans the whole group");
  // the three reconstruct the interaction's duration
  assert.ok(
    Math.abs(split.inputDelayMs + split.processingMs + split.presentationDelayMs - 64) < 0.001,
    "the parts add back up to the reported INP",
  );
});

test("interactionBreakdown: null when nothing is an interaction", () => {
  // A programmatic step (page.evaluate -> el.click()) fires untrusted events, which Event Timing
  // does not observe at all. Verified in headless Chrome: zero entries. Reporting 0ms of handler
  // for that would read as "your handler is free" rather than "not measured".
  assert.equal(interactionBreakdown([]), null);
  assert.equal(
    interactionBreakdown([eventTiming("pointerover", 1, 1.1, 1.2, 16, 0)]),
    null,
    "entries with no interactionId are not an interaction",
  );
});

test("interactionBreakdown: picks the worst interaction when a step has several", () => {
  const entries = [
    eventTiming("click", 0, 0.5, 2.0, 24, 1),
    eventTiming("click", 100, 100.5, 180.0, 96, 2), // the slow one
  ];
  const split = interactionBreakdown(entries);
  assert.ok(Math.abs(split.processingMs - 79.5) < 0.001, "the worst interaction's handler, not the first");
});
