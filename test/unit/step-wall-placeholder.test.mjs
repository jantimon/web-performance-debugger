import { test } from "node:test";
import assert from "node:assert/strict";
import { printSummary } from "../../dist/commands/summaryView.js";

// The record report's per-step wall table. A driver step whose wall the capture mode never priced
// (default mode: the navigating step resets the page clock, no trace to span it) must render the
// not-measured placeholder, never a literal 0 -- a 0 in a column of real numbers reads as "instant",
// contradicting the driver-step-wall-unmeasured note printed below the table

function captureText(run) {
  const priorLog = console.log;
  let out = "";
  console.log = (line = "") => {
    out += `${line}\n`;
  };
  try {
    run();
  } finally {
    console.log = priorLog;
  }
  return out;
}

const driverMeta = (overrides = {}) => ({
  schemaVersion: "5",
  tool: "wpd",
  fn: "run",
  mode: "module",
  target: "drivers/load.mjs",
  capture: "default",
  lifecycle: ["run"],
  iterations: 1,
  jsSelfMs: 0.5,
  totalEvents: 0,
  notes: [],
  workload: { lane: "driver", host: null, module: "drivers/load.mjs" },
  ...overrides,
});

const runSpan = {
  label: "run",
  kind: "run",
  aggregation: "sum",
  wallMs: null,
  counts: {
    layoutCount: null,
    styleCount: null,
    paintCount: null,
    forcedLayoutCount: null,
    layoutInvalidations: null,
    styleInvalidations: null,
    paintInvalidations: null,
    longTaskCount: null,
  },
};

test("record report: a default-capture driver step with no wall prints — , never 0", () => {
  const rec = {
    meta: driverMeta(),
    spans: [
      runSpan,
      { label: "load", kind: "step", index: 0, aggregation: "first", wallMs: null },
    ],
  };
  const text = captureText(() => printSummary(rec));
  const stepRow = text.split("\n").find((line) => line.startsWith("load"));
  assert.ok(stepRow, "the per-step table lists the load step");
  assert.match(stepRow, /load\s+—/, "an unmeasured step wall renders the placeholder");
  assert.doesNotMatch(stepRow, /load\s+0\b/, "an unmeasured step wall never reads as 0");
});

test("record report: a measured step wall still prints its number", () => {
  const rec = {
    meta: driverMeta({ capture: "breakdown", iterations: 3 }),
    spans: [
      runSpan,
      {
        label: "load",
        kind: "step",
        index: 0,
        aggregation: "first",
        wallMs: 12.5,
        perIteration: [11, 12.5, 14],
        stats: { samples: 3, minMs: 11, medianMs: 12.5, meanMs: 12.5, maxMs: 14 },
      },
    ],
  };
  const text = captureText(() => printSummary(rec));
  const stepRow = text.split("\n").find((line) => line.startsWith("load"));
  assert.ok(stepRow, "the per-step table lists the load step");
  assert.match(stepRow, /load\s+12\.5/, "a measured median prints verbatim");
  assert.doesNotMatch(stepRow, /—/, "a measured step never shows the placeholder");
});
