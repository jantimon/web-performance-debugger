import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCpuModel,
  packagesByProfileNode,
  packageRollup,
  functionJoinKey,
  loadCpuModel,
  DEFAULT_CPU_INTERVAL_US,
} from "../../dist/profile/cpuprofile.js";
import {
  SourceMapResolver,
  fetchBlockReason,
  isPrivateHostname,
  boundedFetch,
} from "../../dist/trace/sourcemap.js";
import http from "node:http";
import { cpuDiffCmd } from "../../dist/commands/cpudiff.js";
import {
  syntheticProfile,
  breakdownProfile,
  pseudoUrlProfile,
  sourcemapFor,
  startBundleServer,
  remoteBundleProfile,
  remoteProfile,
  closeServer,
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
  // A model shaped like an artifact written before the breakdown field was added: current schema,
  // but no `breakdown` key. The verbs must read it without assuming the field is present.
  const legacy = {
    profile: "old.cpuprofile",
    meta: { tool: "wpd", version: "0.9.0", schemaVersion: "3" },
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
    // genuinely unknown, so they bucket by origin. This is a real listen(0) server, so the OS picks
    // its port; derive the expected bucket the way unmappedOriginBucket does (drop an ephemeral
    // >=32768 port, keep any lower one) so the assertion is stable across every OS ephemeral range.
    const parsedOrigin = new URL(server.origin);
    const originPort = Number(parsedOrigin.port);
    const expectedOrigin =
      originPort >= 32768 && originPort <= 65535 ? parsedOrigin.hostname : parsedOrigin.host;
    assert.equal(pkgOf("Qk"), `(${expectedOrigin})`);
    assert.equal(pkgOf("Xy"), `(${expectedOrigin})`);

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

// F3: a positionless V8 frame (native/builtin call that still carries a script url) reports
// lineNumber -1. The 0-based -> 1-based shift made it line 0, which trace-mapping rejects by THROWING
// ("`line` must be greater than 0"), crashing the whole run. It must be treated as "no position", not
// mapped, so buildCpuModel resolves the profile without throwing.
test("buildCpuModel: a lineNumber -1 frame with a resolvable map does not crash the run (F3)", async () => {
  const server = await startBundleServer();
  try {
    const maps = new SourceMapResolver();
    // comment.js has a real sourcemap, so the OLD code loaded it and threw on the line-0 lookup.
    const profile = {
      startTime: 0,
      endTime: 2000,
      nodes: [
        {
          id: 1,
          callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 },
          children: [2],
        },
        {
          id: 2,
          callFrame: {
            functionName: "native",
            scriptId: "1",
            url: `${server.origin}/comment.js`,
            lineNumber: -1,
            columnNumber: -1,
          },
          children: [],
        },
      ],
      samples: [2, 2],
      timeDeltas: [1000, 1000],
    };
    const model = await buildCpuModel(profile, {
      profilePath: "line0.cpuprofile",
      meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
      sampleIntervalUs: 50,
      serverUrl: "http://127.0.0.1:1",
      root: os.tmpdir(),
      maps,
    });
    // No throw: the positionless frame kept its identity and bucketed by origin rather than mapping.
    const fn = model.functions.find((entry) => entry.fn === "native");
    assert.ok(fn, "the positionless frame is still present in the model");
    assert.ok(fn.package.startsWith("("), `bucketed by origin, not app (got ${fn.package})`);
  } finally {
    await server.close();
  }
});

// The defensive guard in SourceMapResolver.resolveFrame: even when the map DID load, a frame whose
// line is < 1 must be skipped (and recorded as a miss), never passed to originalPositionFor.
test("SourceMapResolver.resolveFrame skips a line-0 frame instead of throwing (F3 guard)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-line0-"));
  const jsPath = path.join(dir, "bundle.js");
  writeFileSync(jsPath, "function a(){}\n//# sourceMappingURL=bundle.js.map");
  writeFileSync(path.join(dir, "bundle.js.map"), sourcemapFor("src/App.tsx", "AppRoot"));
  const maps = new SourceMapResolver();
  const frame = { source: jsPath, line: 0, column: 1 };
  await maps.resolveFrame(frame); // must not throw
  assert.equal(frame.line, 0, "the unmappable frame is left untouched");
  const misses = maps.diagnostics().positionMisses?.[jsPath]?.misses;
  assert.equal(misses, 1, "the skipped line-0 frame is recorded as a position miss");
});

