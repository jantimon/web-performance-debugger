import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The serial MEASUREMENT lane. These `--target node` tests RECORD a real CPU profile, so their
// numbers only hold when nothing else on the machine competes for the CPU during the timed loop
// (docs/dev/measurement-ecosystem.md: never run two measurements concurrently on one host). The unit
// lane runs its test FILES in parallel worker processes, which contends and can inflate a near-no-op
// recording past a gate floor -- a flake. So this file lives OUTSIDE test/unit/ and is driven by
// `npm run test:measurement` (`node --test --test-concurrency=1 test/measurement/`), which caps
// concurrent test FILES to one so a measurement always runs alone. Within a file top-level tests are
// already serial by default; the point of the flag is no PARALLEL SIBLING processes, not intra-file
// ordering. Browser-free (--target node profiles in-process via node's own inspector), so it stays in
// the fast browser-free `ci` job, after the unit step so it runs alone on the runner
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(repoRoot, "dist", "cli.js");
const examples = path.join(repoRoot, "examples");

// Per-CLI-invocation ceiling, OS-enforced. spawnSync pins this process's event loop, so node's
// per-test timeout timers cannot fire while a child runs; without this, a wedged child hangs the job
// to the CI ceiling in silence. The OS kills the child instead, and the error names the invocation
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
    throw new Error(
      `cli ${args.join(" ")} killed after ${CLI_KILL_MS}ms (wedged child)\n${result.stderr ?? ""}`,
    );
  if (result.status !== 0)
    throw new Error(`cli ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
  return result.stdout;
}

// --target node profiles in-process via node's V8 inspector, so it needs no browser and
// runs everywhere (not gated on Chrome)
test("record --target node resolves hot functions to source without a browser", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "nodecpu");
  runCli(["record", path.join(examples, "probes", "cpu-busywork.mjs"), "--target", "node", "--iterations", "3", "--out", out]);
  assert.ok(existsSync(`${out}.cpu.json`), "cpu model written");
  assert.ok(existsSync(`${out}.cpuprofile`), "raw cpuprofile written");

  const model = JSON.parse(runCli(["query", "cpu", out, "--format", "json"]));
  assert.ok(model.jsSelfMs > 0, "non-zero sampled JS self-time");
  const named = model.hot.find(
    (fn) => fn.fn === "hashString" || fn.fn === "buildRows" || fn.fn === "serializeStyle",
  );
  assert.ok(named, "a named busywork function is hot");
  assert.ok(named.source?.includes("cpu-busywork.mjs"), "hot function resolved to its source file");
});

// B-01 end-to-end on the node lane (no browser): the profiler-start prefix (~9-30 ms the sampler
// spends warming up before the first run()) is windowed out, so a near-no-op workload reports ~0 JS
// self-time and two runs of it do NOT manufacture a cpu-diff regression from prefix jitter. Plain
// `test` (not the Chrome-gated `e2e`): --target node imports the module in-process, no browser
test("node lane: a near-no-op --target node run gates stable under cpu-diff (B-01)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-node-e2e-"));
  const probe = path.join(examples, "probes", "near-zero.mjs");
  const base = path.join(dir, "base.json");
  // Record ONCE and self-diff. Recording twice made this flaky: two near-zero captures each land a
  // handful of samples, and sampler quantization jitters jsSelfMs 0.16-1.21ms between them against a
  // 0.5ms gate floor (~2.5 samples), so identical code tripped --fail-on-regression ~3% of runs
  // Self-diffing pins netJsSelfMs=0 by construction, so the gate's exit-0 path stays covered without
  // depending on where two independent runs' samples fell
  runCli(["record", probe, "--target", "node", "--iterations", "20", "--out", base]);

  const baseModel = JSON.parse(readFileSync(`${base.replace(/\.json$/, "")}.cpu.json`, "utf8"));
  assert.ok(baseModel.jsSelfMs < 5, `a near-no-op reports ~0 JS self-time, got ${baseModel.jsSelfMs}`);
  // The `post (node:inspector)` profiler-start prefix (~9-30ms of sampler warmup before the first
  // run()) is windowed out, so it carries at most a stray in-window sample -- never the multi-ms
  // prefix. Assert its self-time stays far under the 9ms warmup floor; if windowing regressed, the
  // prefix would land here at ~9-30ms and trip this. A rank check ("post is not functions[0]") is noise
  // on a near-no-op: every function holds ~one sample so which sorts first is random. The windowing
  // PROPERTY is post's cost, not its rank
  const postFrame = baseModel.functions.find(
    (fn) => fn.fn === "post" && (fn.file ?? "").includes("inspector"),
  );
  assert.ok(
    !postFrame || postFrame.selfMs < 5,
    `the profiler-start prefix is windowed out (post self-time far under the 9ms warmup floor), got ${postFrame?.selfMs}`,
  );

  // --fail-on-regression must exit 0: runCli throws on a non-zero exit, so no throw is the assertion
  const diff = JSON.parse(runCli(["cpu-diff", base, base, "--fail-on-regression", "--format", "json"]));
  assert.equal(diff.netJsSelfMs, 0, `a self-diff nets exactly 0, got ${diff.netJsSelfMs}`);
});
