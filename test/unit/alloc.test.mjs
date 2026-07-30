import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAllocModel,
  packageAllocRollup,
  fileAllocRollup,
} from "../../dist/profile/allocprofile.js";

const META = { tool: "wpd", version: "0.0.0", schemaVersion: "1" };
const SAMPLING = { samplingIntervalBytes: 32768, includeMajorGC: true, includeMinorGC: true };

/** A synthetic heap sampling profile: a (root) with three allocating leaves (two node builtins, one
 * native frame with no url), so package attribution and the byte ranking are deterministic */
function heapProfile() {
  return {
    head: {
      id: 1,
      callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 },
      selfSize: 0,
      children: [
        {
          id: 2,
          callFrame: { functionName: "readFileSync", scriptId: "2", url: "node:fs", lineNumber: 10, columnNumber: 2 },
          selfSize: 3000,
          children: [],
        },
        {
          id: 3,
          callFrame: { functionName: "parse", scriptId: "3", url: "node:internal/json", lineNumber: 5, columnNumber: 1 },
          selfSize: 1000,
          children: [],
        },
        {
          id: 4,
          callFrame: { functionName: "nativeAlloc", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 },
          selfSize: 6000,
          children: [],
        },
      ],
    },
    samples: [
      { size: 3000, nodeId: 2, ordinal: 0 },
      { size: 1000, nodeId: 3, ordinal: 1 },
      { size: 6000, nodeId: 4, ordinal: 2 },
    ],
  };
}

async function modelFor(profile) {
  return buildAllocModel(profile, {
    profilePath: "probe.heapprofile",
    meta: META,
    sampling: SAMPLING,
    root: process.cwd(),
    runtime: "node",
  });
}

test("buildAllocModel: totalBytes sums rankable frames only, excluding the (root) pseudo-frame", async () => {
  const model = await modelFor(heapProfile());
  // (root) contributes selfSize 0 and is not rankable; the three leaves sum to 10000
  assert.equal(model.totalBytes, 10000);
  assert.equal(model.sampleCount, 3);
  assert.equal(model.functions.length, 3);
  // No (root) row in the ranked functions
  assert.ok(!model.functions.some((fn) => fn.fn === "(root)"), "(root) is not a ranked function");
});

test("buildAllocModel: functions rank by self bytes descending, share denominates on totalBytes", async () => {
  const model = await modelFor(heapProfile());
  assert.equal(model.functions[0].fn, "nativeAlloc");
  assert.equal(model.functions[0].selfBytes, 6000);
  assert.equal(model.functions[0].id, 0);
  // 6000 / 10000 = 60%
  assert.ok(Math.abs(model.functions[0].selfPct - 60) < 1e-9, `share is 60%, got ${model.functions[0].selfPct}`);
  const shareSum = model.functions.reduce((sum, fn) => sum + fn.selfPct, 0);
  assert.ok(Math.abs(shareSum - 100) < 1e-9, `function shares reconcile to 100%, got ${shareSum}`);
});

test("buildAllocModel: node builtins bucket to (node), a urlless frame to (native)", async () => {
  const model = await modelFor(heapProfile());
  const packages = new Set(model.functions.map((fn) => fn.package));
  assert.ok(packages.has("(node)"), "node: builtins bucket to (node)");
  assert.ok(packages.has("(native)"), "a urlless allocation buckets to (native)");
});

test("packageAllocRollup: sums per package, denominated on totalBytes so shares add to 100%", async () => {
  const model = await modelFor(heapProfile());
  const rollup = packageAllocRollup(model);
  const native = rollup.find((entry) => entry.key === "(native)");
  const node = rollup.find((entry) => entry.key === "(node)");
  assert.equal(native.selfBytes, 6000);
  assert.equal(node.selfBytes, 4000, "the two node: frames sum into one (node) bucket");
  assert.equal(node.functions, 2, "two functions rolled into (node)");
  // Descending by bytes: (native) 6000 leads (node) 4000
  assert.equal(rollup[0].key, "(native)");
  const shareSum = rollup.reduce((sum, entry) => sum + entry.selfPct, 0);
  assert.ok(Math.abs(shareSum - 100) < 1e-9, `package shares reconcile to 100%, got ${shareSum}`);
});

test("fileAllocRollup: groups by file; the urlless (native) frame keeps its (native) bucket", async () => {
  const model = await modelFor(heapProfile());
  const rollup = fileAllocRollup(model);
  assert.ok(rollup.some((entry) => entry.key === "node:fs" && entry.selfBytes === 3000));
  assert.ok(rollup.some((entry) => entry.key === "(native)" && entry.selfBytes === 6000));
});

test("buildAllocModel: the sampling config round-trips onto the model verbatim", async () => {
  const model = await modelFor(heapProfile());
  assert.deepEqual(model.sampling, SAMPLING);
  assert.equal(model.sampling.includeMajorGC, true);
  assert.equal(model.sampling.includeMinorGC, true);
});

test("buildAllocModel: an all-zero (root)-only profile is totalBytes 0 with no NaN shares", async () => {
  const empty = {
    head: {
      id: 1,
      callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 },
      selfSize: 0,
      children: [],
    },
    samples: [],
  };
  const model = await modelFor(empty);
  assert.equal(model.totalBytes, 0);
  assert.equal(model.functions.length, 0);
  assert.equal(model.sampleCount, 0);
});