// F6: webpack's module-loader runtime (webpack/bootstrap, webpack/runtime/*, (webpack)/buildin/*) is
// named by the sourcemap's `sources` but has no real file. Left as `app` it inflates the user's own
// bucket (~20% on a real production boot). It must bucket as (webpack); a genuine mapped module
// (src/*, node_modules/*) must still resolve to its real owner.
test("webpack runtime frames bucket as (webpack), real modules still resolve (F6)", async () => {
  const routes = {
    "/bootstrap.js": ["function o(){}\n//# sourceMappingURL=bootstrap.js.map", {}],
    "/bootstrap.js.map": [sourcemapFor("webpack://myapp/webpack/bootstrap", "o"), {}],
    "/rt.js": ["function j(){}\n//# sourceMappingURL=rt.js.map", {}],
    "/rt.js.map": [sourcemapFor("webpack://myapp/webpack/runtime/jsonp chunk loading", "jsonp"), {}],
    "/buildin.js": ["function g(){}\n//# sourceMappingURL=buildin.js.map", {}],
    "/buildin.js.map": [sourcemapFor("webpack://myapp/(webpack)/buildin/global.js", "glob"), {}],
    "/appcode.js": ["function r(){}\n//# sourceMappingURL=appcode.js.map", {}],
    "/appcode.js.map": [sourcemapFor("webpack://myapp/./src/index.js", "AppRoot"), {}],
    "/dep.js": ["function d(){}\n//# sourceMappingURL=dep.js.map", {}],
    "/dep.js.map": [sourcemapFor("webpack://myapp/./node_modules/react-dom/index.js", "reactRender"), {}],
  };
  const server = http.createServer((request, response) => {
    const route = routes[request.url];
    if (!route) return void (response.writeHead(404), response.end("not found"));
    const [body, headers] = route;
    response.writeHead(200, { "content-type": "application/javascript", ...headers });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const remoteFrame = (functionName, file) => ({ functionName, scriptId: "1", url: `${origin}/${file}`, lineNumber: 0, columnNumber: 0 });
  try {
    const model = await buildCpuModel(
      {
        startTime: 0,
        endTime: 5000,
        nodes: [
          { id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 }, children: [2, 3, 4, 5, 6] },
          { id: 2, callFrame: remoteFrame("o", "bootstrap.js"), children: [] },
          { id: 3, callFrame: remoteFrame("j", "rt.js"), children: [] },
          { id: 4, callFrame: remoteFrame("g", "buildin.js"), children: [] },
          { id: 5, callFrame: remoteFrame("r", "appcode.js"), children: [] },
          { id: 6, callFrame: remoteFrame("d", "dep.js"), children: [] },
        ],
        samples: [2, 3, 4, 5, 6],
        timeDeltas: [1000, 1000, 1000, 1000, 1000],
      },
      {
        profilePath: "webpack.cpuprofile",
        meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
        sampleIntervalUs: 50,
        serverUrl: "http://127.0.0.1:1", // not the serving origin: force the remote path
        root: os.tmpdir(),
        maps: new SourceMapResolver(),
      },
    );
    const pkgOf = (fnName) => model.functions.find((entry) => entry.fn === fnName)?.package;
    assert.equal(pkgOf("o"), "(webpack)", "webpack/bootstrap is webpack runtime, not app");
    assert.equal(pkgOf("jsonp"), "(webpack)", "webpack/runtime/* is webpack runtime, not app");
    assert.equal(pkgOf("glob"), "(webpack)", "(webpack)/buildin/* is webpack runtime, not app");
    assert.equal(pkgOf("AppRoot"), "app", "a real mapped src/* module stays the user's app");
    assert.equal(pkgOf("reactRender"), "react-dom", "a real mapped dependency resolves to its package");
  } finally {
    await closeServer(server);
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

// F33: two functions sharing a join key (same name in the same file) must be SUMMED, not last-wins.
// functionJoinKey joins on the bare file (so a line shift does not split it), so a name reused at two
// lines collides; a plain Map would silently drop one side's self-time from the delta.
test("cpu-diff sums self-time on a join-key collision instead of dropping one (F33)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-cpudiff-"));
  const cpuFn = (fn, file, source, selfMs) => ({
    id: 0, fn, file, source, package: "app", selfMs, totalMs: selfMs, selfPct: 0, callers: [], callees: [],
  });
  const model = (functions, scriptingMs) => ({
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "3", iterations: 1 },
    profile: "x.cpuprofile", scriptingMs, totalMs: scriptingMs, sampleCount: 1, sampleIntervalUs: 200,
    system: { idleMs: 0, gcMs: 0, programMs: 0 }, functions,
  });
  // baseline has the line once (3ms); current has the SAME name+file at two lines (3 + 4 = 7ms).
  const baseFile = path.join(dir, "base.cpu.json");
  const curFile = path.join(dir, "cur.cpu.json");
  writeFileSync(baseFile, JSON.stringify(model([cpuFn("get", "lib/cache.ts", "lib/cache.ts:35", 3)], 3)));
  writeFileSync(curFile, JSON.stringify(model(
    [cpuFn("get", "lib/cache.ts", "lib/cache.ts:35", 3), cpuFn("get", "lib/cache.ts", "lib/cache.ts:42", 4)],
    7,
  )));

  const logs = [];
  const priorLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await cpuDiffCmd(baseFile, curFile, { json: true });
  } finally {
    console.log = priorLog;
  }
  const result = JSON.parse(logs.join("\n"));
  const row = result.functions.find((entry) => entry.fn === "get");
  assert.ok(row, "the colliding function is present");
  assert.equal(row.baseMs, 3, "baseline self-time (one occurrence)");
  assert.equal(row.currentMs, 7, "current self-time SUMMED across both occurrences, not last-wins (4)");
  assert.equal(row.delta, 4, "delta reflects the whole line (7 - 3), not a dropped 4 - 3 = 1");
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

// A frame from wpd's OWN served origin whose sourcemap mapped it to an off-disk original source is
// re-derived from the served pathname, not fs-walked up the missing path to a stray package.json.
// Detection is an EXACT origin match against wpd's served origin, so a genuinely remote host is left
// to the ordinary remote branch (see the ephemeral-port test below).
test("served-origin frames with an off-disk source get the local package, or (served), not a stray walk", async () => {
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
  // never a stray package.json walked up to from a missing path.
  const missing = pkgFileOf(await build(`${servedOrigin}/ghost/gone.js`));
  assert.equal(missing.package, "(served)");
  assert.equal(missing.file, "(served)");
});

// The scenario attributeServedOrigin EXISTS for, and the case (a) above does NOT hit: the served
// bundle IS on disk, but its sourcemap resolves frame.source to an OFF-DISK original (a bundle built
// elsewhere, or a stale map). frame.source is then not on disk, so the local branch cannot answer;
// the served pathname is re-derived to the real package via packageForFile. A regression that makes
// the helper always return `(served)` would pass the fallback-only assertions above but fail here.
// F22: a local bundle whose `//# sourceMappingURL` names a map in a SIBLING directory (e.g.
// `maps/bundle.js.map`). The adjacent `${jsFile}.map` read misses it, so before the fix it returned
// map-fetch-failed and the frame stayed minified. The reference must resolve against the JS file's
// own directory and be read from disk, exactly as the remote branch resolves relative references.
test("a local sourceMappingURL pointing at a sibling directory resolves off disk (F22)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-relmap-"));
  mkdirSync(path.join(dir, "maps"));
  const bundle = path.join(dir, "bundle.js");
  writeFileSync(bundle, "function Bh(){}\n//# sourceMappingURL=maps/bundle.js.map\n");
  writeFileSync(path.join(dir, "maps", "bundle.js.map"), sourcemapFor("src/original.ts", "realName"));

  const maps = new SourceMapResolver();
  const frame = { source: bundle, line: 1, column: 1 };
  await maps.resolveFrame(frame);

  const diagnostics = maps.diagnostics();
  assert.equal(diagnostics.resolved, 1, "the sibling-directory map resolved (not map-fetch-failed)");
  assert.equal(diagnostics.failed, undefined, "no failure recorded");
  assert.equal(frame.originalName, "realName", "the frame carries the map's original identifier");
  assert.ok(frame.source.endsWith(path.join("src", "original.ts")), "source re-pointed at the original");
});

