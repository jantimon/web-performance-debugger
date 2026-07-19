import { test } from "node:test";
import assert from "node:assert/strict";
import { labelWindows, mergeSteps } from "../../dist/trace/steps.js";
import { interactionBreakdown } from "../../dist/browser/driver.js";
import { driverStep, eventTiming, PLAIN_CLICK, HELD_CLICK, nonNegative } from "./helpers.mjs";

test("labelWindows re-keys a pass's own windows from index to label", () => {
  const steps = [driverStep(0, "mount"), driverStep(1, "hydrate"), driverStep(2, "inp")];
  // findSteps returns windows sorted by index; the trace can lose marks but never invent them,
  // so a window with no step (index 9) is dropped rather than paired with anything.
  const windows = [
    { index: 0, startTs: 100, endTs: 200 },
    { index: 2, startTs: 500, endTs: null },
    { index: 9, startTs: 900, endTs: 999 },
  ];
  // iteration defaults to 0 for hand-built steps: a flow that ran once is iteration 0 by
  // definition, and the merge reads absent as 0 rather than matching nothing.
  assert.deepEqual(labelWindows(steps, windows), [
    { label: "mount", iteration: 0, startTs: 100, endTs: 200 },
    { label: "inp", iteration: 0, startTs: 500, endTs: null },
  ]);
});

// --iterations repeats the flow, so the SAME label recurs once per iteration. Those repetitions
// are the samples that make a median mean anything; keying the trace by `index` would collide
// them, which is why the marks carry their own counter.
test("labelWindows keys by markIndex, so a repeated label stays distinct per iteration", () => {
  const steps = [
    { index: 0, iteration: 0, markIndex: 0, label: "mount", wallMs: 10, inpMs: null, cdpDelta: {} },
    { index: 0, iteration: 1, markIndex: 1, label: "mount", wallMs: 12, inpMs: null, cdpDelta: {} },
  ];
  const windows = [
    { index: 0, startTs: 100, endTs: 200 },
    { index: 1, startTs: 300, endTs: 400 },
  ];
  assert.deepEqual(labelWindows(steps, windows), [
    { label: "mount", iteration: 0, startTs: 100, endTs: 200 },
    { label: "mount", iteration: 1, startTs: 300, endTs: 400 },
  ]);
});

test("mergeSteps: a repeated label becomes one step with its samples, window from iteration 0", () => {
  const step = (iteration, markIndex, label, wallMs) => ({
    index: label === "mount" ? 0 : 1,
    iteration,
    markIndex,
    label,
    wallMs,
    inpMs: null,
  });
  const timing = [
    step(0, 0, "mount", 40),
    step(0, 1, "inp", 5),
    // later iterations are warm: faster, and their windows are dropped (only iteration 0 is paired,
    // so per-step counts window to one iteration and never scale)
    step(1, 2, "mount", 30),
    step(1, 3, "inp", 9),
    step(2, 4, "mount", 32),
    step(2, 5, "inp", 7),
  ];
  // Only iteration 0's windows are paired, so a step's trace-derived counts describe one iteration.
  const traced = [
    { label: "mount", iteration: 0, startTs: 100, endTs: 200 },
    { label: "inp", iteration: 0, startTs: 300, endTs: 400 },
  ];
  const merged = mergeSteps(timing, traced);

  assert.equal(merged.length, 2, "one merged step per label, not per measureStep call");
  const mount = merged.find((entry) => entry.label === "mount");
  assert.deepEqual(mount.perIteration, [40, 30, 32], "samples in iteration order, all kept");
  assert.equal(mount.wallMs, 32, "headline is the median (32), not the cold first sample (40)");
  assert.equal(mount.startTs, 100, "window from the first timed iteration, so counts never scale");
  assert.equal(merged.find((entry) => entry.label === "inp").wallMs, 7);
});

