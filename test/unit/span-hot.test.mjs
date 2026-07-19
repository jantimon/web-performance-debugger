import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  tallySpanHot,
  MIN_POOLED_HOT_SAMPLES,
} from "../../dist/profile/span-hot.js";
import { buildCpuModel, functionIdByNode } from "../../dist/profile/cpuprofile.js";
import { syntheticProfile } from "./helpers.mjs";

// The per-span hot tally is a pure function (samples + windows -> top-K refs). These pin the
// load-bearing behaviours: the CPU-sampler scripting axis (never the bar's js slice), MEASURE-only
// pooling across occurrences, the pooled + per-function floors, the Σ selfMs <= window wall invariant,
// and the deterministic tie-break. Fixtures use a 200us interval and a ts space shared with windows.

const INTERVAL_US = 200;
const sample = (ts, functionId) => ({ ts, functionId });

test("tallySpanHot pools across measure occurrences and ranks by pooled sample count", () => {
  // Two occurrence windows; fn 0 appears in both, fn 1 in one. A null-function sample and an
  // out-of-window sample never count.
  const samples = [
    sample(10, 0), sample(15, 0), sample(20, 0), sample(25, 0), sample(30, 0), sample(40, 1),
    sample(210, 0), sample(220, 0), sample(230, 1), sample(240, 1),
    sample(250, null), // idle/system: excluded
    sample(500, 0), // outside both windows: excluded
  ];
  const windows = [{ startTs: 0, endTs: 100 }, { startTs: 200, endTs: 300 }];
  const hot = tallySpanHot(samples, windows, "measure-pooled", INTERVAL_US);

  assert.equal(hot.scope, "measure-pooled");
  assert.equal(hot.occurrences, 2, "both occurrence windows are disclosed");
  assert.equal(hot.pooledSamples, 10, "5 fn0 + 2 fn0 + 3 fn1 across both windows; null/out excluded");
  assert.ok(!hot.suppressed);
  assert.equal(hot.functions.length, 2);
  assert.deepEqual(
    hot.functions.map((ref) => ref.id),
    [0, 1],
    "ranked by pooled samples: fn0 (7) before fn1 (3)",
  );
  assert.equal(hot.functions[0].samples, 7);
  assert.equal(hot.functions[1].samples, 3);
  assert.equal(hot.functions[0].selfMs, 1.4, "selfMs = samples * interval (7 * 200us = 1.4ms)");
  assert.equal(hot.functions[1].selfMs, 0.6);
});

test("tallySpanHot suppresses the ranked list below the pooled floor, keeping the disclosure fields", () => {
  const samples = [sample(10, 0), sample(20, 0), sample(30, 0), sample(40, 1)];
  const hot = tallySpanHot(samples, [{ startTs: 0, endTs: 100 }], "step-window", INTERVAL_US);
  assert.ok(4 < MIN_POOLED_HOT_SAMPLES);
  assert.equal(hot.suppressed, true, "below 10 pooled samples: suppressed, never a fabricated top-N");
  assert.equal(hot.functions, undefined, "no functions when suppressed");
  assert.equal(hot.pooledSamples, 4, "the pooled count is still disclosed for the raise-iterations hint");
  assert.equal(hot.occurrences, 1);
});

test("tallySpanHot drops functions below the per-function floor even when the pool clears", () => {
  // fn0 x8, fn1 x2 (below 3), fn2 x3 -> pooled 13 clears the floor; fn1 is dropped from the list.
  const samples = [
    ...Array.from({ length: 8 }, (_unused, index) => sample(index * 5, 0)),
    sample(100, 1), sample(105, 1),
    sample(200, 2), sample(205, 2), sample(210, 2),
  ];
  const hot = tallySpanHot(samples, [{ startTs: 0, endTs: 1000 }], "step-window", INTERVAL_US);
  assert.equal(hot.pooledSamples, 13, "every ranked sample is pooled, including the sub-floor fn1");
  assert.deepEqual(hot.functions.map((ref) => ref.id), [0, 2], "fn1 (2 samples) is below the per-function floor");
});

test("tallySpanHot tie-breaks equal sample counts by ascending id (stable)", () => {
  const samples = [
    ...Array.from({ length: 5 }, (_unused, index) => sample(index, 5)),
    ...Array.from({ length: 5 }, (_unused, index) => sample(50 + index, 0)),
  ];
  const hot = tallySpanHot(samples, [{ startTs: 0, endTs: 1000 }], "step-window", INTERVAL_US);
  assert.deepEqual(hot.functions.map((ref) => ref.id), [0, 5], "equal counts: lower id (higher run rank) first");
});