test("a root-absolute local sourceMappingURL re-anchors under the bundle's directory", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-rootmap-"));
  mkdirSync(path.join(dir, "maps"));
  const bundle = path.join(dir, "bundle.js");
  writeFileSync(bundle, "function Bh(){}\n//# sourceMappingURL=/maps/bundle.js.map\n");
  writeFileSync(path.join(dir, "maps", "bundle.js.map"), sourcemapFor("src/original.ts", "realName"));

  const maps = new SourceMapResolver();
  const frame = { source: bundle, line: 1, column: 1 };
  await maps.resolveFrame(frame);

  const diagnostics = maps.diagnostics();
  assert.equal(diagnostics.resolved, 1, "the serving-root path resolved under the bundle dir");
  assert.equal(frame.originalName, "realName");
});

test("served frame with an on-disk bundle but off-disk sourcemap source gets the real served package", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wpd-served-map-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "my-served-app" }));
  mkdirSync(path.join(root, "dist"));
  // The served bundle exists; its sidecar map points sources at a file that is NOT on disk.
  writeFileSync(path.join(root, "dist", "entry.js"), "function hot(){}\n//# sourceMappingURL=entry.js.map\n");
  writeFileSync(path.join(root, "dist", "entry.js.map"), sourcemapFor("../src/off-disk-original.ts", "hot"));
  const servedOrigin = "http://127.0.0.1:57999";
  const model = await buildCpuModel(remoteProfile(`${servedOrigin}/dist/entry.js`), {
    profilePath: "served.cpuprofile",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
    sampleIntervalUs: DEFAULT_CPU_INTERVAL_US,
    serverUrl: servedOrigin,
    root,
  });
  const hot = model.functions.find((fn) => fn.fn === "hot");
  // Re-derived from the served pathname to the real package + relative on-disk file, NOT `(served)`.
  assert.equal(hot.package, "my-served-app");
  assert.equal(hot.file, "dist/entry.js");
});

