import { test } from "node:test";
import assert from "node:assert/strict";
import { hotSuppressionReason } from "../../dist/commands/query.js";

// A suppressed per-span hot tally must point the reader at the RIGHT next step. The misleading case
// this guards against: "raise --iterations" printed when the pool is 0 because a mid-run navigation
// reset the V8 sampler, which more iterations cannot fix. hotSuppressionReason is the pure split.

const INTERVAL_US = 200; // 0.2 ms sampler period

test("hotSuppressionReason: a thin-but-nonzero pool is below-floor (raise --iterations helps)", () => {
  assert.equal(hotSuppressionReason(4, 50, INTERVAL_US), "below-floor");
  assert.equal(hotSuppressionReason(1, 0.5, INTERVAL_US), "below-floor");
});

test("hotSuppressionReason: zero pool over a window with real JS is not-covered (the navigation gap)", () => {
  // 58 ms of JS at a 0.2 ms period should have landed ~290 samples; zero means the sampler never
  // ran over this window, not bad luck.
  assert.equal(hotSuppressionReason(0, 58, INTERVAL_US), "not-covered");
  // Two expected samples is the threshold: 0.4 ms / 0.2 ms = 2.
  assert.equal(hotSuppressionReason(0, 0.4, INTERVAL_US), "not-covered");
});

test("hotSuppressionReason: zero pool over a window with negligible JS is no-js (nothing to rank)", () => {
  assert.equal(hotSuppressionReason(0, 0, INTERVAL_US), "no-js");
  // Below two expected samples, a zero pool is plausibly just a window too thin to sample.
  assert.equal(hotSuppressionReason(0, 0.3, INTERVAL_US), "no-js");
});

test("hotSuppressionReason: a zero or missing sampler interval never claims not-covered", () => {
  // Without a known period the expected-sample test cannot be made, so it stays no-js rather than
  // asserting a coverage gap it cannot substantiate.
  assert.equal(hotSuppressionReason(0, 58, 0), "no-js");
});
