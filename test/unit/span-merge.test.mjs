import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSpanOccurrences } from "../../dist/model/span-merge.js";

// A real seven-slice bar whose wall drives the median pick. `mark` tags it so we can prove the KEPT
// bar is byte-identical to one real occurrence, not a per-slice average.
const slice = (ms) => ({ ms });
const bar = (wallMs, mark) => ({
  wallMs,
  slices: {
    js: { ms: wallMs * 0.5, byPackage: { app: wallMs * 0.5 } },
    style: slice(0),
    layout: slice(0),
    paint: slice(0),
    gc: slice(0),
    other: slice(0),
    idle: slice(wallMs * 0.5),
  },
  mark,
});
const measure = (label, wallMs, mark) => ({ label, kind: "measure", breakdown: bar(wallMs, mark) });

test("mergeSpanOccurrences: odd count keeps the true-median-by-wall occurrence, verbatim", () => {
  const walls = [5, 1, 3]; // median wall is 3
  const merged = mergeSpanOccurrences(walls.map((wall, at) => measure("work", wall, `s${at}`)));
  assert.equal(merged.length, 1, "one bar per label");
  const kept = merged[0];
  assert.equal(kept.samples, 3, "samples counts real occurrences");
  assert.equal(kept.breakdown.wallMs, 3, "the median-wall occurrence is picked");
  assert.equal(kept.breakdown.mark, "s2", "the KEPT bar is that occurrence VERBATIM (its own mark survives)");
  assert.equal(kept.wallMinMs, 1, "spread min is the shortest occurrence");
  assert.equal(kept.wallMaxMs, 5, "spread max is the longest occurrence");
  assert.ok(kept.wallMinMs <= kept.breakdown.wallMs && kept.breakdown.wallMs <= kept.wallMaxMs);
});

test("mergeSpanOccurrences: even count takes the LOWER median, so the bar stays a real sample", () => {
  const walls = [4, 2, 8, 6]; // sorted 2,4,6,8 -> lower median is 4
  const merged = mergeSpanOccurrences(walls.map((wall, at) => measure("work", wall, `s${at}`)));
  assert.equal(merged[0].breakdown.wallMs, 4, "the lower of the two middles (not their average of 5)");
  assert.equal(merged[0].samples, 4);
  assert.equal(merged[0].wallMinMs, 2);
  assert.equal(merged[0].wallMaxMs, 8);
});

test("mergeSpanOccurrences: the kept bar reconciles exactly (residual untouched)", () => {
  const merged = mergeSpanOccurrences([measure("work", 3, "a"), measure("work", 9, "b")]);
  const { wallMs, slices } = merged[0].breakdown;
  const sum = slices.js.ms + slices.style.ms + slices.layout.ms + slices.paint.ms + slices.gc.ms + slices.other.ms + slices.idle.ms;
  assert.equal(sum, wallMs, "Σ slices + idle == wall, byte-for-byte (a real sample, never averaged)");
});

test("mergeSpanOccurrences: a single occurrence passes through with NO disclosure fields", () => {
  const only = measure("work", 7, "x");
  const merged = mergeSpanOccurrences([only]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0], only, "the exact object passes through");
  assert.equal(merged[0].samples, undefined, "no samples field on a single occurrence");
  assert.equal(merged[0].wallMinMs, undefined);
  assert.equal(merged[0].wallMaxMs, undefined);
});

test("mergeSpanOccurrences: run and step spans pass through unchanged, order preserved", () => {
  const run = { label: "run", kind: "run", breakdown: bar(20, "run") };
  const step = { label: "open", kind: "step", breakdown: bar(5, "step") };
  const merged = mergeSpanOccurrences([
    run,
    step,
    measure("work", 3, "w0"),
    measure("work", 1, "w1"),
  ]);
  assert.deepEqual(merged.map((span) => span.label), ["run", "open", "work"], "first-occurrence order kept");
  assert.equal(merged[0], run, "run passes through as-is");
  assert.equal(merged[1], step, "step passes through as-is");
  assert.equal(merged[0].samples, undefined, "run gets no samples field");
  assert.equal(merged[1].samples, undefined, "step gets no samples field");
  assert.equal(merged[2].samples, 2, "the repeated measure merged");
});

test("mergeSpanOccurrences: distinct labels are merged independently, frames of the pick survive", () => {
  const withFrames = (label, wall, mark) => ({
    ...measure(label, wall, mark),
    frames: { presented: wall, presentedPartial: 0, dropped: 0, noUpdate: 0, total: wall, frames: [] },
  });
  const merged = mergeSpanOccurrences([
    withFrames("a", 5, "a0"),
    withFrames("b", 2, "b0"),
    withFrames("a", 1, "a1"),
    withFrames("b", 4, "b1"),
  ]);
  const a = merged.find((span) => span.label === "a");
  const b = merged.find((span) => span.label === "b");
  // "a": walls 5,1 lower-median 1 -> frames.total 1 (the picked occurrence's own side track).
  assert.equal(a.breakdown.wallMs, 1);
  assert.equal(a.frames.total, 1, "the kept bar keeps ITS occurrence's frame side track");
  // "b": walls 2,4 lower-median 2.
  assert.equal(b.breakdown.wallMs, 2);
  assert.equal(b.frames.total, 2);
});
