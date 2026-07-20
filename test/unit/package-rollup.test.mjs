import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { buildCpuModel, packageRollup } from "../../dist/profile/cpuprofile.js";
import { sourcemapFor } from "./helpers.mjs";

const META = { tool: "wpd", version: "0.0.0", schemaVersion: "1" };

/** One hot node calling a bundled function served over a file:// url, plus the (root) parent. */
function bundleProfile(bundlePath) {
  return {
    startTime: 0,
    endTime: 1000,
    nodes: [
      {
        id: 1,
        callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 },
        children: [2],
      },
      {
        id: 2,
        callFrame: {
          functionName: "minified",
          scriptId: "1",
          url: pathToFileURL(bundlePath).href,
          // CDP is 0-based: lineNumber 0 / columnNumber 0 -> line 1 / column 1, which is the single
          // "AAAAA" segment sourcemapFor emits, so the frame resolves through the map.
          lineNumber: 0,
          columnNumber: 0,
        },
        children: [],
      },
    ],
    samples: [2],
    timeDeltas: [1000],
  };
}

/** A bundle + sibling .map whose only source is `source`. Returns the file:// bundle path. */
function writeBundle(dir, name, source) {
  mkdirSync(dir, { recursive: true });
  const bundlePath = path.join(dir, `${name}.js`);
  writeFileSync(bundlePath, `function minified(){}\n//# sourceMappingURL=${name}.js.map\n`);
  writeFileSync(`${bundlePath}.map`, sourcemapFor(source, "styledFn"));
  return bundlePath;
}

async function modelFor(bundlePath, root) {
  return buildCpuModel(bundleProfile(bundlePath), {
    profilePath: "probe.cpuprofile",
    meta: META,
    sampleIntervalUs: 200,
    root,
    runtime: "node",
  });
}

test("packageRollup: a sourcemap pointing off-disk buckets as (unmapped: <dir>), never app", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wpd-offdisk-"));
  // The map's source is absolute and NOT on disk (a dependency built from a workspace/source
  // checkout the recorder does not have). Its containing dir names the bucket.
  const phantom = path.join(os.tmpdir(), `wpd-phantom-${Date.now()}-checkout`, "runtime", "styled.ts");
  const bundle = writeBundle(path.join(root, "vendor"), "styled", phantom);

  const model = await modelFor(bundle, root);
  const styled = model.functions.find((fn) => fn.fn === "styledFn");
  assert.ok(styled, "the bundled function is ranked");
  assert.equal(styled.package, "(unmapped: runtime)");
  assert.notEqual(styled.package, "app");
  // The map LOADED, so this is not counted in unmappedFrames (which drives the map-load-health
  // warning); the parenthesized bucket name is the rollup's own honest "owner unknown" signal.
  assert.equal(model.unmappedFrames, 0);

  const rollup = packageRollup(model);
  assert.ok(
    rollup.some((entry) => entry.key === "(unmapped: runtime)"),
    "rollup carries the honest off-disk bucket",
  );
  assert.ok(!rollup.some((entry) => entry.key === "app"), "nothing mis-buckets as app");
});

test("packageRollup: an off-disk map on a bundle inside node_modules recovers the package name", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wpd-linked-"));
  // Bundle physically under node_modules/next-yak, but its map points off-disk (no node_modules in
  // the mapped source). The code really is next-yak; recovery comes from the bundle url, not "app".
  const phantom = path.join(os.tmpdir(), `wpd-phantom-${Date.now()}-checkout`, "runtime", "styled.tsx");
  const bundle = writeBundle(
    path.join(root, "node_modules", "next-yak", "dist"),
    "styled",
    phantom,
  );

  const model = await modelFor(bundle, root);
  const styled = model.functions.find((fn) => fn.fn === "styledFn");
  assert.ok(styled, "the bundled function is ranked");
  assert.equal(styled.package, "next-yak");
  assert.equal(model.unmappedFrames, 0);
});

