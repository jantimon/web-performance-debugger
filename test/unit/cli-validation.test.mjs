import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidArgumentError } from "commander";
import { toFloat, toInt, toNonNegativeInt, toPositiveInt } from "../../dist/cli-validation.js";

// One coherent numeric-validation policy for the CLI flags. The four parsers reject a bad value at
// the argument boundary before any browser launches. They are pure functions, so test them in
// process (call, assert the thrown InvalidArgumentError type + the constraint wording, assert the
// accepted return): no subprocess needed. The wording is what tells a user which value was wrong.
function rejects(parse, value, pattern) {
  assert.throws(
    () => parse(value),
    (error) => error instanceof InvalidArgumentError && pattern.test(error.message),
    `${value} should be rejected with ${pattern}`,
  );
}

// --- toFloat: wall/INP budgets accept non-negative floats (stored walls are fractional) ---
// One parser backs both --max-wall and --max-inp, so their policy cannot drift apart.

test("toFloat accepts a fractional ms (--max-wall/--max-inp budget)", () => {
  assert.equal(toFloat("40.5"), 40.5);
});

test("toFloat accepts an integer ms", () => {
  assert.equal(toFloat("40"), 40);
});

test("toFloat rejects a negative", () => {
  rejects(toFloat, "-5", /not a non-negative number/);
  rejects(toFloat, "-1", /not a non-negative number/);
});

test("toFloat rejects a non-number", () => {
  rejects(toFloat, "abc", /not a non-negative number/);
});

// --- toNonNegativeInt: count maxima require non-negative (a negative gate fails forever) ---

test("toNonNegativeInt accepts zero (--max-layouts 0 is a valid gate)", () => {
  assert.equal(toNonNegativeInt("0"), 0);
});

test("toNonNegativeInt rejects a negative (a permanently-failing gate is a typo)", () => {
  rejects(toNonNegativeInt, "-1", /must be zero or greater/);
  rejects(toNonNegativeInt, "-2", /must be zero or greater/);
});

test("toNonNegativeInt rejects a fractional count (a count is whole)", () => {
  rejects(toNonNegativeInt, "1.5", /not a whole number/);
});

// --- toPositiveInt: --top and --protocol-timeout require a positive integer ---
// --top feeds .slice(0, n); a zero or negative timeout fires instantly.

test("toPositiveInt accepts a positive integer", () => {
  assert.equal(toPositiveInt("5"), 5);
});

test("toPositiveInt rejects a negative", () => {
  rejects(toPositiveInt, "-1", /must be a positive whole number/);
});

test("toPositiveInt rejects zero", () => {
  rejects(toPositiveInt, "0", /must be a positive whole number/);
});

// --- toInt: the whole-number gate every count/rate option shares ---

test("toInt accepts a whole number", () => {
  assert.equal(toInt("42"), 42);
});

test("toInt rejects a fractional rate (--cpu-throttle multiplier is whole)", () => {
  rejects(toInt, "2.5", /not a whole number/);
});

// --- CLI wiring: guards that live in cli.ts (program.error), not the pure parsers. These stay
// subprocess tests because they exercise commander dispatch + lane/guard ordering, not a parser a
// unit test could call. ---

const repoRoot = path.join(fileURLToPath(new URL("../..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const probe = "examples/forces-layout.mjs"; // a real module, so validation is what fails, not the path
const missing = "does-not-exist.json"; // an accepted value fails later on this, never on the parse

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: repoRoot });
}

// positional ids (query get/frame) parse through toPositionalId, which calls program.error (not one
// of the four parsers): commander dispatches the argument, the strict parse rejects junk.

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

// --cpu-throttle > 1 is an inline range guard in cli.ts (the parser accepts 0/1 as valid ints; the
// guard then rejects a no-op rate). Guard ordering, not parser logic.

test("record --cpu-throttle rejects a rate of 1 (a no-op the throttle skips)", () => {
  const result = runCli(["record", probe, "--bench", "--cpu-throttle", "1"]);
  assert.match(result.stderr, /--cpu-throttle must be an integer greater than 1/, "1 does nothing");
});

test("record --cpu-throttle rejects zero on chrome", () => {
  const result = runCli(["record", probe, "--bench", "--cpu-throttle", "0"]);
  assert.match(result.stderr, /--cpu-throttle must be an integer greater than 1/, "0 does nothing");
});

// --- lane-irrelevant flags are rejected on the lanes that consume none of them (presence-based, so
// a falsy value still reaches the guard) ---

test("record --cpu-throttle 0 is rejected on firefox by presence, not truthiness", () => {
  const result = runCli(["record", probe, "--target", "firefox", "--cpu-throttle", "0"]);
  assert.match(result.stderr, /--cpu-throttle \(needs CDP\)/, "a falsy rate still reaches the lane guard");
});

test("record --cpu-throttle 0 is rejected on node by presence, not truthiness", () => {
  const result = runCli(["record", probe, "--target", "node", "--cpu-throttle", "0"]);
  assert.match(result.stderr, /--cpu-throttle/, "a falsy rate still reaches the lane guard");
  assert.match(result.stderr, /CPU-only lane/, "the node lane message");
});

test("record --target node rejects --no-headless", () => {
  const result = runCli(["record", "--target", "node", probe, "--no-headless"]);
  assert.match(result.stderr, /--no-headless/, "node has no browser to make visible");
  assert.match(result.stderr, /CPU-only lane/, "the node lane message");
});

test("record --target node rejects --keep-partial", () => {
  const result = runCli(["record", "--target", "node", probe, "--keep-partial"]);
  assert.match(result.stderr, /--keep-partial/, "node has no driver loop to salvage");
});

test("record --target node rejects --protocol-timeout (parsed fine; the lane rejects it)", () => {
  const result = runCli(["record", "--target", "node", probe, "--protocol-timeout", "5000"]);
  assert.match(result.stderr, /--protocol-timeout/, "node runs no protocol");
  assert.doesNotMatch(result.stderr, /positive whole number/, "5000 parsed fine; the lane is what rejects it");
});

test("record --bench rejects the driver-only --keep-partial", () => {
  const result = runCli(["record", probe, "--bench", "--keep-partial"]);
  assert.match(result.stderr, /--keep-partial is a driver-mode salvage/, "bench has no driver step to keep");
});
