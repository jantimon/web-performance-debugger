import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The serial MEASUREMENT lane (see node-lane.test.mjs): this test RECORDS a real heap-sampling
// profile with `--target node --alloc`, so it runs alone (no parallel CPU competition). Browser-free.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(repoRoot, "dist", "cli.js");
const CLI_KILL_MS = 150_000;

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: CLI_KILL_MS,
    killSignal: "SIGKILL",
  });
  if (result.error && result.error.code === "ETIMEDOUT")
    throw new Error(`cli ${args.join(" ")} killed after ${CLI_KILL_MS}ms\n${result.stderr ?? ""}`);
  if (result.status !== 0) throw new Error(`cli ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
  return result.stdout;
}

// A workload that allocates a heap of short-lived JS objects/strings per run() (dropped every call,
// so a GC reclaims them). Written to a tmp dir with no package.json ancestor, so its frames resolve to
// the "app" bucket. Deliberately generous so the byte total sits well above sampling noise.
const ALLOC_MODULE = `
function churn() {
  const objects = [];
  for (let index = 0; index < 6000; index++)
    objects.push({ a: index, b: index * 2, c: ("payload-" + index + "-").repeat(4), d: [index, index + 1] });
  return objects.length;
}
export function run() { return churn(); }
`;

test("record --target node --alloc: attributes allocation to the app, no CPU model, flags round-trip", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-alloc-"));
  const modulePath = path.join(dir, "allocates.mjs");
  writeFileSync(modulePath, ALLOC_MODULE);
  const out = path.join(dir, "alloc");

  runCli(["record", modulePath, "--target", "node", "--alloc", "--iterations", "15", "--out", out]);

  // The two allocation artifacts land; NO CPU model is written (the CPU sampler is OFF here).
  assert.ok(existsSync(`${out}.alloc.json`), "resolved allocation model written");
  assert.ok(existsSync(`${out}.heapprofile`), "raw heap sampling profile written");
  assert.ok(!existsSync(`${out}.cpu.json`), "no CPU model on an --alloc run (CPU sampler OFF)");
  assert.ok(!existsSync(`${out}.cpuprofile`), "no raw .cpuprofile on an --alloc run");

  // The recording marks the capture mode and reports CPU self-time as NOT measured (null, never 0).
  const recording = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(recording.meta.passes, ["node-alloc"], "capture mode is node-alloc");
  assert.equal(recording.meta.runtime, "node");
  assert.equal(recording.summary.jsSelfMs, null, "jsSelfMs is not-measured (null) on an --alloc run");

  // query alloc renders a real model: a positive byte total, the app package present, the mandatory
  // GC-inclusion flags round-tripped into the stored sampling config.
  const model = JSON.parse(runCli(["query", "alloc", out, "--format", "json"]));
  assert.ok(model.totalBytes > 0, `positive sampled byte total, got ${model.totalBytes}`);
  assert.equal(model.sampling.includeMajorGC, true, "major-GC inclusion flag round-trips");
  assert.equal(model.sampling.includeMinorGC, true, "minor-GC inclusion flag round-trips");
  assert.equal(model.sampling.samplingIntervalBytes, 32768, "32 KB interval round-trips");
  const app = model.byPackage.find((entry) => entry.key === "app");
  assert.ok(app && app.selfBytes > 0, "the app package carries allocation");

  // The human report renders (not just the JSON path).
  const human = runCli(["query", "alloc", out]);
  assert.ok(/Allocation sampling:/.test(human), "human report leads with the allocation headline");
  assert.ok(/\bapp\b/.test(human), "human report names the app package");
});