// Guard: a served frame whose URL is the bare origin (pathname "/") joins "/" to root itself, which
// exists; `packageForFile(root)` would then climb to an ancestor package.json (the stray walk the
// fallback exists to avoid). Such a frame must go to the stable `(served)` bucket. Reached here via
// an origin that MATCHES servedOrigin but string-mismatches serverUrl (rewriteToLocal is a string
// prefix, attributeServedOrigin is origin equality), so the frame stays remote and unresolved.
test("served frame with a bare `/` pathname falls back to (served), never a root-up walk", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wpd-served-root-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "my-served-app" }));
  const model = await buildCpuModel(remoteProfile("http://127.0.0.1:57999"), {
    profilePath: "served.cpuprofile",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
    sampleIntervalUs: DEFAULT_CPU_INTERVAL_US,
    serverUrl: "http://127.0.0.1:57999/",
    root,
  });
  assert.equal(model.functions.find((fn) => fn.fn === "hot").package, "(served)");
});

// The leak the bench sees: a `--bench --url http://127.0.0.1:<port>` run points the page at a host
// server whose port `listen(0)` re-picks every run. An unmapped frame from that origin (its bundle's
// map loaded but position-missed this line) is genuinely remote -- NOT wpd's own served origin -- so
// it reaches unmappedOriginBucket. Keying it by host:port scatters one logical cost across a fresh
// `(127.0.0.1:PORT)` bucket per run and splits every cross-run cpu-diff join. Drop the ephemeral
// port; keep a registered one, which names a service the user runs on purpose.
test("unmapped remote origins: an ephemeral (listen(0)) port is dropped, a registered port is kept", async () => {
  const build = (url) =>
    buildCpuModel(remoteProfile(url), {
      profilePath: "remote.cpuprofile",
      meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
      sampleIntervalUs: DEFAULT_CPU_INTERVAL_US,
      // wpd's own served origin, distinct from the --url host below.
      serverUrl: "http://127.0.0.1:57999",
      root: os.tmpdir(),
    });
  const pkgOf = async (url) => (await build(url)).functions.find((fn) => fn.fn === "hot").package;

  // (a) two runs of the same bench land on different ephemeral --url ports; both bucket by host, so
  // the join holds across runs.
  assert.equal(await pkgOf("http://127.0.0.1:54927/entry.js"), "(127.0.0.1)");
  assert.equal(await pkgOf("http://127.0.0.1:50380/entry.js"), "(127.0.0.1)");

  // (b) a registered port names a stable service (a user's own dev server on --url localhost:3000);
  // it is meaningful across runs, so it stays in the bucket.
  assert.equal(await pkgOf("http://localhost:3000/app.js"), "(localhost:3000)");
  assert.equal(await pkgOf("http://127.0.0.1:9/x.js"), "(127.0.0.1:9)");

  // (c) the ephemeral boundary, pinned at both edges so moving EITHER constant fails: 32767 is the
  // last kept port, 32768 the first ephemeral (dropped, Linux's default listen(0) floor), 65535 the
  // last ephemeral.
  assert.equal(await pkgOf("http://127.0.0.1:32767/x.js"), "(127.0.0.1:32767)");
  assert.equal(await pkgOf("http://127.0.0.1:32768/x.js"), "(127.0.0.1)");
  assert.equal(await pkgOf("http://127.0.0.1:65535/x.js"), "(127.0.0.1)");

  // (d) a real remote host (a CDN) keeps its full authority: the host alone already identifies it.
  assert.equal(await pkgOf("https://cdn.example.com/app.min.js"), "(cdn.example.com)");
});

