import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hostCpuWorkBlock,
  hostCpuIndexFromMedianMs,
  measureHostCpuIndex,
} from "../../dist/model/host-cpu.js";

// Determinism in WORK: the block is a straight-line loop of fixed length with no data-dependent
// branch, so the same input runs the same operations and returns the same value. Equal output across
// repeated calls (and across two callers) is the observable proof the operation count is fixed -- only
// the DURATION a machine takes to run it varies.
test("host-cpu: the work block is deterministic in work (same input -> same output)", () => {
  assert.equal(hostCpuWorkBlock(50_000), hostCpuWorkBlock(50_000));
  assert.equal(hostCpuWorkBlock(1), hostCpuWorkBlock(1));
  assert.ok(Number.isFinite(hostCpuWorkBlock(200_000)), "the bounded accumulator never reaches Infinity");
});

// The index formula: throughput (work per ms), scaled and rounded. Monotonic (a faster host runs the
// block in less time -> smaller medianMs -> larger index), and larger for more work at a fixed time.
test("host-cpu: the index is monotonic in speed and scales with work", () => {
  const fast = hostCpuIndexFromMedianMs(10, 1_000_000);
  const slow = hostCpuIndexFromMedianMs(30, 1_000_000);
  assert.ok(fast > slow, "less time for the same work reads as a faster host");
  assert.equal(hostCpuIndexFromMedianMs(10, 1_000_000), 2000);
  assert.equal(hostCpuIndexFromMedianMs(20, 1_000_000), 1000, "double the time halves the index");
  assert.equal(hostCpuIndexFromMedianMs(0, 1_000_000), 0, "a non-positive median yields 0, never Infinity");
});

// With the clock mocked to a fixed sequence, the index is fully determined by the injected durations,
// not the machine the test runs on: the same machine-dependence lives ONLY in the timing. Durations
// [10, 30, 20] -> median 20 -> index = round(100000 / 20 / 50) = 100.
test("host-cpu: measure derives the index from the MEDIAN block duration (timing mocked)", () => {
  const reads = [0, 10, 100, 130, 200, 220];
  let cursor = 0;
  const now = () => reads[cursor++];
  const index = measureHostCpuIndex({ now, samples: 3, blockIterations: 100_000 });
  assert.equal(index, 100, "median of [10,30,20] is 20; index = round(100000/20/50)");
});

// End to end on the real clock: a positive, finite, plausibly-benchmarkIndex-magnitude scalar.
test("host-cpu: a real measurement is a positive finite scalar", () => {
  const index = measureHostCpuIndex();
  assert.ok(Number.isInteger(index), "the stamped index is a rounded integer");
  assert.ok(index > 0 && Number.isFinite(index), "a real host reads a positive finite index");
});
