import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assembleTraceCpuProfile,
  windowTraceCpuProfile,
} from "../../dist/trace/profile-chunks.js";
import { buildCpuModel, toDevtoolsCpuProfile } from "../../dist/profile/cpuprofile.js";

// The trace's v8.cpu_profiler ProfileChunk stream, assembled into a CDP-shaped RawCpuProfile. The
// fixture is a cross-process navigation: two (pid, Profile id) streams, each restarting its node-id
// space at 1, so a naive concat would conflate their roots. window.burn runs before the navigation
// (pid 100), window.work after it (pid 200).
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/v8-cpu-profiler-chunks.trimmed.json", import.meta.url)),
    "utf8",
  ),
);

test("assembleTraceCpuProfile: merges the per-process streams into one disjoint node-id space", () => {
  const assembled = assembleTraceCpuProfile(fixture);
  assert.ok(assembled, "the fixture carries a chunk stream");
  const { profile } = assembled;

  // Six nodes: two streams of three, renumbered 1..6 with no collision.
  assert.equal(profile.nodes.length, 6, "both streams' nodes are present, renumbered");
  const ids = profile.nodes.map((node) => node.id).sort((left, right) => left - right);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6], "node ids are one disjoint 1..6 space");

  // Two roots (one per process): buildCpuModel derives roots as nodes that are no one's child.
  const childIds = new Set(profile.nodes.flatMap((node) => node.children ?? []));
  const roots = profile.nodes.filter((node) => !childIds.has(node.id));
  assert.equal(roots.length, 2, "each stream keeps its own (root)");

  // parent -> children was inverted: each (root) has its (program)/leaf as children.
  for (const root of roots)
    assert.ok((root.children ?? []).length >= 1, "the root's parent links became children");

  // 6 samples in stream A + 3 in stream B, all mapped to real node ids (none dropped/conflated).
  assert.equal(profile.samples.length, 9, "every sample survived the merge");
  assert.ok(
    profile.samples.every((nodeId) => ids.includes(nodeId)),
    "each sample references a merged node id",
  );
});

test("assembleTraceCpuProfile: per-sample timestamps are absolute, trace-native, and ascending", () => {
  const { profile } = assembleTraceCpuProfile(fixture);
  const timestamps = profile.sampleTimestampsUs;
  assert.ok(Array.isArray(timestamps) && timestamps.length === 9, "one timestamp per sample");
  // Stream A starts at 1_000_000; stream B at 2_000_000 (after the navigation). Both share the trace
  // clock, so B's samples sit ~1s after A's, and the merged series is strictly ascending.
  for (let index = 1; index < timestamps.length; index++)
    assert.ok(timestamps[index] >= timestamps[index - 1], "timestamps are non-decreasing");
  assert.ok(timestamps[0] >= 1_000_000 && timestamps[0] < 1_100_000, "first sample is in stream A");
  assert.ok(timestamps[timestamps.length - 1] >= 2_000_000, "last sample is in stream B");
  assert.equal(profile.startTime, 1_000_000, "startTime is the earliest stream's base clock");
});

test("assembleTraceCpuProfile: reads the interval back from the chunk deltas", () => {
  const { sampleIntervalUs } = assembleTraceCpuProfile(fixture);
  assert.equal(sampleIntervalUs, 150, "median inter-sample delta, not the 200us default constant");
});

test("assembleTraceCpuProfile: buildCpuModel runs UNCHANGED and attributes BOTH documents", async () => {
  const { profile, sampleIntervalUs } = assembleTraceCpuProfile(fixture);
  const model = await buildCpuModel(profile, {
    profilePath: "/tmp/x.cpuprofile",
    meta: { schemaVersion: "3" },
    sampleIntervalUs,
    root: os.tmpdir(),
  });
  const names = model.functions.map((fn) => fn.fn);
  assert.ok(names.includes("burn"), "the pre-navigation function is attributed");
  assert.ok(names.includes("work"), "the post-navigation function is attributed too");
  // burn got 5 samples, work 3, at 150us each: their self-time reflects both documents' work summed.
  const burn = model.functions.find((fn) => fn.fn === "burn");
  const work = model.functions.find((fn) => fn.fn === "work");
  assert.ok(burn.selfMs > work.selfMs, "burn (5 samples) outweighs work (3 samples)");
  assert.ok(model.scriptingMs > 0, "the merged model has real scripting time");
});