// The `--breakdown` js-by-package split and the firefox breakdown bar both key on
// `packagesByProfileNode` (per-cpuprofile-node package), so this is where the ephemeral port would
// leak into a span's `jsByPackage`. It shares `resolveCallFrame`, so the same stable bucket applies:
// an unmapped frame from the ephemeral --url host buckets by host across runs.
test("packagesByProfileNode: an unmapped ephemeral --url node buckets by host, feeding a stable jsByPackage", async () => {
  const nodeFor = (url) =>
    packagesByProfileNode(remoteProfile(url), {
      serverUrl: "http://127.0.0.1:57999",
      root: os.tmpdir(),
    });

  const first = await nodeFor("http://127.0.0.1:54927/entry.js");
  const second = await nodeFor("http://127.0.0.1:50380/entry.js");
  // node id 2 is the "hot" frame in remoteProfile; both runs bucket it identically.
  assert.equal(first.get(2), "(127.0.0.1)");
  assert.equal(second.get(2), "(127.0.0.1)");

  const registered = await nodeFor("http://localhost:3000/app.js");
  assert.equal(registered.get(2), "(localhost:3000)");
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

// A map that LOADS fine can still have no mapping entry for a queried line/col. That frame keeps its
// minified/remote identity and buckets by origin -- invisible to the load-failure outcomes, which
// only fire when the map itself cannot be fetched/parsed. The resolver counts hits vs misses per
// script so the leak has a number and a location.
test("SourceMapResolver: a resolved map with sparse mappings counts position hits and misses per script", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-miss-"));
  const bundle = path.join(dir, "entry.js");
  writeFileSync(bundle, "function a(){}\n//# sourceMappingURL=entry.js.map\n");
  // The map maps only generated line 1 (segment "AAAAA"); any other line position-misses it.
  writeFileSync(`${bundle}.map`, sourcemapFor("src/original.ts", "original"));

  const maps = new SourceMapResolver();
  // line 1 col 1 -> looks up line 1 col 0, the one mapped segment: a HIT.
  await maps.resolveFrame({ url: "http://x/entry.js", source: bundle, line: 1, column: 1 });
  // line 3 has no mapping in the map: a MISS on the same, resolved, script.
  await maps.resolveFrame({ url: "http://x/entry.js", source: bundle, line: 3, column: 1 });
  await maps.resolveFrame({ url: "http://x/entry.js", source: bundle, line: 7, column: 1 });

  const diagnostics = maps.diagnostics();
  // The map loaded, so the script is a resolved success, NOT a load failure.
  assert.equal(diagnostics.resolved, 1, "the map resolved");
  assert.equal(diagnostics.failed, undefined, "no load failure");
  // ...yet two of its three queried positions were dropped, and the diagnostics say so.
  assert.deepEqual(diagnostics.positionMisses, { [bundle]: { misses: 2, hits: 1 } });
});

// A map with a mapping for every queried position must NOT appear in positionMisses: only a nonzero
// miss share is worth disclosing, so a fully-mapped run stays silent.
test("SourceMapResolver: a fully-mapped script produces no positionMisses entry", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-hit-"));
  const bundle = path.join(dir, "entry.js");
  writeFileSync(bundle, "function a(){}\n//# sourceMappingURL=entry.js.map\n");
  writeFileSync(`${bundle}.map`, sourcemapFor("src/original.ts", "original"));

  const maps = new SourceMapResolver();
  await maps.resolveFrame({ url: "http://x/entry.js", source: bundle, line: 1, column: 1 });

  const diagnostics = maps.diagnostics();
  assert.equal(diagnostics.resolved, 1);
  assert.equal(diagnostics.positionMisses, undefined, "no miss, so no leak to disclose");
});

