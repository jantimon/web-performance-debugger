import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSteps } from "../../dist/trace/steps.js";
import { buildSpans } from "../../dist/model/spans.js";

// The navigation/URL/LCP fields thread driver step -> MergedStep -> Span -> query view. These pin the
// two join points that are pure (mergeSteps and the model/spans adapter); the e2e covers the browser.

const nullCounts = {
  layoutCount: null,
  styleCount: null,
  paintCount: null,
  forcedLayoutCount: null,
  layoutInvalidations: null,
  styleInvalidations: null,
  longTaskCount: null,
};

const bar = (wallMs, jsMs = 1) => ({
  wallMs,
  slices: {
    js: { ms: jsMs, byPackage: {} },
    style: { ms: 0 },
    layout: { ms: 0 },
    paint: { ms: 0 },
    gc: { ms: 0 },
    other: { ms: 0 },
    idle: { ms: wallMs - jsMs },
  },
});

test("mergeSteps carries iteration 0's navigation/URLs/LCP onto the merged step", () => {
  const steps = [
    {
      index: 0,
      markIndex: 0,
      iteration: 0,
      label: "load",
      wallMs: null,
      inpMs: null,
      navigation: "hard",
      beforeUrl: "about:blank",
      afterUrl: "https://site/",
      lcp: { tag: "IMG", size: 100, url: "https://site/hero.png" },
    },
  ];
  const merged = mergeSteps(steps, undefined);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].navigation, "hard");
  assert.equal(merged[0].beforeUrl, "about:blank");
  assert.equal(merged[0].afterUrl, "https://site/");
  assert.deepEqual(merged[0].lcp, { tag: "IMG", size: 100, url: "https://site/hero.png" });
});

test("a merged step reports iteration 0's classification, not a later iteration's", () => {
  const steps = [
    {
      index: 0, markIndex: 0, iteration: 0, label: "load", wallMs: null, inpMs: null,
      navigation: "hard", beforeUrl: "about:blank", afterUrl: "https://site/", lcp: { tag: "IMG" },
    },
    {
      index: 0, markIndex: 1, iteration: 1, label: "load", wallMs: null, inpMs: null,
      navigation: "none", beforeUrl: "https://site/", afterUrl: "https://site/", lcp: { tag: "H1" },
    },
  ];
  const merged = mergeSteps(steps, undefined);
  assert.equal(merged[0].navigation, "hard", "iteration 0 is the representative");
  assert.deepEqual(merged[0].lcp, { tag: "IMG" });
});

test("a static step carries no navigation/LCP fields at all (not a fabricated marker)", () => {
  const steps = [{ index: 0, markIndex: 0, iteration: 0, label: "click", wallMs: 5, inpMs: null }];
  const merged = mergeSteps(steps, undefined);
  assert.ok(!("navigation" in merged[0]));
  assert.ok(!("beforeUrl" in merged[0]));
  assert.ok(!("lcp" in merged[0]));
});

test("buildSpans threads navigation onto both the bar step entry and the bar-less step row", () => {
  const spans = [
    { label: "run", kind: "run", aggregation: "sum", wallMs: 10, breakdown: bar(10), counts: nullCounts },
    {
      label: "load", kind: "step", aggregation: "first", index: 0, wallMs: 5, breakdown: bar(5),
      counts: nullCounts, navigation: "hard", beforeUrl: "about:blank", afterUrl: "https://site/",
    },
    {
      label: "hash", kind: "step", aggregation: "first", index: 1, wallMs: 2, counts: nullCounts,
      navigation: "soft-hash", beforeUrl: "https://site/", afterUrl: "https://site/#panel",
    },
  ];
  const result = buildSpans(spans, undefined, "chrome", 1);

  const load = result.spans.find((span) => span.label === "load");
  assert.equal(load.navigation, "hard");
  assert.equal(load.beforeUrl, "about:blank");
  assert.equal(load.afterUrl, "https://site/");

  const run = result.spans.find((span) => span.label === "run");
  assert.ok(!("navigation" in run), "the run span carries no navigation");

  // The bar-less hash step lands in barlessSpans (its only bar is the run's), carrying its own nav.
  const hash = result.barlessSpans.find((span) => span.label === "hash");
  assert.equal(hash.navigation, "soft-hash");
  assert.equal(hash.afterUrl, "https://site/#panel");
});
