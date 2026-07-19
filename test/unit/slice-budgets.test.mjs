import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  parseSliceBudgets,
  gateSliceBudgets,
  diffSpanSlices,
  sliceMs,
  SLICE_NAMES,
} from "../../dist/model/spans.js";
import { assertCmd } from "../../dist/commands/assert.js";
import { diffCmd } from "../../dist/commands/diff.js";
import { tmpDir, captureExitCode } from "./helpers.mjs";

// --- SpanEntry fixtures: the unified slice shape assert/diff read (query spans output) ---

const slice = (ms) => ({ ms });
const jsSlice = (ms) => ({ ms, byPackage: {} });

// A chrome run span: every slice measured. A node-style run span: style/layout/paint not-measured
// (null), the Measured contract this whole feature turns on.
const chromeRun = (overrides = {}) => ({
  label: "run",
  kind: "run",
  wallMs: 10,
  aggregation: "sum",
  iterations: 1,
  slices: {
    js: jsSlice(5),
    style: slice(1),
    layout: slice(2),
    paint: slice(0.5),
    gc: slice(0.3),
    other: slice(0.2),
    idle: slice(1),
    ...overrides,
  },
});

const nodeRun = () => ({
  label: "run",
  kind: "run",
  wallMs: 10,
  aggregation: "sum",
  iterations: 1,
  slices: {
    js: jsSlice(8),
    style: null,
    layout: null,
    paint: null,
    gc: slice(0.5),
    other: slice(0.5),
    idle: slice(1),
  },
});

// --- parseSliceBudgets: valid, repeated, malformed, unknown slice ---

test("parseSliceBudgets: a single valid entry parses to a slice->ms map", () => {
  assert.deepEqual(parseSliceBudgets(["js=5"]), { js: 5 });
});

test("parseSliceBudgets: repeated entries accumulate; ms may be fractional (wall-tier, not a count)", () => {
  assert.deepEqual(parseSliceBudgets(["js=5", "layout=2.5"]), { js: 5, layout: 2.5 });
});

test("parseSliceBudgets: an empty list is an empty map (no budgets given)", () => {
  assert.deepEqual(parseSliceBudgets([]), {});
});

test("parseSliceBudgets: a malformed entry throws (no '=', empty name, non-numeric ms)", () => {
  assert.throws(() => parseSliceBudgets(["js"]), /expects <name>=<ms>/);
  assert.throws(() => parseSliceBudgets(["=5"]), /expects <name>=<ms>/);
  assert.throws(() => parseSliceBudgets(["js=fast"]), /non-negative number of ms/);
});

test("parseSliceBudgets: an unknown slice name lists the valid names", () => {
  assert.throws(() => parseSliceBudgets(["cpu=5"]), (error) => {
    assert.match(error.message, /Unknown slice 'cpu'/);
    for (const name of SLICE_NAMES) assert.match(error.message, new RegExp(`\\b${name}\\b`));
    return true;
  });
});

// --- sliceMs: the Measured accessor (null stays null, a measured 0 stays 0) ---

test("sliceMs: reads a measured slice, keeps a measured 0, and returns null for not-measured", () => {
  const run = nodeRun();
  assert.equal(sliceMs(run.slices, "js"), 8);
  assert.equal(sliceMs(run.slices, "layout"), null, "node did not measure layout => null");
  assert.equal(sliceMs(chromeRun({ gc: slice(0) }).slices, "gc"), 0, "a measured 0 is not null");
});

// --- gateSliceBudgets: pass, fail, n/a->FAIL, --label targeting ---

test("gateSliceBudgets: a budget the slice satisfies passes", () => {
  const [gate] = gateSliceBudgets([chromeRun()], { js: 6 }, "run");
  assert.equal(gate.measured, true);
  assert.equal(gate.value, 5);
  assert.equal(gate.ok, true);
});

test("gateSliceBudgets: a value exactly at the budget passes (gate is <=)", () => {
  const [gate] = gateSliceBudgets([chromeRun()], { js: 5 }, "run");
  assert.equal(gate.measured, true);
  assert.equal(gate.value, 5);
  assert.equal(gate.ok, true);
});

test("gateSliceBudgets: a budget the slice exceeds fails", () => {
  const [gate] = gateSliceBudgets([chromeRun()], { js: 4 }, "run");
  assert.equal(gate.measured, true);
  assert.equal(gate.ok, false);
});

test("gateSliceBudgets: a budget on a not-measured slice is a loud FAIL, never a silent pass", () => {
  const [gate] = gateSliceBudgets([nodeRun()], { layout: 2 }, "run");
  assert.equal(gate.measured, false, "layout is null on node => cannot evaluate");
  assert.equal(gate.ok, false, "cannot-evaluate is a FAIL");
  assert.match(gate.reason, /not measured/);
});

test("gateSliceBudgets: a budget on a missing/unknown label is a loud FAIL naming the miss", () => {
  const [gate] = gateSliceBudgets([chromeRun()], { js: 5 }, "nope");
  assert.equal(gate.measured, false);
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /no span labelled 'nope'/);
});

test("gateSliceBudgets: no bar at all fails with a record-with-breakdown hint, not a fake pass", () => {
  const [gate] = gateSliceBudgets(null, { js: 5 }, "run");
  assert.equal(gate.measured, false);
  assert.match(gate.reason, /no per-span breakdown/);
});

