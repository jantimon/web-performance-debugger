import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { structuredFormat } from "../../dist/output/format.js";
import { querySpans } from "../../dist/commands/query.js";
import { tmpDir } from "./helpers.mjs";

// --json is the HIDDEN alias of --format json: kept working, absent from every help surface. --format
// is the documented spelling. Two halves of the contract, both pinned here: the flag still selects
// json output, and it never advertises itself in --help

const cli = path.join(fileURLToPath(new URL("../..", import.meta.url)), "dist", "cli.js");

function captureLog(run) {
  const priorLog = console.log;
  let out = "";
  console.log = (line = "") => {
    out += `${line}\n`;
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      console.log = priorLog;
    })
    .then(() => out);
}

test("structuredFormat: --json selects the same 'json' as --format json, and --format wins", () => {
  assert.equal(structuredFormat({ json: true }), "json");
  assert.equal(structuredFormat({ format: "json" }), structuredFormat({ json: true }));
  assert.equal(structuredFormat({}), null, "neither flag = the human report");
  // --format is authoritative when both are present, so the alias never overrides an explicit format
  assert.equal(structuredFormat({ json: true, format: "toon" }), "toon");
});

test("query spans --json produces byte-identical output to --format json", async () => {
  const file = path.join(tmpDir, "json-alias.json");
  writeFileSync(
    file,
    JSON.stringify({
      meta: { schemaVersion: "5", target: "chrome", capture: "deep", iterations: 1 },
      spans: [
        {
          label: "run",
          kind: "run",
          aggregation: "sum",
          wallMs: 12.5,
          counts: {
            layoutCount: 3,
            styleCount: 4,
            paintCount: 1,
            forcedLayoutCount: 2,
            layoutInvalidations: 5,
            styleInvalidations: 4,
            longTaskCount: 0,
          },
        },
      ],
    }),
    "utf8",
  );
  const viaJson = await captureLog(() => querySpans(file, { json: true }));
  const viaFormat = await captureLog(() => querySpans(file, { format: "json" }));
  assert.equal(viaJson, viaFormat, "the hidden alias yields the documented spelling's output");
  JSON.parse(viaJson); // and it is genuine JSON, not the human report
});

test("--json is absent from every documented help surface, which shows --format instead", () => {
  for (const args of [
    ["query", "spans", "--help"],
    ["query", "cpu", "--help"],
    ["cpu-diff", "--help"],
  ]) {
    const help = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(help, /--json/, `\`${args.join(" ")}\` does not advertise --json`);
    assert.match(help, /--format/, `\`${args.join(" ")}\` documents --format`);
  }
});
