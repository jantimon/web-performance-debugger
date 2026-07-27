import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Browser-free CLI wiring: these spawn the built CLI but never launch Chrome, so they belong in the
// fast unit lane, not the Chrome-downloading e2e job. Two families live here:
//   1. Flag-rejection guards and removed-verb stubs, which `program.error` before any browser launch.
//   2. The `--target node` lane, which imports the module in-process and profiles it with node's own
//      inspector -- no browser at all.
// A broken guard then fails in the browser-free `ci` job, not after a Chrome download.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(repoRoot, "dist", "cli.js");
const examples = path.join(repoRoot, "examples");

// Per-CLI-invocation ceiling, OS-enforced. spawnSync pins this process's event loop, so node's
// per-test timeout timers cannot fire while a child runs; without this, a wedged child hangs the job
// to the CI ceiling in silence. The OS kills the child instead, and the error names the invocation.
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
// runs everywhere (not gated on Chrome).
test("record --target node resolves hot functions to source without a browser", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "nodecpu");
  runCli(["record", path.join(examples, "cpu-busywork.mjs"), "--target", "node", "--iterations", "3", "--out", out]);
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

// The removed `query digest` / `query index` verbs exit 1 with a message naming the replacement, not
// commander's bare "unknown command" and not a stack trace. Browser-free, so a plain test (never
// skipped): the stub errors before any recording is read.
for (const removed of ["digest", "index"]) {
  test(`query ${removed} was removed and points at the replacement`, () => {
    const result = spawnSync(process.execPath, [cli, "query", removed, "latest", "--format", "json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `query ${removed} exits non-zero`);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, new RegExp(`\`query ${removed}\` was removed`), "names the removed verb");
    assert.match(output, /query span[s]?/, "names the replacement verb");
    assert.doesNotMatch(output, /at Object\.|node:internal/, "no stack trace");
  });
}

// --headless-mode is removed: wpd always runs Chrome's built-in headless (or --no-headless). An
// explicit flag fails with a clear removal message, not commander's generic unknown-option. The guard
// rejects before any browser launches, so this runs everywhere (not gated on Chrome).
test("record --headless-mode errors with a clear removal message", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "record", path.join(examples, "forces-layout.mjs"), "--headless-mode", "new"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "the removed flag exits non-zero");
  assert.match(result.stderr, /--headless-mode was removed in this version/);
  assert.match(result.stderr, /--no-headless/, "points at the surviving headed opt-out");
});

// The capture modes are mutually exclusive: two capture modes are two captures / two questions, so wpd
// points at running twice rather than fusing them. Guards fire before any browser launches.
const guardError = (args) =>
  spawnSync(process.execPath, [cli, "record", path.join(examples, "forces-layout.mjs"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });

test("record --breakdown --deep is rejected (two capture modes, two invocations)", () => {
  const result = guardError(["--breakdown", "--deep"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--breakdown and --deep are two different capture modes/);
});

test("record --precise-wall is retired and names the migration (fires before any browser launch)", () => {
  const result = guardError(["--precise-wall", "--breakdown"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--precise-wall was removed/);
  assert.match(result.stderr, /cancels in `diff`\/`cpu-diff`/, "gives the systematic-cost rationale");
});

test("record --breakdown on firefox is rejected (the gecko pass IS the firefox lane)", () => {
  // --deep on firefox is a reporting tier over the same gecko pass (its dirtied-by write report
  // is covered in test/firefox.e2e.test.mjs). --breakdown has no meaning on firefox and is
  // refused before any browser launches.
  const result = guardError(["--target", "firefox", "--breakdown"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported/);
  assert.match(result.stderr, /--breakdown/);
});

test("record --deep on node is rejected (CPU-only lane, no trace)", () => {
  const result = guardError(["--target", "node", "--deep"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CPU-only lane/);
});

// B-01 end-to-end on the node lane (no browser): the profiler-start prefix (~9-30 ms the sampler
// spends warming up before the first run()) is windowed out, so a near-no-op workload reports ~0 JS
// self-time and two runs of it do NOT manufacture a cpu-diff regression from prefix jitter. Plain
// `test` (not the Chrome-gated `e2e`): --target node imports the module in-process, no browser.
test("node lane: a near-no-op --target node run gates stable under cpu-diff (B-01)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-node-e2e-"));
  const probe = path.join(examples, "near-zero.mjs");
  const base = path.join(dir, "base.json");
  const current = path.join(dir, "current.json");
  runCli(["record", probe, "--target", "node", "--iterations", "20", "--out", base]);
  runCli(["record", probe, "--target", "node", "--iterations", "20", "--out", current]);

  const baseModel = JSON.parse(readFileSync(`${base.replace(/\.json$/, "")}.cpu.json`, "utf8"));
  assert.ok(baseModel.jsSelfMs < 5, `a near-no-op reports ~0 JS self-time, got ${baseModel.jsSelfMs}`);
  // No `post (node:inspector)` prefix frame should top the list; the windowing removed it.
  const topFn = baseModel.functions[0];
  assert.ok(
    !topFn || !(topFn.fn === "post" && (topFn.file ?? "").includes("inspector")),
    `the profiler-start prefix must not be the hottest function, got ${topFn?.fn}`,
  );

  // --fail-on-regression must exit 0: runCli throws on a non-zero exit, so no throw is the assertion.
  const diff = JSON.parse(runCli(["cpu-diff", base, current, "--fail-on-regression", "--format", "json"]));
  assert.ok(Math.abs(diff.netJsSelfMs) < 5, `two identical no-op runs net ~0, got ${diff.netJsSelfMs}`);
});