test("assembleTraceCpuProfile: no chunk stream yields null (the honest not-covered fallback)", () => {
  assert.equal(assembleTraceCpuProfile({ traceEvents: [] }), null, "empty trace: null, never a zero profile");
  assert.equal(
    assembleTraceCpuProfile({ traceEvents: [{ name: "RunTask", ph: "X", ts: 1, dur: 2 }] }),
    null,
    "a trace without Profile/ProfileChunk events: null",
  );
});

test("toDevtoolsCpuProfile: a navigation merge becomes a single-rooted, real-timeline DevTools file", () => {
  const { profile } = assembleTraceCpuProfile(fixture);
  // Precondition: the model profile is two-rooted (one (root) per process) and carries the lane field.
  const modelChildIds = new Set(profile.nodes.flatMap((node) => node.children ?? []));
  assert.equal(profile.nodes.filter((node) => !modelChildIds.has(node.id)).length, 2, "model keeps both roots");

  const disk = toDevtoolsCpuProfile(profile);
  assert.equal(disk.sampleTimestampsUs, undefined, "the lane-only field is stripped from the disk file");
  const diskChildIds = new Set(disk.nodes.flatMap((node) => node.children ?? []));
  const roots = disk.nodes.filter((node) => !diskChildIds.has(node.id));
  assert.equal(roots.length, 1, "DevTools file is single-rooted: a super-root parents the process roots");
  assert.deepEqual(roots[0].children.length, 2, "the super-root parents both process (root) nodes");

  // The deltas are recomputed from the absolute timestamps, so DevTools reconstructs the real timeline
  // (startTime + cumulative deltas), including the ~1s navigation gap the model's per-sample deltas omit.
  assert.equal(disk.startTime, profile.sampleTimestampsUs[0], "startTime is the first sample's clock");
  const reconstructed = disk.timeDeltas.reduce((sum, delta) => sum + delta, disk.startTime);
  assert.equal(reconstructed, profile.sampleTimestampsUs.at(-1), "cumulative deltas rebuild the last sample's clock");
  assert.ok(disk.timeDeltas.some((delta) => delta > 100000), "the cross-process gap survives as a large delta");
});

test("toDevtoolsCpuProfile: a single-stream profile is returned unchanged (already CDP-shaped)", () => {
  const singleStream = {
    nodes: [{ id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 } }],
    startTime: 5,
    endTime: 6,
    samples: [1],
    timeDeltas: [1],
  };
  assert.equal(toDevtoolsCpuProfile(singleStream), singleStream, "no sampleTimestampsUs => returned as-is");
});

test("windowTraceCpuProfile: drops samples before the run start (prepare/warmup exclusion)", () => {
  const { profile } = assembleTraceCpuProfile(fixture);
  // Keep only stream B (>= 2_000_000): the pre-navigation samples are dropped, as prepare()/warmup
  // samples are on the driver lane where the trace starts before the run window.
  const windowed = windowTraceCpuProfile(profile, 2_000_000);
  assert.equal(windowed.samples.length, 3, "only the post-2_000_000 samples remain");
  assert.ok(
    windowed.sampleTimestampsUs.every((ts) => ts >= 2_000_000),
    "no sample earlier than the window start survives",
  );
  // The nodes/tree are kept intact; buildCpuModel bills self only from the surviving samples.
  assert.equal(windowed.nodes.length, profile.nodes.length, "nodes are untouched, only samples filtered");
});
