import { test } from "node:test";
import assert from "node:assert/strict";
import { spansFromOccurrences, notMeasuredSpanCounts } from "../../dist/model/span.js";

// A real seven-slice bar whose wall tags it, so a sample can be proven to carry its occurrence's own
// breakdown verbatim rather than a merged or averaged one.
const slice = (ms) => ({ ms });
const bar = (wallMs, mark) => ({
  wallMs,
  slices: {
    js: { ms: wallMs, byPackage: { app: wallMs } },
    style: slice(0),
    layout: slice(0),
    paint: slice(0),
    gc: slice(0),
    other: slice(0),
    idle: slice(0),
  },
  mark,
});
const occurrence = (label, kind, wallMs, mark) => ({ label, kind, breakdown: bar(wallMs, mark) });

test("spansFromOccurrences: one Span per label, each occurrence a sample carrying its own breakdown", () => {
  const spans = spansFromOccurrences([
    occurrence("run", "run", 20, "run"),
    occurrence("work", "measure", 3, "w0"),
    occurrence("work", "measure", 1, "w1"),
  ]);
  assert.equal(spans.length, 2, "run and work, grouped by label");
  const work = spans.find((span) => span.label === "work");
  assert.equal(work.samples.length, 2, "both occurrences become samples, not collapsed");
  assert.deepEqual(
    work.samples.map((sample) => sample.breakdown.mark),
    ["w0", "w1"],
    "each sample carries its occurrence's breakdown verbatim, in first-seen order",
  );
  assert.deepEqual(
    work.samples.map((sample) => sample.wallMs),
    [3, 1],
    "sample wallMs mirrors the occurrence's breakdown wall",
  );
});

test("spansFromOccurrences: aggregation follows kind and sample count", () => {
  const [run, step, single, repeated] = spansFromOccurrences([
    occurrence("run", "run", 20, "r"),
    occurrence("open", "step", 5, "s"),
    occurrence("once", "measure", 4, "m0"),
    occurrence("twice", "measure", 6, "t0"),
    occurrence("twice", "measure", 2, "t1"),
  ]);
  assert.equal(run.aggregation, "sum", "the run window totals across iterations");
  assert.equal(step.aggregation, "first", "a step describes the first timed iteration");
  assert.equal(single.aggregation, "first", "an unrepeated measure is a single occurrence");
  assert.equal(repeated.aggregation, "median", "a repeated measure reports the median occurrence");
  assert.equal(repeated.samples.length, 2);
});

test("spansFromOccurrences: keys on kind too, so a step and a measure sharing a label never merge", () => {
  const spans = spansFromOccurrences([
    occurrence("checkout", "step", 5, "step"),
    occurrence("checkout", "measure", 3, "measure"),
  ]);
  assert.equal(spans.length, 2, "same label, different kind, stays two Spans");
  assert.deepEqual(
    spans.map((span) => span.kind),
    ["step", "measure"],
    "first-occurrence order across kinds is preserved",
  );
});

test("spansFromOccurrences: samples carry not-measured counts (SpanBreakdown windows none)", () => {
  const [span] = spansFromOccurrences([occurrence("run", "run", 20, "r")]);
  assert.deepEqual(span.samples[0].counts, notMeasuredSpanCounts());
  assert.deepEqual(notMeasuredSpanCounts(), {
    layoutCount: null,
    styleCount: null,
    paintCount: null,
    forcedLayoutCount: null,
  });
});

test("spansFromOccurrences: no occurrences yields no spans", () => {
  assert.deepEqual(spansFromOccurrences([]), []);
});
