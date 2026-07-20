import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The zero-authoring on-ramp: `record` with no module runs a built-in load flow against --url.
// These guards decide whether that flow can run, and all these ERROR cases fire before any browser
// launches, so they stay browser-free unit tests (the positive --url path is the cli e2e). Assert on
// the message, not just the exit code: a first-time user hits exactly these, so the wording matters.
const cli = path.join(fileURLToPath(new URL("../..", import.meta.url)), "dist", "cli.js");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("record with no module and no --url errors with a helpful message", () => {
  const result = runCli(["record"]);
  assert.equal(result.status, 1, "exits non-zero");
  assert.match(result.stderr, /needs a module path, or --url/, "names both ways to give it something to run");
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

test("record --precise-wall without a module is refused (nothing would be measured)", () => {
  const result = runCli(["record", "--url", "http://127.0.0.1:1/x", "--precise-wall"]);
  assert.equal(result.status, 1, "exits non-zero");
  assert.match(result.stderr, /--precise-wall needs a module/, "explains why nothing would be measured");
});

test("--html still works as a hidden alias of --url", () => {
  // Zero behavior change for pre-unification invocations: --html resolves onto the same host page as
  // --url, so the bench guard (which needs the host page set) still fires as it would for --url.
  const result = runCli(["record", "--html", "test/fixtures/driver-probe.html", "--bench"]);
  assert.equal(result.status, 1, "exits non-zero");
  assert.match(result.stderr, /--bench needs a module/, "the --html alias reached the same guard");
});

test("--url cannot combine with the --html alias (they name one host page)", () => {
  const result = runCli(["record", "--url", "http://x/", "--html", "a.html"]);
  assert.equal(result.status, 1, "exits non-zero");
  assert.match(result.stderr, /--url and --html name the same host page/, "tells the user to pick one");
});

test("--url is documented, --html is absent from --help", () => {
  const result = runCli(["record", "--help"]);
  assert.match(result.stdout, /--url <url-or-file>/, "the documented option is shown");
  assert.doesNotMatch(result.stdout, /--html <file>/, "the alias is hidden");
});

test("--disable-browser-sandbox with --user-data-dir is refused (unsandboxed renderer + real profile)", () => {
  const result = runCli([
    "record",
    "examples/forces-layout.mjs",
    "--bench",
    "--disable-browser-sandbox",
    "--user-data-dir",
    "/tmp/profile",
  ]);
  assert.equal(result.status, 1, "exits non-zero");
  assert.match(result.stderr, /--disable-browser-sandbox with --user-data-dir/, "names the combo");
  assert.match(result.stderr, /no safe way to combine them/, "refuses rather than warns");
});

test("--disable-browser-sandbox with a public --url warns loudly before launch", () => {
  // --iterations 0 aborts before any browser launches, so the warning is the only browser-free signal
  // to assert on; a private/localhost --url stays quiet (only public content is the risk).
  const result = runCli([
    "record",
    "--url",
    "https://example.com",
    "--disable-browser-sandbox",
    "--iterations",
    "0",
  ]);
  assert.match(result.stderr, /WARNING: --disable-browser-sandbox loads https:\/\/example\.com/, "warns about the public host");
  assert.match(result.stderr, /no OS containment/, "names the risk");
});

test("--disable-browser-sandbox with a localhost --url does not warn (only public content is the risk)", () => {
  const result = runCli([
    "record",
    "--url",
    "http://localhost:1/x",
    "--disable-browser-sandbox",
    "--iterations",
    "0",
  ]);
  assert.doesNotMatch(result.stderr, /WARNING: --disable-browser-sandbox loads/, "stays quiet for a private host");
});

test("programmatic record() without module or url/html rejects instead of crashing later", async () => {
  const { record } = await import("../../dist/commands/record.js");
  await assert.rejects(() => record({}), /needs a module to run, or url\/html/);
});
