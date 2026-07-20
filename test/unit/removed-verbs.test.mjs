import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The removed `query digest` / `query index` verbs must exit 1 with a message naming the
// replacement (`spans` / `span <label>`), not commander's bare "unknown command" and not a stack
// trace. Browser-free: the stub errors before any recording is read, so this stays a unit test.
const cli = path.join(fileURLToPath(new URL("../..", import.meta.url)), "dist", "cli.js");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

for (const [removed, replacement] of [
  ["digest", "query spans"],
  ["index", "query spans"],
]) {
  test(`query ${removed} exits 1 with the removal notice on stderr, not stdout`, () => {
    const result = runCli(["query", removed, "latest", "--json"]);
    assert.equal(result.status, 1, `query ${removed} exits non-zero`);
    // The notice must go to STDERR with an empty STDOUT: a script that captures stdout and pipes it
    // to JSON.parse then gets clean-empty + a real exit code, not a prose line that parses as garbage.
    assert.equal(result.stdout, "", `query ${removed} writes nothing to stdout`);
    assert.match(
      result.stderr,
      new RegExp(`\`query ${removed}\` was removed`),
      "stderr names the removed verb",
    );
    assert.match(result.stderr, new RegExp(replacement), "stderr names the replacement verb");
    assert.doesNotMatch(result.stderr, /at Object\.|at Module\.|node:internal/, "no stack trace");
  });
}