// positionMisses is capped and ranked like `failed`: a page can position-miss on hundreds of
// scripts, so diagnostics keeps only the 20 worst, in descending miss order, and `scripts`/`resolved`
// stay the authoritative totals. This drives every script's map to resolve (so the miss path, not a
// load failure, is what fills positionMisses) and gives each a distinct miss count.
test("SourceMapResolver: positionMisses keeps the 20 worst scripts, ranked by miss count", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-cap-"));
  const maps = new SourceMapResolver();
  const totalScripts = 25;
  // Script index `n` (1..25) gets `n` misses: line 1 is the one mapped segment (a hit we avoid), so
  // querying lines 2..n+1 misses n times. Higher index => more misses => higher rank.
  for (let index = 1; index <= totalScripts; index++) {
    const bundle = path.join(dir, `s${index}.js`);
    writeFileSync(bundle, "function a(){}\n");
    // The sidecar `.map` is read first, so each `s{n}.js` resolves its own map (one mapped segment on
    // generated line 1); the resolver caches per script path, so the 25 are independent.
    writeFileSync(`${bundle}.map`, sourcemapFor("src/original.ts", "original"));
    for (let line = 2; line <= index + 1; line++) {
      await maps.resolveFrame({ url: `http://x/s${index}.js`, source: bundle, line, column: 1 });
    }
  }

  const diagnostics = maps.diagnostics();
  // Every map loaded, so all 25 are resolved successes; the cap is on the REPORTED miss list only.
  assert.equal(diagnostics.resolved, totalScripts, "every script's map resolved");
  const entries = Object.entries(diagnostics.positionMisses);
  assert.equal(entries.length, 20, "capped at the 20 worst");

  // The survivors are the top-20 by miss count (scripts 6..25), in strictly descending order.
  const missCounts = entries.map(([, counts]) => counts.misses);
  assert.deepEqual(missCounts, [25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
  // Scripts 1..5 (the fewest misses) were dropped by the cap, not silently merged.
  for (const [script] of entries) {
    const index = Number(path.basename(script).match(/^s(\d+)\.js$/)[1]);
    assert.ok(index >= 6, `script s${index} should have been below the cap`);
  }
});

// Ties in miss count must not ride Map insertion order (frame-processing order across passes, which
// is not stable), or the capped `positionMisses` would vary run to run. The script url breaks ties,
// so the order is deterministic.
test("SourceMapResolver: positionMisses breaks miss-count ties by script url, not insertion order", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-tie-"));
  const maps = new SourceMapResolver();
  // Insert out of sorted order (c, a, b), each with an identical two misses.
  for (const name of ["c", "a", "b"]) {
    const bundle = path.join(dir, `${name}.js`);
    writeFileSync(bundle, "function a(){}\n");
    writeFileSync(`${bundle}.map`, sourcemapFor("src/original.ts", "original"));
    await maps.resolveFrame({ url: `http://x/${name}.js`, source: bundle, line: 2, column: 1 });
    await maps.resolveFrame({ url: `http://x/${name}.js`, source: bundle, line: 3, column: 1 });
  }
  const keys = Object.keys(maps.diagnostics().positionMisses).map((script) => path.basename(script));
  assert.deepEqual(keys, ["a.js", "b.js", "c.js"], "tied scripts are ordered by url, deterministically");
});

