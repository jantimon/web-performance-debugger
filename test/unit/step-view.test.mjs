import { test } from "node:test";
import assert from "node:assert/strict";
import { stepSpans, isSteppedRecording, stepEntry } from "../../dist/model/step-view.js";

// The per-step VIEW over a recording's step spans (model/step-view.ts): the shape `assert` gates
// per step and `query span <step-label>` renders. Pins index ordering, the stepped-run predicate,
// and stepEntry's field-for-field count mapping (a swapped headline field must fail here).

// A Span carries SpanCounts; every count field gets a DISTINCT value so a mis-wired mapping
// (forcedLayoutCount <- layoutCount, etc.) shows up as a wrong number, not a coincidental match.
const stepSpan = (index, label, countOverrides = {}, extra = {}) => ({
  label,
  kind: "step",
  aggregation: "first",
  index,
  wallMs: 100 + index,
  counts: {
    layoutCount: 11,
    styleCount: 12,
    paintCount: 13,
    forcedLayoutCount: 14,
    layoutInvalidations: 15,
    styleInvalidations: 16,
    longTaskCount: 17,
    ...countOverrides,
  },
  ...extra,
});

const runSpan = (label = "run") => ({
  label,
  kind: "run",
  aggregation: "sum",
  wallMs: 500,
  counts: {
    layoutCount: 0,
    styleCount: 0,
    paintCount: 0,
    forcedLayoutCount: 0,
    layoutInvalidations: 0,
    styleInvalidations: 0,
    longTaskCount: 0,
  },
});

const measureSpan = (label) => ({ ...runSpan(label), kind: "measure" });

test("stepSpans: only step spans, sorted by index, ignoring run/measure spans", () => {
  const recording = {
    spans: [
      runSpan(),
      stepSpan(2, "third"),
      measureSpan("paint-phase"),
      stepSpan(0, "first"),
      stepSpan(1, "second"),
    ],
  };
  const steps = stepSpans(recording);
  assert.deepEqual(
    steps.map((span) => span.label),
    ["first", "second", "third"],
    "run/measure spans dropped, step spans in ascending index order",
  );
  assert.deepEqual(
    steps.map((span) => span.index),
    [0, 1, 2],
    "sorted by index, not by input position",
  );
});

test("stepSpans: a step with no index sorts as 0 (the `?? 0` default)", () => {
  const noIndex = { ...stepSpan(0, "unindexed"), index: undefined };
  const recording = { spans: [stepSpan(1, "second"), noIndex] };
  const steps = stepSpans(recording);
  assert.deepEqual(steps.map((span) => span.label), ["unindexed", "second"]);
});

test("isSteppedRecording: true with at least one step span, false without", () => {
  assert.equal(isSteppedRecording({ spans: [runSpan(), stepSpan(0, "open")] }), true);
  assert.equal(isSteppedRecording({ spans: [runSpan(), measureSpan("m")] }), false, "a run + measure only run is not stepped");
  assert.equal(isSteppedRecording({ spans: [] }), false, "an empty span list is not stepped");
});

test("stepEntry: maps each count to its OWN headline field (a swapped field fails)", () => {
  const entry = stepEntry(
    stepSpan(3, "add rows", {
      layoutCount: 11,
      styleCount: 12,
      paintCount: 13,
      forcedLayoutCount: 14,
      layoutInvalidations: 15,
      styleInvalidations: 16,
      longTaskCount: 17,
    }),
  );
  assert.equal(entry.index, 3);
  assert.equal(entry.label, "add rows");
  assert.equal(entry.wallMs, 103);
  // Distinct values pin the wiring: any cross-field swap surfaces here.
  assert.equal(entry.headline.layoutCount, 11, "layoutCount <- counts.layoutCount");
  assert.equal(entry.headline.forcedLayoutCount, 14, "forcedLayoutCount <- counts.forcedLayoutCount, not layoutCount");
  assert.equal(entry.headline.paintCount, 13, "paintCount <- counts.paintCount");
  assert.equal(entry.headline.layoutInvalidations, 15, "layoutInvalidations <- counts.layoutInvalidations");
  assert.equal(entry.headline.styleInvalidations, 16, "styleInvalidations <- counts.styleInvalidations, not layoutInvalidations");
  assert.equal(entry.headline.longTaskCount, 17, "longTaskCount <- counts.longTaskCount");
  // styleCount is NOT a headline field: the per-step headline exposes layout, not style, counts.
  assert.ok(!("styleCount" in entry.headline), "styleCount is not projected into the headline");
});

test("stepEntry: index/inp/interaction/stats default when the span omits them", () => {
  const bare = { ...stepSpan(0, "bare"), index: undefined, inpMs: undefined, interaction: undefined, stats: undefined };
  const entry = stepEntry(bare);
  assert.equal(entry.index, 0, "missing index defaults to 0");
  assert.equal(entry.inpMs, null, "missing inpMs is null, never a fabricated 0");
  assert.equal(entry.interaction, null);
  assert.equal(entry.stats, null);
});

test("stepEntry: a measured inpMs / interaction / stats survive verbatim", () => {
  const interaction = { inputDelay: 2, processing: 40, presentation: 3 };
  const stats = { min: 1, median: 2, mean: 2, max: 3 };
  const entry = stepEntry({ ...stepSpan(1, "click"), inpMs: 45, interaction, stats });
  assert.equal(entry.inpMs, 45);
  assert.deepEqual(entry.interaction, interaction);
  assert.deepEqual(entry.stats, stats);
});
