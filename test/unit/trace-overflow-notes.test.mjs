import { test } from "node:test";
import assert from "node:assert/strict";
import * as notesCatalog from "../../dist/record/notes.js";
import { mergeSteps } from "../../dist/trace/steps.js";
import { driverStep } from "./helpers.mjs";

// The two honest signals a heavy --deep trace can raise: buffer overflow (data loss) and a partial
// --keep-partial run. Both must disclose loudly; neither may report a silent, plausible-but-wrong
// number. See docs/dev/trace-buffer.md.

test("traceDataLoss note names the dropped-count risk and the remedy", () => {
  const note = notesCatalog.traceDataLoss();
  assert.match(note, /^WARNING:/);
  assert.match(note, /overflow|dropped|data loss/i);
  assert.match(note, /UNDERCOUNT|floor/i, "says counts are a floor, not exact");
  assert.match(note, /--breakdown/, "offers the lighter-trace remedy");
});

test("partialIterations note names the failed iteration, the step, and the completed count", () => {
  const note = notesCatalog.partialIterations(3, 1, 1, "add-to-cart", "Waiting failed: 30000ms exceeded");
  assert.match(note, /^WARNING: --keep-partial:/);
  assert.match(note, /iteration 2 of 3/, "1-based failed iteration");
  assert.match(note, /add-to-cart/, "names the step it died on");
  assert.match(note, /only the 1 iteration/, "states the completed count");
  assert.match(note, /Waiting failed: 30000ms exceeded/, "carries the underlying reason");
});

test("partialIterations note handles a failure between steps (no active step)", () => {
  const note = notesCatalog.partialIterations(5, 2, 2, null, "nav timeout");
  assert.match(note, /between steps/);
  assert.doesNotMatch(note, /step 'null'/);
});

// mergeSteps hard-errors on a step/window divergence. When the divergence is KNOWN to be a trace
// overflow (Chrome reported data loss), the message must say so outright, not also blame idempotency.
test("mergeSteps: a divergence under known data loss blames the overflow, not the flow", () => {
  const timing = [driverStep(0, "search"), driverStep(1, "open-product"), driverStep(2, "add-to-cart")];
  const traced = [
    { label: "search", startTs: 100, endTs: 200 },
    { label: "open-product", startTs: 300, endTs: 400 },
    // add-to-cart's marker was dropped by the overflow.
  ];
  assert.throws(
    () => mergeSteps(timing, traced, true),
    (error) =>
      /trace buffer overflowed/i.test(error.message) &&
      /data loss/i.test(error.message) &&
      /add-to-cart/.test(error.message) &&
      !/idempotent/.test(error.message),
    "names the overflow and the dropped step, and does not offer the idempotency cause",
  );
});

test("mergeSteps: the same divergence without data loss offers the idempotency cause", () => {
  const timing = [driverStep(0, "search"), driverStep(1, "open-product"), driverStep(2, "add-to-cart")];
  const traced = [
    { label: "search", startTs: 100, endTs: 200 },
    { label: "open-product", startTs: 300, endTs: 400 },
  ];
  assert.throws(
    () => mergeSteps(timing, traced, false),
    (error) => /idempotent/.test(error.message) && /add-to-cart/.test(error.message),
  );
});