test("packageRollup: a map to an existing on-disk source still uses the nearest package.json name", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wpd-ondisk-"));
  // A real local workspace package: the mapped source EXISTS on disk, so the nearest package.json
  // name wins (the documented monorepo-workspace attribution, unchanged by the off-disk fix).
  const pkgDir = path.join(root, "packages", "ui");
  mkdirSync(path.join(pkgDir, "src"), { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@acme/ui", version: "1.0.0" }));
  writeFileSync(path.join(pkgDir, "src", "button.ts"), "export const Button = () => {};\n");
  // Map source is relative to the bundle's own directory (packages/ui/dist) and resolves to the
  // existing packages/ui/src/button.ts.
  const bundle = writeBundle(path.join(pkgDir, "dist"), "button", "../src/button.ts");

  const model = await modelFor(bundle, root);
  const styled = model.functions.find((fn) => fn.fn === "styledFn");
  assert.ok(styled, "the bundled function is ranked");
  assert.equal(styled.package, "@acme/ui");
  assert.equal(model.unmappedFrames, 0);
});

/** A bundle + map naming ONE off-disk source, plus a named hot function. Returns the bundle path. */
function writeNamedBundle(dir, name, source, fnName) {
  mkdirSync(dir, { recursive: true });
  const bundlePath = path.join(dir, `${name}.js`);
  writeFileSync(bundlePath, `function minified(){}\n//# sourceMappingURL=${name}.js.map\n`);
  writeFileSync(`${bundlePath}.map`, sourcemapFor(source, fnName));
  return bundlePath;
}

/** A profile whose leaves are the given (fnName, bundlePath) frames under one (root). */
function multiFrameProfile(frames) {
  const nodes = [
    { id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 }, children: frames.map((frame, index) => index + 2) },
  ];
  frames.forEach(([fnName, bundlePath], index) => {
    nodes.push({
      id: index + 2,
      callFrame: { functionName: fnName, scriptId: String(index + 2), url: pathToFileURL(bundlePath).href, lineNumber: 0, columnNumber: 0 },
      children: [],
    });
  });
  return { startTime: 0, endTime: frames.length * 1000, nodes, samples: frames.map((frame, index) => index + 2), timeDeltas: frames.map(() => 1000) };
}

async function multiModel(frames, root) {
  return buildCpuModel(multiFrameProfile(frames), {
    profilePath: "probe.cpuprofile",
    meta: META,
    sampleIntervalUs: 200,
    root,
    runtime: "node",
  });
}

test("packageRollup: one library's off-disk sources under <pkg>/src/* collapse to ONE bucket", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wpd-offsplit-"));
  // A published package "design-system" whose compiled output ships in the app bundle but whose
  // sourcemapped originals (design-system/src/runtime, design-system/src/core) are NOT on disk. The
  // segment before the first source-layout dir (src) names the package, so the two sub-directories
  // must NOT split into (unmapped: runtime) + (unmapped: core).
  const off = path.join(os.tmpdir(), `wpd-off-${Date.now()}`, "design-system", "src");
  const model = await multiModel([
    ["tokensFn", writeNamedBundle(path.join(root, "vendor"), "a", path.join(off, "runtime", "tokens.ts"), "tokensFn")],
    ["themeFn", writeNamedBundle(path.join(root, "vendor"), "b", path.join(off, "core", "theme.ts"), "themeFn")],
  ], root);

  const packages = new Set(model.functions.map((fn) => fn.package));
  assert.deepEqual([...packages], ["(unmapped: design-system)"], "the library is ONE bucket, not one per source directory");
  assert.ok(!model.functions.some((fn) => fn.package === "app"), "nothing mis-buckets as app");
  const rollup = packageRollup(model);
  assert.equal(rollup.length, 1, "the per-package story is one row for the library");
  assert.equal(rollup[0].key, "(unmapped: design-system)");
});

test("packageRollup: a nested off-disk path names the inner package, not the outer source dir", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wpd-offnest-"));
  // A vendored dependency nested under an outer build dir: .../src/vendor/<pkg>/dist/x. The LAST
  // source-layout dir (dist) wins, so the segment before it (widgets) names the package, not the
  // outer `src`.
  const off = path.join(os.tmpdir(), `wpd-off-${Date.now()}`, "src", "vendor", "widgets", "dist", "index.ts");
  const model = await multiModel([["nestedFn", writeNamedBundle(path.join(root, "vendor"), "d", off, "nestedFn")]], root);
  const nested = model.functions.find((fn) => fn.fn === "nestedFn");
  assert.ok(nested, "the bundled function is ranked");
  assert.equal(nested.package, "(unmapped: widgets)");
  assert.notEqual(nested.package, "app");
});

test("packageRollup: a scoped package in an off-disk path is recovered as its @scope/name", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wpd-offscope-"));
  // No node_modules and no source-layout dir, but a @scope/name pair sits in the phantom path: an
  // unambiguous owner, so the bucket names the scoped package rather than a stray directory.
  const off = path.join(os.tmpdir(), `wpd-off-${Date.now()}`, "@acme", "widgets", "internal", "grid.ts");
  const model = await multiModel([["gridFn", writeNamedBundle(path.join(root, "vendor"), "c", off, "gridFn")]], root);
  const grid = model.functions.find((fn) => fn.fn === "gridFn");
  assert.ok(grid, "the bundled function is ranked");
  assert.equal(grid.package, "(unmapped: @acme/widgets)");
  assert.notEqual(grid.package, "app");
});
