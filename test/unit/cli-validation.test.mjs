import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One coherent numeric-validation policy for the CLI flags. Every case here errors at the argument
// boundary (a bad parse, a range check, or a lane-irrelevant flag) BEFORE any browser launches, so
// these stay browser-free unit tests. Assert on the message, not just the exit code: the wording is
// what tells a user which argument was wrong.
const repoRoot = path.join(fileURLToPath(new URL("../..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const probe = "examples/forces-layout.mjs"; // a real module, so validation is what fails, not the path
const missing = "does-not-exist.json"; // an accepted value fails later on this, never on the parse

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: repoRoot });
}

// --- wall/INP budgets accept non-negative floats (stored walls are fractional) ---

test("assert --max-wall accepts a fractional ms", () => {
  const result = runCli(["assert", missing, "--max-wall", "40.5"]);
  assert.doesNotMatch(result.stderr, /not a non-negative number|not a whole number/, "40.5 is a valid wall budget");
});

test("assert --max-wall rejects a negative", () => {
  const result = runCli(["assert", missing, "--max-wall=-5"]);
  assert.equal(result.status, 1, "exits non-zero");
  assert.match(result.stderr, /not a non-negative number/, "names the constraint");
});

test("assert --max-wall rejects a non-number", () => {
  const result = runCli(["assert", missing, "--max-wall", "abc"]);
  assert.match(result.stderr, /not a non-negative number/, "abc is not a wall budget");
});

test("assert --max-inp accepts a fractional ms (one policy with --max-wall)", () => {
  const result = runCli(["assert", missing, "--max-inp", "40.5"]);
  assert.doesNotMatch(result.stderr, /not a non-negative number|not a whole number/, "40.5 is a valid INP budget");
});

test("assert --max-inp rejects a negative", () => {
  const result = runCli(["assert", missing, "--max-inp=-1"]);
  assert.match(result.stderr, /not a non-negative number/, "names the constraint");
});

// --- count maxima require non-negative (a negative gate fails forever) ---

test("assert --max-layouts accepts zero", () => {
  const result = runCli(["assert", missing, "--max-layouts", "0"]);
  assert.doesNotMatch(result.stderr, /must be zero or greater|not a whole number/, "0 is a valid count gate");
});

test("assert --max-layouts rejects a negative", () => {
  const result = runCli(["assert", missing, "--max-layouts=-1"]);
  assert.match(result.stderr, /must be zero or greater/, "a permanently-failing gate is a typo");
});

test("assert --max-forced rejects a negative", () => {
  const result = runCli(["assert", missing, "--max-forced=-2"]);
  assert.match(result.stderr, /must be zero or greater/, "names the constraint");
});

test("assert --max-layouts still rejects a fractional count", () => {
  const result = runCli(["assert", missing, "--max-layouts", "1.5"]);
  assert.match(result.stderr, /not a whole number/, "a count is whole");
});

// --- --top requires a positive integer (it feeds .slice(0, n)) ---

test("query --top rejects a negative", () => {
  const result = runCli(["query", "cpu", missing, "--top=-1"]);
  assert.match(result.stderr, /must be a positive whole number/, "a negative slices from the end");
});

test("query --top rejects zero", () => {
  const result = runCli(["query", "span", missing, "run", "--top", "0"]);
  assert.match(result.stderr, /must be a positive whole number/, "zero shows nothing");
});

test("query --top accepts a positive integer", () => {
  const result = runCli(["query", "cpu", missing, "--top", "5"]);
  assert.doesNotMatch(result.stderr, /positive whole number/, "5 is a valid cutoff");
});

// --- positional ids (query get/frame) parse strictly ---

test("query get rejects a non-numeric id", () => {
  const result = runCli(["query", "get", missing, "abc"]);
  assert.equal(result.status, 1, "exits non-zero");
  assert.match(result.stderr, /<id> must be a non-negative whole number/, "names the id argument");
});

