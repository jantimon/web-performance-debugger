import { test } from "node:test";
import assert from "node:assert/strict";
import { notMeasuredSpanCounts, countsFromSummary } from "../../dist/model/span.js";

// The stored Span's `counts` sub-object: not-measured is an explicit null on every field (never a
// fake 0), and a run/step span projects the seven Measured counts off its summary.

test("notMeasuredSpanCounts: every count is null (not-measured), never a fabricated 0", () => {
  assert.deepEqual(notMeasuredSpanCounts(), {
    layoutCount: null,
    styleCount: null,
    paintCount: null,
    forcedLayoutCount: null,
    layoutInvalidations: null,
    styleInvalidations: null,
    longTaskCount: null,
  });
});

test("countsFromSummary: projects exactly the seven windowed counts, preserving Measured null vs 0", () => {
  const summary = {
    layoutCount: 5,
    styleCount: 0, // a measured 0 stays 0, distinct from not-measured
    paintCount: 2,
    forcedLayoutCount: null, // --breakdown dropped .stack: not-measured, not clean
    layoutInvalidations: 3,
    styleInvalidations: null,
    longTaskCount: 1,
    // fields the projection must ignore
    wallMs: 99,
    inpMs: 40,
    jsSelfMs: 12,
  };
  assert.deepEqual(countsFromSummary(summary), {
    layoutCount: 5,
    styleCount: 0,
    paintCount: 2,
    forcedLayoutCount: null,
    layoutInvalidations: 3,
    styleInvalidations: null,
    longTaskCount: 1,
  });
});
