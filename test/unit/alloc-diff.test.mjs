import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { allocDiffCmd } from "../../dist/commands/allocdiff.js";
import { SCHEMA_VERSION } from "../../dist/schema.js";
import { tmpDir } from "./helpers.mjs";

const MB = 1024 * 1024;

/** Write a minimal AllocModel fixture the way alloc-diff reads it (totalBytes + one app function). A
 * `sampling` block and `functions[]` make loadAllocModel recognise it as an alloc model */
function writeModel(name, totalMb, meta = {}) {
  const totalBytes = Math.round(totalMb * MB);
  const model = {
    profile: `${name}.heapprofile`,
    meta: {
      tool: "wpd",
      version: "0",
      schemaVersion: SCHEMA_VERSION,
      capture: "node-alloc",
      runtime: "node",
      iterations: 20,
      target: "a.mjs",
      ...meta,
    },
    sampling: { samplingIntervalBytes: 32768, includeMajorGC: true, includeMinorGC: true },
    totalBytes,
    sampleCount: Math.round(totalBytes / 32768),
    functions: [
      { id: 0, fn: "run", source: "a.mjs:1", file: "a.mjs", package: "app", selfBytes: totalBytes, selfPct: 100 },
    ],
  };
  const file = path.join(tmpDir, name);
  writeFileSync(file, JSON.stringify(model), "utf8");
  return file;
}

/** Run alloc-diff --format json, returning { code, result } with console.log captured */
async function runDiff(base, current, opts = {}) {
  const priorLog = console.log;
  const priorError = console.error;
  const priorExit = process.exitCode;
  const lines = [];
  console.log = (line) => lines.push(line);
  console.error = () => {};
  process.exitCode = undefined;
  try {
    await allocDiffCmd(base, current, { failOnRegression: true, format: "json", ...opts });
    return { code: process.exitCode, result: JSON.parse(lines.join("\n")) };
  } finally {
    console.log = priorLog;
    console.error = priorError;
    process.exitCode = priorExit;
  }
}

test("alloc-diff: two identical models produce no regression", async () => {
  const base = writeModel("allocdiff-id-base.alloc.json", 14);
  const current = writeModel("allocdiff-id-cur.alloc.json", 14);
  const { code, result } = await runDiff(base, current);
  assert.equal(code, undefined, "identical totals are not a regression");
  assert.equal(result.netBytes, 0);
});

test("alloc-diff: a within-noise delta (+7%) does not gate; the floor scales to 25% of the baseline", async () => {
  // 14 -> 15 MB is +1 MB = +7.1%, inside the 25% (3.5 MB) floor a 14 MB baseline earns
  const base = writeModel("allocdiff-noise-base.alloc.json", 14);
  const current = writeModel("allocdiff-noise-cur.alloc.json", 15);
  const { code, result } = await runDiff(base, current);
  assert.equal(code, undefined, "a +7% allocation delta is within the scaling floor");
  assert.equal(result.gateFloorBytes, 0.25 * 14 * MB, "the floor is 25% of the 14 MB baseline");
  assert.equal(result.noisePct, 25, "the default relative floor is reported");
});

test("alloc-diff: a +50% regression clears the floor and gates (exit 1)", async () => {
  // 14 -> 21 MB is +7 MB = +50%, well past the 25% (3.5 MB) floor: a real GC-pressure regression
  const base = writeModel("allocdiff-reg-base.alloc.json", 14);
  const current = writeModel("allocdiff-reg-cur.alloc.json", 21);
  const { code, result } = await runDiff(base, current);
  assert.equal(code, 1, "a +50% allocation regression gates");
  assert.ok(result.netBytes > result.gateFloorBytes, "the net clears the gate floor");
  assert.equal(result.byPackage[0].package, "app", "the mover names the allocating package");
});

test("alloc-diff: a tiny-workload delta gates on the 1 MB absolute floor, not a fraction of it", async () => {
  // base 2 MB: 25% would be 0.5 MB, so the 1 MB absolute floor wins; a +0.8 MB delta stays green
  const base = writeModel("allocdiff-abs-base.alloc.json", 2);
  const current = writeModel("allocdiff-abs-cur.alloc.json", 2.8);
  const { code, result } = await runDiff(base, current);
  assert.equal(code, undefined, "a +0.8 MB delta is within the 1 MB absolute floor");
  assert.equal(result.gateFloorBytes, 1 * MB, "the absolute term wins on a tiny workload");
});

test("alloc-diff: --noise-pct widens the relative floor", async () => {
  // 14 -> 21 MB (+50%) gates at the 25% default but passes at --noise-pct 60 (8.4 MB floor)
  const base = writeModel("allocdiff-knob-base.alloc.json", 14);
  const current = writeModel("allocdiff-knob-cur.alloc.json", 21);
  const { code, result } = await runDiff(base, current, { noisePct: 60 });
  assert.equal(code, undefined, "a +50% delta is within a widened 60% floor");
  assert.equal(result.gateFloorBytes, 0.6 * 14 * MB);
});

test("alloc-diff --fail-on-regression REFUSES across an incompatible workload", async () => {
  const base = writeModel("allocdiff-compat-base.alloc.json", 14, { target: "a.mjs" });
  const current = writeModel("allocdiff-compat-cur.alloc.json", 21, { target: "b.mjs" });
  const priorError = console.error;
  const priorExit = process.exitCode;
  console.error = () => {};
  process.exitCode = undefined;
  try {
    await allocDiffCmd(base, current, { failOnRegression: true });
    assert.equal(process.exitCode, 1, "a workload mismatch refuses to gate (exit 1), not a fabricated pass/fail");
  } finally {
    console.error = priorError;
    process.exitCode = priorExit;
  }
});
