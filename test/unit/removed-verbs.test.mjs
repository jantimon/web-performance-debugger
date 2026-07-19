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
  test(`query ${removed} exits 1 with a helpful message naming the replacement`, () => {
    const result = runCli(["query", removed, "latest", "--json"]);
    assert.equal(result.status, 1, `query ${removed} exits non-zero`);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, new RegExp(`\`query ${removed}\` was removed`), "names the removed verb");
    assert.match(output, new RegExp(replacement), "names the replacement verb");
    assert.doesNotMatch(output, /at Object\.|at Module\.|node:internal/, "no stack trace");
  });
}