// The returned diagnostics must not alias the resolver's live counters: a consumer mutating the
// serialized-out object cannot be allowed to corrupt the resolver's internal state.
test("SourceMapResolver: diagnostics().positionMisses is a copy, not a view of the live counters", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-copy-"));
  const bundle = path.join(dir, "entry.js");
  writeFileSync(bundle, "function a(){}\n");
  writeFileSync(`${bundle}.map`, sourcemapFor("src/original.ts", "original"));
  const maps = new SourceMapResolver();
  await maps.resolveFrame({ url: "http://x/entry.js", source: bundle, line: 2, column: 1 });

  const first = maps.diagnostics();
  first.positionMisses[bundle].misses = 999; // a caller mutating the returned object
  // A fresh diagnostics() call still reflects the true internal count, unaffected by that mutation.
  assert.equal(maps.diagnostics().positionMisses[bundle].misses, 1, "internal counter is untouched");
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

// R20: the remote sourcemap fetcher is bounded on every axis a hostile or slow --url site can abuse.

// (d) private-network + scheme policy. The rule turns on whether the PROFILED PAGE is public: a
// public page's bundle may not steer wpd into the operator's private network, while a served fixture
// or localhost dev server (private page) is expected to reference private hosts.
test("fetchBlockReason: a public page cannot fetch a private host; a private page can", () => {
  // public page (pagePrivate=false)
  assert.equal(fetchBlockReason("http://10.0.0.5/app.js.map", false), "private");
  assert.equal(fetchBlockReason("http://127.0.0.1:8080/app.js.map", false), "private");
  assert.equal(fetchBlockReason("http://192.168.1.9/x.map", false), "private");
  assert.equal(fetchBlockReason("http://cdn.example.com/app.js.map", false), null, "public target ok");
  // private page (pagePrivate=true): the served-fixture / localhost-dev case stays working
  assert.equal(fetchBlockReason("http://127.0.0.1:3000/app.js.map", true), null);
  assert.equal(fetchBlockReason("http://localhost:5173/x.map", true), null);
  // scheme guard is independent of pagePrivate: only http(s) is ever fetched
  assert.equal(fetchBlockReason("file:///etc/passwd", true), "scheme");
  assert.equal(fetchBlockReason("data:text/plain,hi", false), "scheme");
});

test("isPrivateHostname: matches loopback/RFC1918/link-local literals, not public hosts", () => {
  for (const host of [
    "localhost", "app.localhost", "127.0.0.1", "127.5.6.7", "10.1.2.3",
    "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "0.0.0.0", "::1",
  ]) {
    assert.ok(isPrivateHostname(host), `${host} should be private`);
  }
  for (const host of ["cdn.example.com", "8.8.8.8", "172.32.0.1", "192.169.0.1"]) {
    assert.ok(!isPrivateHostname(host), `${host} should be public`);
  }
});

// (b) the per-run time budget: once the deadline is in the past, a lookup records
// fetch-budget-exhausted without touching the network (the frame keeps its minified name).
test("boundedFetch: an exhausted deadline short-circuits to fetch-budget-exhausted", async () => {
  const result = await boundedFetch("http://cdn.example.com/app.js", "script", false, Date.now() - 1);
  assert.deepEqual(result, { ok: false, failure: "fetch-budget-exhausted" });
});

// (d) a blocked target never connects: the policy is checked before fetch.
test("boundedFetch: a public page's fetch of a private host is blocked before connecting", async () => {
  const result = await boundedFetch("http://10.0.0.1/app.js.map", "map", false, Date.now() + 10_000);
  assert.deepEqual(result, { ok: false, failure: "blocked-fetch" });
});

// (a) response-size cap via content-length: an over-cap script is refused without downloading it.
test("boundedFetch: a content-length over the script cap yields script-too-large", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-length", String(25 * 1024 * 1024)); // > 20MB script cap
    res.end("x");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const result = await boundedFetch(
      `http://127.0.0.1:${port}/big.js`, "script", true, Date.now() + 10_000,
    );
    assert.deepEqual(result, { ok: false, failure: "script-too-large" });
  } finally {
    await closeServer(server);
  }
});

