import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGeckoDump } from "../../dist/record/runpass.js";
import { geckoFixture } from "./helpers.mjs";

function dumpFile(contents) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-gecko-dump-"));
  const file = path.join(dir, "dump.json");
  writeFileSync(file, contents);
  return file;
}

// B-09: the Firefox lane writes a large temp dump the caller later copies to the artifact. A parse
// failure (a truncated/corrupt dump, or a profile missing the JavaScript category) must not leave
// that 16MB+ temp behind.
test("readGeckoDump: a corrupt dump throws and removes the temp file", async () => {
  const file = dumpFile("{ this is not valid json");
  await assert.rejects(readGeckoDump(file));
  assert.ok(!existsSync(file), "the temp dump was removed on the parse failure");
});

test("readGeckoDump: a structurally-invalid dump (no JavaScript category) throws and removes the temp file", async () => {
  // parseGecko throws on a profile with no JavaScript category / empty thread list rather than emit a
  // fake-zero model; that failure must still clear the temp.
  const file = dumpFile(JSON.stringify({ meta: { interval: 1, categories: [] }, threads: [] }));
  await assert.rejects(readGeckoDump(file));
  assert.ok(!existsSync(file), "the temp dump was removed on the structural failure");
});

test("readGeckoDump: a valid dump parses and keeps the file for the caller to copy", async () => {
  const file = dumpFile(JSON.stringify(geckoFixture));
  const context = await readGeckoDump(file);
  assert.ok(context, "returns a parsed gecko context");
  assert.ok(existsSync(file), "the file is kept on success (the caller owns the copy + removal)");
});
