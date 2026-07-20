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