// (a) response-size cap via STREAMING: a body that lies about (omits) its length is still aborted
// once it crosses the cap, so an absent content-length cannot smuggle an over-cap body through.
test("boundedFetch: a chunked body over the map cap is aborted mid-stream (map-too-large)", async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x61); // 1MB of 'a'
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    // No content-length => chunked. Stream past the 50MB map cap; the reader aborts before the end.
    for (let sent = 0; sent < 60; sent++) {
      if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
    }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const result = await boundedFetch(
      `http://127.0.0.1:${port}/big.map`, "map", true, Date.now() + 20_000,
    );
    assert.deepEqual(result, { ok: false, failure: "map-too-large" });
  } finally {
    await closeServer(server);
  }
});

// (d) redirects are followed manually and re-checked: a 302 to a non-http(s) scheme is blocked,
// so a redirect cannot escape the fetch policy.
test("boundedFetch: a redirect to a non-http scheme is blocked", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { location: "file:///etc/passwd" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    // private page so the initial 127.0.0.1 hop is allowed; the redirect target is what trips it.
    const result = await boundedFetch(
      `http://127.0.0.1:${port}/redir.js`, "script", true, Date.now() + 10_000,
    );
    assert.deepEqual(result, { ok: false, failure: "blocked-fetch" });
  } finally {
    await closeServer(server);
  }
});

// (c) concurrency: many distinct scripts are fetched at once (not strictly serial) while the
// per-script cache keeps it one fetch each. A serial resolver would take ~N*delay; the bounded-
// concurrency one finishes in a fraction of that.
test("SourceMapResolver.warm: distinct scripts resolve concurrently, each fetched once", async () => {
  const hitsByPath = new Map();
  // The script names its map inline (data URI), so a resolved script is exactly ONE server hit.
  const inlineMap =
    "data:application/json," +
    encodeURIComponent(JSON.stringify({ version: 3, sources: ["s.ts"], names: [], mappings: "AAAA" }));
  const server = http.createServer((req, res) => {
    hitsByPath.set(req.url, (hitsByPath.get(req.url) ?? 0) + 1);
    setTimeout(() => {
      res.setHeader("sourcemap", inlineMap);
      res.end("function a(){}\n");
    }, 60);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const origin = `http://127.0.0.1:${port}`;
    const maps = new SourceMapResolver({ pageUrl: origin }); // private page: fetches allowed
    const targets = Array.from({ length: 8 }, (unused, index) => `${origin}/s${index}.js`);
    const start = Date.now();
    await maps.warm(targets);
    const elapsed = Date.now() - start;
    // 8 scripts * 60ms serial = 480ms; concurrency 4 => ~120ms. Assert well under the serial time.
    assert.ok(elapsed < 400, `expected concurrent (<400ms), took ${elapsed}ms`);
    // Warming twice must not refetch: the cache/in-flight dedup keeps it one fetch per script.
    await maps.warm(targets);
    for (const target of targets) {
      const jsPath = new URL(target).pathname;
      assert.equal(hitsByPath.get(jsPath), 1, `${jsPath} fetched exactly once`);
    }
  } finally {
    await closeServer(server);
  }
});
