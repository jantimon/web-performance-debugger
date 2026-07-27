import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { querySpans } from "../../dist/commands/query.js";
import { queryCpu } from "../../dist/commands/cpu.js";
import { diffCmd } from "../../dist/commands/diff.js";
import { tmpDir, captureExitCode } from "./helpers.mjs";

// --precise-wall is retired: no invocation produces it, but a recording written by it before the
// removal must still OPEN and report not-measured, never crash the schema gate or a reader. The
// mode string lives on in the CaptureMode union and model/group.ts modeHasCpu for exactly this.

const notMeasuredCounts = {
  layoutCount: null,
  styleCount: null,
  paintCount: null,
  forcedLayoutCount: null,
  layoutInvalidations: null,
  paintInvalidations: null,
  styleInvalidations: null,
  longTaskCount: null,
};

// A precise-wall recording: the default capture minus the sampler, so no trace and no CPU model.
// It carries a bar-less run span (the wall was the only product) with every count not-measured.
function writePreciseWall(name) {
  const meta = { schemaVersion: "4", target: "chrome", passes: ["precise-wall"], driver: false, iterations: 1 };
  const summary = {
    wallMs: 12.5, inpMs: null, jsSelfMs: 0,
    ...notMeasuredCounts, totalEvents: 0, perIteration: [], stats: null,
  };
  const spans = [{ label: "run", kind: "run", aggregation: "sum", wallMs: 12.5, counts: notMeasuredCounts }];
  const file = path.join(tmpDir, name);
  writeFileSync(file, JSON.stringify({ meta, summary, spans }), "utf8");
  return file;
}

async function captureJson(runner) {
  const priorLog = console.log;
  let out = "";
  console.log = (line) => {
    out += `${line}\n`;
  };
  try {
    await runner();
  } finally {
    console.log = priorLog;
  }
  return out;
}

test("query spans on an old --precise-wall recording renders the not-measured overview, never crashes", async () => {
  const file = writePreciseWall("old-precise-wall-spans.json");
  const parsed = JSON.parse(await captureJson(() => querySpans(file, { format: "json" })));
  // No reconciling bar and no CPU model: the overview falls back to the counts shape, which reports
  // every count not-measured (null), never a fabricated all-zero bar.
  assert.equal(parsed.source, "counts", "a sampler-off recording has no bar to fold");
  assert.equal(parsed.spans.length, 1, "the run span survives");
  assert.equal(parsed.spans[0].counts.layoutCount, null, "counts read not-measured, never 0");
  assert.equal(parsed.spans[0].slices, undefined, "no slice bar is fabricated");
});

test("query cpu on an old --precise-wall recording refuses honestly (no CPU model), without naming the removed flag", async () => {
  const file = writePreciseWall("old-precise-wall-cpu.json");
  await assert.rejects(
    () => queryCpu(file, { format: "json" }),
    (error) => {
      assert.equal(error.code, "ENOCPUMODEL", "the missing model is the honest refusal, not a crash");
      assert.doesNotMatch(error.message, /--precise-wall/, "the guidance no longer names the removed flag");
      return true;
    },
  );
});

test("diff of two old --precise-wall recordings reports not-measured and does not gate a false regression", async () => {
  const base = writePreciseWall("old-precise-wall-diff-base.json");
  const current = writePreciseWall("old-precise-wall-diff-cur.json");
  // Every count is not-measured on both sides, so --fail-on-regression has nothing exact to gate:
  // it reports not-measured rather than fabricating a pass/fail from null deltas.
  const code = await captureExitCode(() => diffCmd(base, current, { failOnRegression: true }));
  assert.notEqual(code, 1, "no exact count is measured, so no regression is gated");
});
