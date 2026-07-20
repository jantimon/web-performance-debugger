import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A record failure must exit non-zero so CI and scripts can detect it. The --target node lane imports
// and profiles run() in-process (no browser), so a module that throws in run() reproduces a real
// record failure browser-free and fast, without needing Chrome.
const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const badModule = path.join(root, "test", "fixtures", "throws-in-run.mjs");

function runRecord(extraEnv) {
  return spawnSync(
    process.execPath,
    [cli, "record", badModule, "--target", "node", "--iterations", "1"],
    { encoding: "utf8", cwd: root, env: { ...process.env, ...extraEnv } },
  );
}

test("a record failure exits non-zero", () => {
  const result = runRecord();
  assert.equal(result.status, 1, "exits 1, not 0");
  assert.match(result.stderr, /record failed:/, "names the failure on stderr");
});

test("WPD_DEBUG surfaces the error stack, not just the one-line message", () => {
  const result = runRecord({ WPD_DEBUG: "1" });
  assert.equal(result.status, 1, "still exits non-zero");
  assert.match(result.stderr, /record failed:/);
  assert.match(result.stderr, /throws-in-run\.mjs/, "the stack points at the throwing module");
});

test("the non-zero exit does not depend on Node's --unhandled-rejections policy", () => {
  // The record catch resolves rather than rejecting, so this re-confirms it under a policy env where a
  // silent 0 would be the failure mode: a wrapper or CI that sets --unhandled-rejections=warn must
  // still read a non-zero code, or it cannot catch a broken record.
  const result = runRecord({ NODE_OPTIONS: "--unhandled-rejections=warn" });
  assert.equal(result.status, 1, "policy-independent non-zero exit");
});
