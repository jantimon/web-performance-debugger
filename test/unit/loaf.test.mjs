import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeLoaf,
  LOAF_FRAME_CAP,
  LOAF_SCRIPT_CAP,
  LOAF_SCRIPT_MIN_MS,
} from "../../dist/browser/driver.js";
import { mergeSteps } from "../../dist/trace/steps.js";

const script = (durationMs, extra = {}) => ({
  invoker: "BUTTON#x.onclick",
  invokerType: "event-listener",
  sourceURL: "http://host/app.js",
  sourceFunctionName: "",
  durationMs,
  forcedStyleLayoutMs: 0,
  ...extra,
});

const frame = (durationMs, scripts) => ({
  durationMs,
  blockingDurationMs: Math.max(0, durationMs - 50),
  scripts,
});

test("summarizeLoaf returns null when nothing was observed (no fabricated zero)", () => {
  assert.equal(summarizeLoaf([]), null);
});

test("summarizeLoaf sums totals over EVERY frame before capping the list", () => {
  const raw = Array.from({ length: LOAF_FRAME_CAP + 2 }, (_unused, index) =>
    frame(60 + index, [script(55)]),
  );
  const loaf = summarizeLoaf(raw);
  assert.equal(loaf.observedFrames, raw.length);
  assert.equal(loaf.frames.length, LOAF_FRAME_CAP, "the stored list is capped");
  const totalDuration = raw.reduce((sum, entry) => sum + entry.durationMs, 0);
  assert.equal(loaf.totalDurationMs, totalDuration, "totals cover every frame, not just the kept ones");
  const totalBlocking = raw.reduce((sum, entry) => sum + entry.blockingDurationMs, 0);
  assert.equal(loaf.totalBlockingMs, totalBlocking);
});

test("summarizeLoaf keeps the worst frames and worst scripts, worst-first", () => {
  const raw = [
    frame(60, [script(55)]),
    frame(200, [script(10), script(180), script(0.2, { forcedStyleLayoutMs: 0 })]),
    frame(120, [script(110)]),
  ];
  const loaf = summarizeLoaf(raw);
  assert.deepEqual(
    loaf.frames.map((entry) => entry.durationMs),
    [200, 120, 60],
    "frames are sorted by duration descending",
  );
  const worst = loaf.frames[0];
  assert.deepEqual(
    worst.scripts.map((entry) => entry.durationMs),
    [180, 10],
    "scripts sorted descending; the sub-0.5ms no-forced script is pruned",
  );
});

test("summarizeLoaf caps scripts per frame and keeps a small forced script", () => {
  const many = Array.from({ length: LOAF_SCRIPT_CAP + 3 }, (_unused, index) => script(50 - index));
  const loaf = summarizeLoaf([frame(300, many)]);
  assert.equal(loaf.frames[0].scripts.length, LOAF_SCRIPT_CAP, "scripts are capped per frame");

  // A sub-min-ms script that forced style/layout is kept (it is signal, not noise).
  const tiny = summarizeLoaf([
    frame(60, [script(LOAF_SCRIPT_MIN_MS - 0.1, { forcedStyleLayoutMs: 3 })]),
  ]);
  assert.equal(tiny.frames[0].scripts.length, 1, "a forced sub-min-ms script survives the noise filter");
  assert.equal(tiny.frames[0].scripts[0].forcedStyleLayoutMs, 3);
});

test("summarizeLoaf drops an empty sourceFunctionName rather than storing an empty string", () => {
  const loaf = summarizeLoaf([frame(60, [script(55, { sourceFunctionName: "" })])]);
  assert.equal("sourceFunctionName" in loaf.frames[0].scripts[0], false);
  const named = summarizeLoaf([frame(60, [script(55, { sourceFunctionName: "handleClick" })])]);
  assert.equal(named.frames[0].scripts[0].sourceFunctionName, "handleClick");
});

test("mergeSteps carries the first timed iteration's loaf onto the step (like counts)", () => {
  const loafZero = summarizeLoaf([frame(120, [script(110)])]);
  const steps = [
    { index: 0, label: "click", iteration: 0, wallMs: 10, inpMs: null, interaction: null, loaf: loafZero },
    { index: 0, label: "click", iteration: 1, wallMs: 12, inpMs: null, interaction: null, loaf: summarizeLoaf([frame(300, [script(280)])]) },
  ];
  const merged = mergeSteps(steps, undefined);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].loaf, loafZero, "the step reports iteration 0's loaf, not a later one");
});

test("mergeSteps omits loaf when no iteration observed one", () => {
  const steps = [
    { index: 0, label: "click", iteration: 0, wallMs: 10, inpMs: null, interaction: null },
  ];
  const merged = mergeSteps(steps, undefined);
  assert.equal("loaf" in merged[0], false, "no loaf field when none was observed");
});
