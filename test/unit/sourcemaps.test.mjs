import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCpuModel,
  packageRollup,
  functionJoinKey,
  loadCpuModel,
  DEFAULT_CPU_INTERVAL_US,
} from "../../dist/profile/cpuprofile.js";
import { SourceMapResolver } from "../../dist/trace/sourcemap.js";
import {
  syntheticProfile,
  breakdownProfile,
  pseudoUrlProfile,
  sourcemapFor,
  startBundleServer,
  remoteBundleProfile,
  remoteProfile,
} from "./helpers.mjs";

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

test("buildCpuModel: the breakdown tiles the window exactly and classifies every synthetic frame", async () => {
  const model = await buildCpuModel(breakdownProfile(), {
    profilePath: "breakdown.cpuprofile",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
    sampleIntervalUs: 50,
    root: os.tmpdir(),
    runtime: "node",
  });

  const breakdown = model.breakdown;
  assert.ok(breakdown, "a chrome/node model carries a breakdown");
  const { js, browser, gc, idle } = breakdown.slices;

  // classification: (idle) -> idle, (garbage collector) -> gc, (program)/(root) -> browser,
  // real frames -> js.
  // render 1.0 + appMain 2.0
  assert.equal(js.ms, 3);
  assert.equal(idle.ms, 3);
  assert.equal(gc.ms, 1.5);
  // (program); (root) had zero self time
  assert.equal(browser.ms, 0.5);

  // wall is the profile's own window (sum of deltas), which equals totalMs.
  assert.equal(breakdown.wallMs, model.totalMs);
  assert.equal(breakdown.wallMs, 8);

  // the product promise: slices tile the wall with zero residual (float dust only).
  const sum = js.ms + browser.ms + gc.ms + idle.ms;
  assert.ok(Math.abs(sum - breakdown.wallMs) < 1e-9, `slices ${sum} must sum to wall ${breakdown.wallMs}`);

  // the js slice is subdivided by the SAME resolver: a node_modules frame becomes its package,
  // an app frame becomes "app", and byPackage sums back to js.ms.
  assert.equal(js.byPackage["react-dom"], 1);
  assert.equal(js.byPackage["app"], 2);
  const pkgSum = Object.values(js.byPackage).reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(pkgSum - js.ms) < 1e-9, "byPackage must sum to js.ms");
});

test("buildCpuModel: Firefox gets NO breakdown (Gecko does not represent idle honestly)", async () => {
  // Measured: a pure-wait window (run() only awaits) reads 0 idle samples in the Gecko dump; the
  // converter bills that time to (program), so a firefox breakdown would report idle ~= 0 for a
  // fully-idle window. A fabricated idle is worse than none, so the model omits it on this lane.
  const model = await buildCpuModel(breakdownProfile(), {
    profilePath: "ff.cpuprofile",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1", browser: "firefox" },
    sampleIntervalUs: 1000,
    root: os.tmpdir(),
    runtime: "node",
  });
  assert.equal(model.breakdown, undefined, "no breakdown on the firefox lane");
  // The rest of the model is unaffected: system buckets and functions still populate.
  assert.ok(model.functions.length > 0, "functions still resolve on firefox");
});

test("loadCpuModel: an old model without a breakdown still loads and queries", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-cpu-"));
  // A model shaped like an artifact written before the breakdown field existed: no `breakdown` key.
  const legacy = {
    profile: "old.cpuprofile",
    meta: { tool: "wpd", version: "0.4.0", schemaVersion: "2" },
    sampleCount: 2,
    sampleIntervalUs: 200,
    totalMs: 5,
    scriptingMs: 5,
    system: { idleMs: 0, gcMs: 0, programMs: 0 },
    functions: [
      { id: 0, fn: "render", source: "src/app.js:3", file: "src/app.js", package: "app", selfMs: 5, selfPct: 100, totalMs: 5 },
    ],
    edges: [],
  };
  const modelPath = path.join(dir, "old.cpu.json");
  writeFileSync(modelPath, JSON.stringify(legacy));
  const model = await loadCpuModel(modelPath);
  assert.equal(model.breakdown, undefined, "no breakdown field on an old model");
  // the verbs still work: packageRollup reads it without the breakdown present.
  assert.equal(packageRollup(model)[0].key, "app");
});

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

// Regression: DEFAULT_CPU_INTERVAL_US was duplicated in commands/record.ts and runtime/node.ts, so
// the 50 -> 200 change landed on the browser lanes only. The node lane -- the very lane the
// interval was measured on -- kept sampling at 50us while --help and the changelog said 200. The
// fix is that there is now exactly ONE definition; this test fails if a lane grows its own again.
test("every lane shares one CPU sampler interval default", async () => {
  assert.equal(typeof DEFAULT_CPU_INTERVAL_US, "number");
  assert.equal(DEFAULT_CPU_INTERVAL_US, 200);

  const files = ["../../dist/commands/record.js", "../../dist/runtime/node.js"];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.ok(
      !/const\s+DEFAULT_CPU_INTERVAL_US\s*=/.test(source),
      `${file} defines its own DEFAULT_CPU_INTERVAL_US; import the shared one from profile/cpuprofile.js instead`,
    );
  }
});

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

// Bench mode serves the user's OWN module tree over an ephemeral localhost port, so a served frame
// that does not land on an existing local source must NOT bucket by that host:port (a key that
// changes every run and splits cross-run cpu-diff joins). Detection is an EXACT origin match against
// wpd's served origin, so a genuinely remote host -- including the user's own dev server on a
// different port -- keeps origin bucketing.
test("served-origin frames get a stable local package, or (served), never the ephemeral host:port", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wpd-served-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "my-served-app" }));
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist", "entry.js"), "export function run(){}\n");
  const servedOrigin = "http://127.0.0.1:57999";
  const build = (url) =>
    buildCpuModel(remoteProfile(url), {
      profilePath: "served.cpuprofile",
      meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
      sampleIntervalUs: DEFAULT_CPU_INTERVAL_US,
      serverUrl: servedOrigin,
      root,
    });
  const pkgFileOf = (model) => {
    const hot = model.functions.find((fn) => fn.fn === "hot");
    return { package: hot.package, file: hot.file };
  };

  // (a) a served frame whose pathname maps to an existing local file: the real package + relative
  // file, exactly as any on-disk source resolves.
  const existing = pkgFileOf(await build(`${servedOrigin}/dist/entry.js`));
  assert.equal(existing.package, "my-served-app");
  assert.equal(existing.file, "dist/entry.js");

  // (b) a served frame whose pathname names no on-disk file: the stable literal (served) bucket,
  // never a fabricated origin and never a stray package.json walked up to from a missing path.
  const missing = pkgFileOf(await build(`${servedOrigin}/ghost/gone.js`));
  assert.equal(missing.package, "(served)");
  assert.equal(missing.file, "(served)");

  // (c) a genuinely remote origin (here the SAME ip on a DIFFERENT port, i.e. NOT the served origin)
  // keeps origin bucketing: detection is by exact origin, not "any localhost".
  const remote = pkgFileOf(await build("http://127.0.0.1:9/x.js"));
  assert.equal(remote.package, "(127.0.0.1:9)");

  // (d) a user profiling their own dev server (--url http://localhost:3000) has a STABLE host:port
  // that must keep origin bucketing -- it is not wpd's served origin.
  const userServer = pkgFileOf(await build("http://localhost:3000/app.js"));
  assert.equal(userServer.package, "(localhost:3000)");
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
