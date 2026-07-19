import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The zero-authoring on-ramp: `record` with no module runs a built-in load flow against --url/--html.
// These guards decide whether that flow can run, and all three ERROR cases fire before any browser
// launches, so they stay browser-free unit tests (the positive --url path is the cli e2e). Assert on
// the message, not just the exit code: a first-time user hits exactly these, so the wording matters.
const cli = path.join(fileURLToPath(new URL("../..", import.meta.url)), "dist", "cli.js");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("record with no module and no --url/--html errors with a helpful message", () => {
  const result = runCli(["record"]);
  assert.equal(result.status, 1, "exits non-zero");
  assert.match(
    result.stderr,
    /needs a module path, or --url\/--html/,
    "names both ways to give it something to run",
  );
  assert.match(result.stderr, /wpd record --url/, "shows the on-ramp invocation");
  assert.doesNotMatch(result.stderr, /at Object\.|node:internal/, "no stack trace");
});

test("record --bench with no module errors (bench imports run() in-page)", () => {
  const result = runCli(["record", "--url", "http://127.0.0.1:1/x", "--bench"]);
  assert.equal(result.status, 1, "exits non-zero");
  assert.match(result.stderr, /--bench needs a module/, "explains bench needs a module");
});

test("record --target node with no module errors (node imports and profiles run())", () => {
  const result = runCli(["record", "--target", "node"]);
  assert.equal(result.status, 1, "exits non-zero");
  assert.match(result.stderr, /--target node needs a module/, "explains node needs a module");
});
