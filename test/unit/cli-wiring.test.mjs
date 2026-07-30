import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Browser-free CLI wiring: these spawn the built CLI but never launch Chrome, so they belong in the
// fast unit lane, not the Chrome-downloading e2e job. They are flag-rejection guards and removed-verb
// stubs, which `program.error` before any browser launch, so a broken guard fails in the browser-free
// `ci` job, not after a Chrome download. These take no measurement -- they assert an exit code and a
// message -- so parallel unit workers are fine. The `--target node` tests that RECORD a real profile
// moved to test/measurement/ (the serial lane), where nothing competes for the CPU mid-measurement
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(repoRoot, "dist", "cli.js");
const examples = path.join(repoRoot, "examples");

// The removed `query digest` / `query index` verbs exit 1 with a message naming the replacement, not
// commander's bare "unknown command" and not a stack trace. Browser-free, so a plain test (never
// skipped): the stub errors before any recording is read
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
// rejects before any browser launches, so this runs everywhere (not gated on Chrome)
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
// points at running twice rather than fusing them. Guards fire before any browser launches
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
  // refused before any browser launches
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