test("tallySpanHot honours the Σ selfMs <= window wall invariant, never <= the bar's js slice", () => {
  // 10 samples spaced one interval apart inside a window exactly 10 intervals wide.
  const samples = Array.from({ length: 10 }, (_unused, index) => sample(index * INTERVAL_US, 0));
  const windowUs = 10 * INTERVAL_US;
  const hot = tallySpanHot(samples, [{ startTs: 0, endTs: windowUs }], "measure-pooled", INTERVAL_US);
  const selfUs = hot.functions.reduce((total, ref) => total + ref.samples, 0) * INTERVAL_US;
  assert.ok(selfUs <= windowUs, "pooled sampled time cannot exceed the span's own window wall");
  assert.ok(hot.pooledSamples * INTERVAL_US <= windowUs, "the pool as a whole obeys the same wall bound");
});

test("tallySpanHot caps the stored list at topK", () => {
  // 12 distinct functions, each above the per-function floor.
  const samples = [];
  for (let functionId = 0; functionId < 12; functionId++)
    for (let repeat = 0; repeat < 4; repeat++) samples.push(sample(functionId * 100 + repeat, functionId));
  const hot = tallySpanHot(samples, [{ startTs: 0, endTs: 100000 }], "step-window", INTERVAL_US, 8);
  assert.equal(hot.functions.length, 8, "top-K bound keeps the stored refs digest-sized");
  assert.equal(hot.pooledSamples, 48, "pooledSamples counts every sample, not just the stored top-K");
});

test("tallySpanHot merges out-of-order and overlapping windows so an overlap never double-counts", () => {
  // Windows given out of order and overlapping: [200,300] and [0,150] and [100,250]. Merged they
  // cover [0,300] as one disjoint span. A sample at ts 120 sits in the [0,150]/[100,250] overlap and
  // must count exactly ONCE, exactly as a membership `some()` over the raw windows counts it once.
  const samples = [
    sample(10, 0), sample(120, 0), sample(140, 0), sample(160, 0), sample(180, 0),
    sample(210, 0), sample(230, 1), sample(250, 1), sample(270, 1), sample(290, 1),
    sample(400, 0), // past the merged span: excluded by the early break
  ];
  const outOfOrderOverlapping = [
    { startTs: 200, endTs: 300 },
    { startTs: 0, endTs: 150 },
    { startTs: 100, endTs: 250 },
  ];
  const hot = tallySpanHot(samples, outOfOrderOverlapping, "measure-pooled", INTERVAL_US);

  // Cross-check against the pre-optimization semantics: a membership test over the RAW windows.
  const bySome = samples.filter(
    (candidate) =>
      candidate.functionId != null &&
      outOfOrderOverlapping.some((window) => candidate.ts >= window.startTs && candidate.ts <= window.endTs),
  );
  assert.equal(hot.pooledSamples, bySome.length, "moving-pointer pool matches the raw some() membership");
  assert.equal(hot.pooledSamples, 10, "the overlap sample (ts 120) counts once, the ts-400 sample is excluded");
  assert.equal(hot.occurrences, 3, "occurrences discloses the raw window count, not the merged count");
  assert.deepEqual(hot.functions.map((ref) => ref.id), [0, 1], "fn0 (6) before fn1 (4), no double-count");
});

// The join is the feature's correctness hinge: a stored ref's id must index the EXACT function the
// resolved CpuModel ranks, or the panel names the wrong code. functionIdByNode reproduces
// buildCpuModel's rank (pure over raw), so this asserts the two agree, including under recursion
// (alpha appears at two nodes -> one id).
test("functionIdByNode assigns the same ids buildCpuModel's functions[] carry", async () => {
  const raw = syntheticProfile();
  const model = await buildCpuModel(raw, {
    profilePath: "synthetic.cpuprofile",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1" },
    sampleIntervalUs: INTERVAL_US,
    root: os.tmpdir(),
    runtime: "node",
  });
  const ids = functionIdByNode(raw);

  // model.functions: beta (self 2.0) id 0, alpha (self 1.5) id 1.
  const betaId = model.functions.findIndex((fn) => fn.fn === "beta");
  const alphaId = model.functions.findIndex((fn) => fn.fn === "alpha");
  assert.equal(ids.get(3), betaId, "node 3 (beta) joins to beta's model id");
  assert.equal(ids.get(2), alphaId, "node 2 (alpha) joins to alpha's model id");
  assert.equal(ids.get(4), alphaId, "the recursed alpha node joins to the SAME id");
  for (const systemNode of [1, 5, 6])
    assert.ok(!ids.has(systemNode), "(root)/(idle)/(garbage collector) earn no id, never a phantom");
  // Every joined id resolves to a real function name matching the node's frame.
  assert.equal(model.functions[ids.get(3)].fn, "beta");
  assert.equal(model.functions[ids.get(2)].fn, "alpha");
});
