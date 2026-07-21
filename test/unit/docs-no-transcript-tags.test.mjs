import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// A tool transcript can leak its own XML-ish wrappers into a doc when text is pasted from a session
// (a stray `</content>`/`</invoke>` tail). These strings never belong in prose, so grep every
// docs/dev/*.md for them: a recurrence fails the build here instead of shipping in the docs.
const FORBIDDEN = [
  "</content>",
  "<invoke",
  "</invoke>",
  "<parameter",
  "</parameter>",
  "<function_calls>",
  "</function_calls>",
  "<function_results>",
  "antml:",
];

test("docs/dev/*.md carry no tool-transcript tags", async () => {
  const docsDir = new URL("../../docs/dev/", import.meta.url);
  const entries = await readdir(docsDir);
  const markdown = entries.filter((name) => name.endsWith(".md"));
  assert.ok(markdown.length >= 5, `expected the dev docs, found ${markdown.length}`);

  for (const name of markdown) {
    const text = await readFile(new URL(name, docsDir), "utf8");
    for (const pattern of FORBIDDEN)
      assert.ok(
        !text.includes(pattern),
        `docs/dev/${name} contains a tool-transcript tag: ${pattern}`,
      );
  }
});