// The mirror of the counts rule, on the INP axis: taking the worst across iterations would make
// INP climb with --iterations, so raising it to gain confidence would report a regression that
// did not happen.
test("mergeSteps: per-step INP is the median across iterations, not the worst", () => {
  const step = (iteration, markIndex, inpMs) => ({
    index: 0,
    iteration,
    markIndex,
    label: "open menu",
    wallMs: 10,
    inpMs,
    cdpDelta: {},
  });
  const merged = mergeSteps([step(0, 0, 100), step(1, 1, 40), step(2, 2, 48)], undefined);
  assert.equal(merged[0].inpMs, 48, "median of 40/48/100, not the 100ms cold outlier");

  // A step with no interaction stays null rather than becoming 0: they mean different things.
  const noneMeasured = mergeSteps([step(0, 0, null), step(1, 1, null)], undefined);
  assert.equal(noneMeasured[0].inpMs, null);
});

// A flow that measures different steps per iteration produces samples describing different work
// while presenting as one distribution.
test("mergeSteps throws when an iteration measured different steps", () => {
  const step = (iteration, markIndex, label) => ({
    index: 0,
    iteration,
    markIndex,
    label,
    wallMs: 10,
    inpMs: null,
    cdpDelta: {},
  });
  const timing = [
    step(0, 0, "mount"),
    step(0, 1, "inp"),
    step(1, 2, "mount"), // "inp" skipped: a median over 1 sample would be labelled 2
  ];
  assert.throws(() => mergeSteps(timing, undefined), /Iteration 1 measured different steps.*missing: inp/s);
});

test("mergeSteps pairs by label, not by position", () => {
  // The trace's step windows can arrive in a different order than the step timings (findSteps sorts
  // by index). A positional/index-keyed merge would attach "inp"'s window to "mount".
  const timing = [driverStep(0, "mount"), driverStep(1, "hydrate"), driverStep(2, "inp")];
  const traced = [
    { label: "inp", startTs: 500, endTs: 600 },
    { label: "mount", startTs: 100, endTs: 200 },
    { label: "hydrate", startTs: 300, endTs: 400 },
  ];
  const merged = mergeSteps(timing, traced);
  assert.deepEqual(
    merged.map((step) => [step.label, step.startTs, step.endTs]),
    [
      ["mount", 100, 200],
      ["hydrate", 300, 400],
      ["inp", 500, 600],
    ],
  );
  // the step timing owns wall; only the window comes from the trace
  assert.equal(merged[0].wallMs, 10);
});

test("mergeSteps throws when the passes recorded different steps (never emits a null window)", () => {
  const timing = [driverStep(0, "mount"), driverStep(1, "hydrate"), driverStep(2, "inp")];
  // The trace pass took a different path and skipped "hydrate". Index-keyed, "inp" would silently
  // inherit "hydrate"'s window and every count for the unmatched step would read 0 -- which
  // `assert --max-forced 0` reads as a pass.
  const traced = [
    { label: "mount", startTs: 100, endTs: 200 },
    { label: "inp", startTs: 300, endTs: 400 },
  ];
  assert.throws(() => mergeSteps(timing, traced), /different steps.*only in the timing pass: hydrate/s);
});

test("mergeSteps rejects duplicate labels rather than joining the wrong pair", () => {
  const timing = [driverStep(0, "mount"), driverStep(1, "mount")];
  assert.throws(() => mergeSteps(timing, undefined), /Duplicate step label "mount"/);
});

test("mergeSteps degrades (no throw) when the detail pass collected no windows at all", () => {
  // A lane without tracing (e.g. Firefox without --cpu-profile) has nothing to pair with. That is
  // absence, not divergence.
  const timing = [driverStep(0, "mount"), driverStep(1, "inp")];
  const merged = mergeSteps(timing, undefined);
  assert.deepEqual(
    merged.map((step) => [step.label, step.startTs, step.endTs]),
    [
      ["mount", null, null],
      ["inp", null, null],
    ],
  );
});

