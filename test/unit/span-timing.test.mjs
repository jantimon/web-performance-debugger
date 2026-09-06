import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { decode } from "@toon-format/toon";
import { querySpan } from "../../dist/commands/query.js";
import { notMeasuredSpanCounts } from "../../dist/model/span.js";

const directory = mkdtempSync(path.join(tmpdir(), "wpd-span-timing-"));
const stats = { samples: 3, minMs: 1, medianMs: 3, meanMs: 4, maxMs: 8 };
const bar = (wallMs) => ({
  wallMs,
  slices: {
    js: { ms: 1, byPackage: { app: 1 } },
    style: { ms: 0 }, layout: { ms: 0 }, paint: { ms: 0 },
    gc: { ms: 0 }, other: { ms: 0 }, idle: { ms: wallMs - 1 },
  },
});
const span = (kind, extra = {}) => ({
  label: kind === "run" ? "run" : "work", kind,
  aggregation: kind === "run" ? "sum" : "first",
  wallMs: 12, wallClock: "page", counts: notMeasuredSpanCounts(), ...extra,
});
function recording(name, spans, capture = "breakdown") {
  const file = path.join(directory, name);
  writeFileSync(file, JSON.stringify({
    meta: { schemaVersion: "5", target: "chrome", iterations: 3, capture },
    window: { startTs: 0, endTs: 100000 }, events: [], spans,
  }));
  return file;
}
async function query(file, label, format = "json") {
  const log = console.log;
  let text = "";
  console.log = (line) => { text += `${line}\n`; };
  try { await querySpan(file, label, { format }); }
  finally { console.log = log; }
  return format === "json" ? JSON.parse(text) : decode(text);
}

test("run timing exposes captured samples rather than dividing the profile window", async () => {
  const file = recording("run.json", [span("run", { perIteration: [8, 1, 3], breakdown: bar(100) })]);
  for (const format of ["json", "toon"]) {
    const result = await query(file, "run", format);
    assert.equal(result.wallMs, 100);
    assert.deepEqual(result.timing, {
      sampleUnit: "iteration", boundary: "run-call", clock: "page", samplesMs: [8, 1, 3], stats,
    });
  }
});

test("step timing keeps its clock and sample order separate from the first profile window", async () => {
  const file = recording("step.json", [span("step", { wallClock: "trace", perIteration: [8, 1, 3], wallMs: 3, breakdown: bar(8) })]);
  const result = await query(file, "step:work");
  assert.equal(result.wallMs, 3);
  assert.equal(result.windowMs, 8);
  assert.deepEqual(result.timing, {
    sampleUnit: "iteration", boundary: "driver-step", clock: "trace", samplesMs: [8, 1, 3], stats,
  });
});

test("zero is a measured sample; a single sample has no statistics", async () => {
  const file = recording("zero.json", [span("run", { perIteration: [0] })], "deep");
  const result = await query(file, "run");
  assert.deepEqual(result.timing.samplesMs, [0]);
  assert.equal(result.timing.stats, null);
});

test("missing clocks remain unknown and missing or invalid samples remain unavailable", async () => {
  const unknown = recording("unknown.json", [span("run", { perIteration: [1], wallClock: undefined })], "deep");
  assert.equal((await query(unknown, "run")).timing.clock, null);
  for (const [index, samples] of [undefined, [], [1, -1], [null]].entries()) {
    const file = recording(`unavailable-${index}.json`, [span("run", { perIteration: samples, breakdown: bar(100) })]);
    assert.equal((await query(file, "run")).timing, null);
  }
});

test("run-group samples remain attached to their capture member", async () => {
  recording("member-breakdown.json", [span("run", { perIteration: [8, 1, 3], breakdown: bar(100) })]);
  recording("member-deep.json", [span("run", { perIteration: [30, 20, 10] })], "deep");
  const file = path.join(directory, "timings.group.json");
  writeFileSync(file, JSON.stringify({
    meta: { schemaVersion: "5", kind: "run-group", name: "timings" },
    iterations: 3, warmup: 0, headless: true, notes: [],
    members: ["breakdown", "deep"].map((mode) => ({ mode, recording: `member-${mode}.json`, createdAt: "", annotations: [] })),
  }));
  const result = await query(file, "run");
  assert.equal(result.timing, undefined);
  assert.deepEqual(result.members.map((member) => [member.mode, member.timing.samplesMs]), [
    ["breakdown", [8, 1, 3]], ["deep", [30, 20, 10]],
  ]);
});

test("the Node record and query CLI return one timing sample per timed call", { timeout: 30_000 }, () => {
  const entry = path.join(directory, "work.mjs");
  const file = path.join(directory, "node.json");
  writeFileSync(entry, "export function run() { for (let i = 0; i < 1000; i++) Math.sqrt(i); }\n");
  const cli = path.resolve("dist/cli.js");
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { cwd: directory, encoding: "utf8", timeout: 25_000, env: { ...process.env, XDG_STATE_HOME: path.join(directory, "state") } });
  run(["record", entry, "--target", "node", "--iterations", "3", "--warmup", "1", "--out", file]);
  const result = JSON.parse(run(["query", "span", file, "run", "--format", "json"]));
  assert.equal(result.timing.sampleUnit, "iteration");
  assert.equal(result.timing.boundary, "run-call");
  assert.equal(result.timing.clock, "page");
  assert.equal(result.timing.samplesMs.length, 3);
  assert.ok(result.timing.samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0));
  assert.equal(result.timing.stats.samples, 3);
});


test("measure timing keeps occurrence order and distinguishes its median from the profile bar", async () => {
  const file = recording("measure.json", [span("measure", {
    occurrenceWallMs: [8, 2, 6, 4], samples: 4, aggregation: "median", wallClock: "trace",
    wallMs: 4, breakdown: bar(4), wallMinMs: 2, wallMaxMs: 8,
  })]);
  for (const format of ["json", "toon"]) {
    const result = await query(file, "measure:work", format);
    assert.equal(result.iterations, 3);
    assert.equal(result.wallMs, 4);
    assert.equal(result.samples, 4);
    assert.deepEqual(result.timing, {
      sampleUnit: "occurrence", boundary: "performance-measure", clock: "trace",
      samplesMs: [8, 2, 6, 4],
      stats: { samples: 4, minMs: 2, medianMs: 5, meanMs: 5, maxMs: 8 },
    });
  }
});

test("a measure without its recorded series does not invent samples from its median or spread", async () => {
  const file = recording("measure-no-series.json", [span("measure", {
    samples: 4, aggregation: "median", wallMs: 4, wallMinMs: 2, wallMaxMs: 8, breakdown: bar(4),
  })]);
  assert.equal((await query(file, "measure:work")).timing, null);
});