test("gateSliceBudgets: --label targets a non-run span by label", () => {
  const measure = { ...chromeRun(), label: "inp", kind: "measure", aggregation: "first" };
  measure.slices = { ...measure.slices, js: jsSlice(3) };
  const results = gateSliceBudgets([chromeRun(), measure], { js: 4 }, "inp");
  assert.equal(results.length, 1);
  assert.equal(results[0].target, "inp");
  assert.equal(results[0].value, 3, "gated the inp span's js, not the run span's");
  assert.equal(results[0].ok, true);
});

test("gateSliceBudgets: budgets are gated in insertion order", () => {
  const results = gateSliceBudgets([chromeRun()], { layout: 1, js: 6 }, "run");
  assert.deepEqual(results.map((gate) => gate.slice), ["layout", "js"]);
});

// --- diffSpanSlices: matched, unmatched, missing breakdowns ---

test("diffSpanSlices: matched spans get per-slice ms deltas", () => {
  const base = [chromeRun()];
  const current = [chromeRun({ js: jsSlice(7), layout: slice(2) })];
  const diff = diffSpanSlices(base, current);
  assert.equal(diff.spans.length, 1);
  assert.equal(diff.spans[0].label, "run");
  const bySlice = Object.fromEntries(diff.spans[0].slices.map((slice) => [slice.slice, slice]));
  assert.equal(bySlice.js.delta, 2, "5 -> 7 is +2");
  assert.equal(bySlice.layout.delta, 0, "2 -> 2 is 0");
});

test("diffSpanSlices: a slice not measured on one side yields a null delta, never a fabricated regression", () => {
  const diff = diffSpanSlices([chromeRun()], [nodeRun()]);
  const bySlice = Object.fromEntries(diff.spans[0].slices.map((slice) => [slice.slice, slice]));
  assert.equal(bySlice.layout.base, 2);
  assert.equal(bySlice.layout.current, null, "current (node) did not measure layout");
  assert.equal(bySlice.layout.delta, null, "one side unmeasured => no delta invented");
});

test("diffSpanSlices: labels present on one side only are reported, not errors", () => {
  const base = [chromeRun(), { ...chromeRun(), label: "open", kind: "step" }];
  const current = [chromeRun(), { ...chromeRun(), label: "close", kind: "step" }];
  const diff = diffSpanSlices(base, current);
  assert.deepEqual(diff.spans.map((span) => span.label), ["run"], "only shared labels are compared");
  assert.deepEqual(diff.unmatchedBaseline, ["open"]);
  assert.deepEqual(diff.unmatchedCurrent, ["close"]);
});

test("diffSpanSlices: missing breakdowns on either side is empty, not a throw", () => {
  assert.deepEqual(diffSpanSlices(null, null), {
    spans: [],
    unmatchedBaseline: [],
    unmatchedCurrent: [],
  });
  const oneSide = diffSpanSlices(null, [chromeRun()]);
  assert.equal(oneSide.spans.length, 0, "no matches when one side has no spans");
  assert.deepEqual(oneSide.unmatchedCurrent, ["run"]);
});

// --- End-to-end through the commands, reading a recording with stored breakdowns ---

// A minimal summary so the count-gating path (which reads `summary` unconditionally) has fields to
// read; the slice path reads `breakdowns`. Both live on the same recording here.
const emptySummary = {
  wallMs: null, inpMs: null, scriptingMs: 0,
  layoutCount: 0, styleCount: 0, paintCount: 0,
  forcedLayoutCount: 0, layoutInvalidations: 0, paintInvalidations: 0, styleInvalidations: 0,
  longTaskCount: 0, totalEvents: 0, perIteration: [], stats: null,
};

function writeBreakdownRecording(name, breakdowns) {
  const file = path.join(tmpDir, name);
  writeFileSync(
    file,
    JSON.stringify({ meta: { target: "chrome", iterations: 1 }, summary: emptySummary, breakdowns }),
    "utf8",
  );
  return file;
}

// Stored SpanBreakdown shape (Recording.breakdowns): the run bar buildSpans folds to the run span.
const storedRun = (slices) => ({
  label: "run",
  kind: "run",
  breakdown: {
    wallMs: 10,
    slices: {
      js: jsSlice(5),
      style: slice(1),
      layout: slice(2),
      paint: slice(0.5),
      gc: slice(0.3),
      other: slice(0.2),
      idle: slice(1),
      ...slices,
    },
  },
});

test("assertCmd: --max-slice on a satisfied slice passes (exit code stays clean)", async () => {
  const file = writeBreakdownRecording("slice-ok.json", [storedRun()]);
  const code = await captureExitCode(() => assertCmd(file, {}, { js: 6 }));
  assert.equal(code, undefined);
});

test("assertCmd: --max-slice on an exceeded slice fails the gate (exit 1)", async () => {
  const file = writeBreakdownRecording("slice-fail.json", [storedRun()]);
  const code = await captureExitCode(() => assertCmd(file, {}, { js: 4 }));
  assert.equal(code, 1);
});

test("diffCmd: per-span slice deltas are advisory and never fail the gate", async () => {
  const base = writeBreakdownRecording("diff-slice-base.json", [
    { ...storedRun(), samples: undefined },
  ]);
  const current = writeBreakdownRecording("diff-slice-current.json", [storedRun({ js: jsSlice(50) })]);
  const code = await captureExitCode(() => diffCmd(base, current, { failOnRegression: true }));
  assert.equal(code, undefined, "a large js slice increase is advisory-only, not a regression");
});
