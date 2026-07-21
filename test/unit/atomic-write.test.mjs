import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileAtomic, copyFileAtomic } from "../../dist/model/atomic-write.js";

test("writeFileAtomic: writes the content and leaves no temp file behind", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-atomic-"));
  const target = path.join(dir, "run.json");
  await writeFileAtomic(target, '{"ok":true}');
  assert.equal(readFileSync(target, "utf8"), '{"ok":true}', "the content lands at the target");
  assert.deepEqual(
    readdirSync(dir),
    ["run.json"],
    "no .tmp sibling is left in the directory (temp + rename cleaned up)",
  );
});

test("writeFileAtomic: overwriting a good file replaces it whole (rename, not truncate)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-atomic-"));
  const target = path.join(dir, "manifest.json");
  writeFileSync(target, '{"members":["a","b"]}');
  await writeFileAtomic(target, '{"members":["a","b","c"]}');
  assert.equal(
    readFileSync(target, "utf8"),
    '{"members":["a","b","c"]}',
    "the new content fully replaces the old (rename is all-or-nothing)",
  );
  assert.deepEqual(readdirSync(dir), ["manifest.json"], "still no temp litter");
});

test("copyFileAtomic: copies the source onto the target, leaving no temp file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-atomic-"));
  const source = path.join(dir, "dump.json");
  const target = path.join(dir, "member.geckoprofile.json");
  writeFileSync(source, '{"threads":[]}');
  await copyFileAtomic(source, target);
  assert.equal(readFileSync(target, "utf8"), '{"threads":[]}', "the target is a copy of the source");
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["dump.json", "member.geckoprofile.json"],
    "the source stays and no .tmp sibling is left behind",
  );
});