test("query get rejects a trailing-junk id (no silent parseInt)", () => {
  const result = runCli(["query", "get", missing, "12junk"]);
  assert.match(result.stderr, /<id> must be a non-negative whole number/, "12junk is not 12");
});

test("query frame rejects a non-numeric id", () => {
  const result = runCli(["query", "frame", missing, "abc"]);
  assert.match(result.stderr, /<id> must be a non-negative whole number/, "names the id argument");
});

test("query get accepts a whole-number id", () => {
  const result = runCli(["query", "get", missing, "5"]);
  assert.doesNotMatch(result.stderr, /non-negative whole number/, "5 is a valid id");
});

// --- --protocol-timeout requires a positive integer on browser lanes ---

test("record --protocol-timeout rejects a negative", () => {
  const result = runCli(["record", probe, "--bench", "--protocol-timeout=-1"]);
  assert.match(result.stderr, /must be a positive whole number/, "an immediate timeout is a typo");
});

test("record --protocol-timeout rejects zero", () => {
  const result = runCli(["record", probe, "--bench", "--protocol-timeout", "0"]);
  assert.match(result.stderr, /must be a positive whole number/, "zero fires instantly");
});

// --- --cpu-throttle requires an integer > 1 on chrome; presence-based rejection elsewhere ---

test("record --cpu-throttle rejects a rate of 1 (a no-op the throttle skips)", () => {
  const result = runCli(["record", probe, "--bench", "--cpu-throttle", "1"]);
  assert.match(result.stderr, /--cpu-throttle must be an integer greater than 1/, "1 does nothing");
});

test("record --cpu-throttle rejects zero on chrome", () => {
  const result = runCli(["record", probe, "--bench", "--cpu-throttle", "0"]);
  assert.match(result.stderr, /--cpu-throttle must be an integer greater than 1/, "0 does nothing");
});

test("record --cpu-throttle rejects a fractional rate", () => {
  const result = runCli(["record", probe, "--bench", "--cpu-throttle", "2.5"]);
  assert.match(result.stderr, /not a whole number/, "a throttle multiplier is whole");
});

test("record --cpu-throttle 0 is rejected on firefox by presence, not truthiness", () => {
  const result = runCli(["record", probe, "--target", "firefox", "--cpu-throttle", "0"]);
  assert.match(result.stderr, /--cpu-throttle \(needs CDP\)/, "a falsy rate still reaches the lane guard");
});

test("record --cpu-throttle 0 is rejected on node by presence, not truthiness", () => {
  const result = runCli(["record", probe, "--target", "node", "--cpu-throttle", "0"]);
  assert.match(result.stderr, /--cpu-throttle/, "a falsy rate still reaches the lane guard");
  assert.match(result.stderr, /CPU-only lane/, "the node lane message");
});

// --- lane-irrelevant flags are rejected on the lanes that consume none of them ---

test("record --target node rejects --no-headless", () => {
  const result = runCli(["record", "--target", "node", probe, "--no-headless"]);
  assert.match(result.stderr, /--no-headless/, "node has no browser to make visible");
  assert.match(result.stderr, /CPU-only lane/, "the node lane message");
});

test("record --target node rejects --keep-partial", () => {
  const result = runCli(["record", "--target", "node", probe, "--keep-partial"]);
  assert.match(result.stderr, /--keep-partial/, "node has no driver loop to salvage");
});

test("record --target node rejects --protocol-timeout", () => {
  const result = runCli(["record", "--target", "node", probe, "--protocol-timeout", "5000"]);
  assert.match(result.stderr, /--protocol-timeout/, "node runs no protocol");
  assert.doesNotMatch(result.stderr, /positive whole number/, "5000 parsed fine; the lane is what rejects it");
});

test("record --bench rejects the driver-only --keep-partial", () => {
  const result = runCli(["record", probe, "--bench", "--keep-partial"]);
  assert.match(result.stderr, /--keep-partial is a driver-mode salvage/, "bench has no driver step to keep");
});
