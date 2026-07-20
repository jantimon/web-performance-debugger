import { test } from "node:test";
import assert from "node:assert/strict";
import { spanPassesFilter, filterSpanEntries } from "../../dist/model/spans.js";

// The flood filter for `query spans`: --min-wall <ms> and --filter <text> cut a tag manager's
// hundreds of tiny performance.measure spans. Pure functions, so no browser and no recording.

const entry = (label, wallMs) => ({ label, kind: "measure", wallMs });

test("spanPassesFilter: no filter keeps everything", () => {
  assert.equal(spanPassesFilter("run", 0, {}), true);
  assert.equal(spanPassesFilter("GTM-T3KJBTZ:9:162", 0.4, {}), true);
});

test("spanPassesFilter: --min-wall is a floor, not a strict cut", () => {
  assert.equal(spanPassesFilter("x", 4.9, { minWallMs: 5 }), false);
  assert.equal(spanPassesFilter("x", 5, { minWallMs: 5 }), true, "equal to the threshold is kept");
  assert.equal(spanPassesFilter("x", 5.1, { minWallMs: 5 }), true);
});

test("spanPassesFilter: --filter is a case-insensitive substring on the label", () => {
  assert.equal(spanPassesFilter("Next.js-hydration", 1, { labelIncludes: "hydration" }), true);
  assert.equal(spanPassesFilter("Next.js-hydration", 1, { labelIncludes: "HYDRATION" }), true);
  assert.equal(spanPassesFilter("GTM-T3KJBTZ", 1, { labelIncludes: "hydration" }), false);
  assert.equal(spanPassesFilter("anything", 1, { labelIncludes: "" }), true, "empty needle matches all");
});

test("spanPassesFilter: --min-wall and --filter combine with AND", () => {
  const filter = { minWallMs: 5, labelIncludes: "next" };
  assert.equal(spanPassesFilter("Next.js-hydration", 21, filter), true);
  assert.equal(spanPassesFilter("Next.js-hydration", 2, filter), false, "passes label, fails wall");
  assert.equal(spanPassesFilter("GTM-tag", 21, filter), false, "passes wall, fails label");
});

test("filterSpanEntries: returns survivors and the exact hidden count", () => {
  const spans = [
    entry("run", 7.3),
    entry("Next.js-hydration", 21),
    entry("GTM-T3KJBTZ:9:162", 0.4),
    entry("GTM-T3KJBTZ:8:387", 1.1),
    entry("GTM-T3KJBTZ:7:200", 1.9),
  ];
  const byWall = filterSpanEntries(spans, { minWallMs: 5 });
  assert.deepEqual(byWall.spans.map((span) => span.label), ["run", "Next.js-hydration"]);
  assert.equal(byWall.hidden, 3, "the three sub-5ms GTM spans are hidden and counted");

  const byLabel = filterSpanEntries(spans, { labelIncludes: "gtm" });
  assert.equal(byLabel.spans.length, 3);
  assert.equal(byLabel.hidden, 2);

  const none = filterSpanEntries(spans, {});
  assert.equal(none.hidden, 0, "an empty filter hides nothing");
  assert.equal(none.spans.length, spans.length);
});
