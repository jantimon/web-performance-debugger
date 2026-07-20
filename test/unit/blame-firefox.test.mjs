import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { queryBlame } from "../../dist/commands/query.js";
import { tmpDir } from "./helpers.mjs";

// Firefox counts forced flushes from Reflow/Styles markers but blames the READ by sampling it at the
// ~1ms Gecko interval, so a cheap read can be missed. An empty `blame --forced` beside a nonzero
// forcedLayoutCount is a sampling miss, NOT "no forced layout": the message must say which.

async function captureText(runner) {
  const priorLog = console.log;
  let out = "";
  console.log = (line = "") => {
    out += `${line}\n`;
  };
  try {
    await runner();
  } finally {
    console.log = priorLog;
  }
  return out;
}

const summary = {
  wallMs: null,
  inpMs: null,
  scriptingMs: 0,
  layoutCount: 1,
  styleCount: 1,
  paintCount: null,
  forcedLayoutCount: 1,
  layoutInvalidations: null,
  paintInvalidations: null,
  styleInvalidations: null,
  longTaskCount: 0,
  totalEvents: 0,
  perIteration: [],
  stats: null,
};

function writeFirefoxRec(name, events) {
  const file = path.join(tmpDir, name);
  writeFileSync(
    file,
    JSON.stringify({
      meta: {
        schemaVersion: "3",
        target: "firefox",
        browser: "firefox",
        passes: ["gecko"],
        iterations: 1,
        driver: false,
      },
      window: { startTs: 0, endTs: 1000 },
      marks: [],
      events,
      spans: [],
      summary,
    }),
    "utf8",
  );
  return file;
}

test("query blame --forced (firefox): an empty result beside a nonzero count says sampling missed the site", async () => {
  // The gecko lane counted 1 forced flush from a marker, but the sampler caught no read-site event.
  const file = writeFirefoxRec("blame-ff-empty.json", []);
  const text = await captureText(() => queryBlame(file, { forced: true }));
  assert.doesNotMatch(text, /no layout thrashing/i, "does not claim there were no forced layouts");
  assert.match(text, /counts 1 forced layout\/style flush/, "names the real marker-derived count");
  assert.match(text, /sampling did not catch|sampled.*can be missed|what sampling did not catch/s, "attributes the empty result to sampling");
});