// prepare() runs ONCE, before the timed loop, so a step it measures has one sample no matter what
// --iterations says. Counting it as part of iteration 0 made the idempotency check see an extra
// label there and fail every repeated run whose prepare() measured anything -- telling the user
// their flow was not idempotent when it was, and that the fix was to drop --iterations.
test("mergeSteps: a step measured in prepare() is single-sample, not an idempotency violation", () => {
  const prepared = {
    index: 0,
    iteration: 0,
    phase: "prepare",
    markIndex: 0,
    label: "boot",
    wallMs: 300,
    inpMs: null,
    cdpDelta: { LayoutCount: 9 },
  };
  const timed = (iteration, markIndex, wallMs) => ({
    index: 1,
    iteration,
    phase: "timed",
    markIndex,
    label: "click",
    wallMs,
    inpMs: null,
    cdpDelta: { LayoutCount: 2 },
  });
  const steps = [prepared, timed(0, 1, 50), timed(1, 2, 40), timed(2, 3, 42)];

  const merged = mergeSteps(steps, undefined);
  assert.equal(merged.length, 2);
  const boot = merged.find((step) => step.label === "boot");
  assert.deepEqual(boot.perIteration, [300], "prepare ran once, so it has one sample");
  assert.equal(boot.wallMs, 300);
  assert.equal(merged.find((step) => step.label === "click").perIteration.length, 3);

  // Its window must still be paired: dropping it would report the step's counts as 0, which reads
  // as "clean" rather than "not measured".
  const windows = [
    { label: "boot", iteration: 0, startTs: 10, endTs: 20 },
    { label: "click", iteration: 0, startTs: 30, endTs: 40 },
  ];
  const withWindows = mergeSteps(steps, windows);
  assert.equal(withWindows.find((step) => step.label === "boot").startTs, 10);
});

test("interactionBreakdown: recovers the handler from a plain click", () => {
  const split = interactionBreakdown(PLAIN_CLICK);
  nonNegative(split, "plain click");
  // Off the interaction's group, not the pointerover entries, which tie on duration and do nothing.
  assert.ok(Math.abs(split.inputDelayMs - 0.2) < 0.05, `input delay ${split.inputDelayMs}`);
  assert.ok(Math.abs(split.processingMs - 45.4) < 0.05, `the 45ms handler, got ${split.processingMs}`);
  // The parts reconstruct the interaction's duration, which is what INP reports.
  const total = split.inputDelayMs + split.processingMs + split.presentationDelayMs;
  assert.ok(Math.abs(total - 64) < 0.05, `parts sum to the interaction duration, got ${total}`);
});

// The regression this function shipped with: mixing pointerdown's startTime with click's duration
// reported processingMs 297.5 and presentationDelayMs -241.8 for the same 45ms handler.
test("interactionBreakdown: a held click spans two paints and still prices the handler", () => {
  const split = interactionBreakdown(HELD_CLICK);
  nonNegative(split, "held click");
  assert.ok(Math.abs(split.processingMs - 45.3) < 0.05, `the 45ms handler, got ${split.processingMs}`);
  // Anchored on the paint INP is measured by (duration 64), not on pointerdown's earlier paint
  // (duration 24) -- that would price the button being held and lose the handler.
  const total = split.inputDelayMs + split.processingMs + split.presentationDelayMs;
  assert.ok(Math.abs(total - 64) < 0.05, `parts sum to the worst paint's duration, got ${total}`);
});

test("interactionBreakdown: null when nothing is an interaction", () => {
  // A programmatic step (page.evaluate -> el.click()) fires untrusted events, which Event Timing
  // does not observe at all. Verified in headless Chrome: zero entries. Reporting 0ms of handler
  // for that would read as "your handler is free" rather than "not measured".
  assert.equal(interactionBreakdown([]), null);
  assert.equal(
    interactionBreakdown(PLAIN_CLICK.filter((entry) => !entry.interactionId)),
    null,
    "entries with no interactionId are not an interaction",
  );
});

test("interactionBreakdown: picks the worst interaction when a step has several", () => {
  const split = interactionBreakdown([
    eventTiming("click", 0, 0.5, 2.0, 24, 1),
    eventTiming("click", 100, 100.5, 180.0, 96, 2), // the slow one
  ]);
  nonNegative(split, "two interactions");
  assert.ok(Math.abs(split.processingMs - 79.5) < 0.05, "the worst interaction's handler, not the first");
});
