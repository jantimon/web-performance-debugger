import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSpanOccurrences } from "../../dist/model/span-merge.js";
import { buildRecordingSpans } from "../../dist/record/spans-build.js";
import { buildSummary, NO_RENDERING_CAPTURE } from "../../dist/metrics/summarize.js";
import { buildGeckoSpanBreakdowns } from "../../dist/profile/gecko-breakdown.js";
import { parseGecko, geckoToRawCpuProfile } from "../../dist/profile/gecko.js";
import { spanTiming } from "../../dist/model/span-timing.js";
import { syntheticGeckoDump } from "./helpers.mjs";

const measure = (wallMs) => ({
  label: "work",
  kind: "measure",
  occurrenceTimingMs: wallMs,
  breakdown: {
    wallMs,
    slices: {
      js: { ms: wallMs / 2, byPackage: { app: wallMs / 2 } },
      style: { ms: 0 },
      layout: { ms: 0 },
      paint: { ms: 0 },
      gc: { ms: 0 },
      other: { ms: 0 },
      idle: { ms: wallMs / 2 },
    },
  },
});

function storedSpans(bars) {
  return buildRecordingSpans({
    summary: buildSummary({ detailEvents: [], detailWindowStart: null }),
    detailEvents: [],
    capabilities: NO_RENDERING_CAPTURE,
    bars,
    runWindowEnd: null,
  });
}

test("recording spans preserve measure samples through JSON storage", () => {
  const bars = mergeSpanOccurrences([8, 2, 6, 4].map(measure));
  const spans = JSON.parse(JSON.stringify(storedSpans(bars)));
  const work = spans.find((span) => span.kind === "measure");
  assert.deepEqual(work.occurrenceWallMs, [8, 2, 6, 4]);
  assert.equal(work.samples, 4);
  assert.equal(work.wallMs, 4, "the bar uses a real lower-median occurrence");
  assert.equal(work.wallMinMs, 2);
  assert.equal(work.wallMaxMs, 8);
  assert.equal(work.aggregation, "median");
  assert.deepEqual(work.breakdown, bars[0].breakdown);
  assert.equal(Object.hasOwn(work, "occurrenceTimingMs"), false, "assembly timing does not leak into storage");
  assert.equal(work.perIteration, undefined, "occurrences do not imply one sample per iteration");
  assert.equal(spans[0].occurrenceWallMs, undefined, "run timings stay separate");
});

test("recording spans omit occurrence samples when the bar has no series", () => {
  for (const bar of [
    measure(4),
    { ...measure(4), samples: 3, wallMinMs: 2, wallMaxMs: 8 },
  ]) {
    const work = storedSpans([bar]).find((span) => span.kind === "measure");
    assert.equal(Object.hasOwn(work, "occurrenceWallMs"), false);
  }
});

test("Firefox measure timings use marker bounds even when the sampled bar misses the work", () => {
  const raw = geckoToRawCpuProfile(parseGecko(syntheticGeckoDump()));
  const windows = [[100, 200], [950, 1050], [1100, 1900], [2900, 4100]].map(([start, end]) => ({
    label: "work", startTs: raw.startTime + start, endTs: raw.startTime + end,
  }));
  const bars = buildGeckoSpanBreakdowns(raw, new Map(), windows, {
    startTs: raw.startTime, endTs: raw.startTime + 5000,
  }, 1000);
  const work = JSON.parse(JSON.stringify(storedSpans(bars))).find((span) => span.kind === "measure");
  assert.deepEqual(work.occurrenceWallMs, [0.1, 0.1, 0.8, 1.2]);
  assert.equal(work.breakdown.wallMs, 0, "the lower-median profile window contains no sample");
  assert.equal(work.wallMinMs, 0);
  assert.equal(work.wallMaxMs, 2, "profile spread still uses whole sampled deltas");
  const timing = spanTiming(work);
  assert.equal(timing.clock, "trace");
  assert.equal(timing.boundary, "performance-measure");
  assert.deepEqual(timing.samplesMs, [0.1, 0.1, 0.8, 1.2]);
  assert.equal(timing.stats.medianMs, 0.45);
  assert.equal(timing.stats.minMs, 0.1);
  assert.equal(timing.stats.maxMs, 1.2);
});
