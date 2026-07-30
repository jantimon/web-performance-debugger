import { test } from "node:test";
import assert from "node:assert/strict";
import {
  frameFloorsMs,
  matchedFrameFloor,
  frameFloorDominates,
  workSignalFloor,
  CHROME_HEADLESS_FRAME_FLOOR_MS,
  FIREFOX_FRAME_FLOOR_MS,
  IDLE_DOMINANT_SHARE,
  MAX_FRAME_FLOOR_MULTIPLE,
} from "../../dist/model/frame-floor.js";
import { barFrameFloor } from "../../dist/model/spans.js";

// The one-frame floor that pins wall/INP on sub-frame work. matchedFrameFloor decides which whole
// multiple of the cadence a median "sits on"; frameFloorDominates gates an elevated multiple on the
// window's wait share so a busy multi-frame wall is not mislabeled (docs/dev/frame-floor.md).

test("frameFloorsMs: chrome built-in headless is the synthetic-60Hz floor", () => {
  assert.deepEqual(frameFloorsMs({ headless: true }), [CHROME_HEADLESS_FRAME_FLOOR_MS]);
});

test("frameFloorsMs: firefox headless tracks the host to the same ~16.6ms floor as chrome", () => {
  // Firefox's cadence is display-contingent; on CI / an idle panel it sits on ~60Hz, not 120Hz.
  assert.equal(FIREFOX_FRAME_FLOOR_MS, 16.6, "the stamped firefox floor is the idle/CI reading, not 8.3");
  assert.deepEqual(frameFloorsMs({ headless: true, browser: "firefox" }), [FIREFOX_FRAME_FLOOR_MS]);
});

test("frameFloorsMs: headed declares no deterministic floor", () => {
  // Headed flaps 120/60Hz run to run, so no floor can be claimed.
  assert.deepEqual(frameFloorsMs({ headless: false }), []);
});

test("matchedFrameFloor: a median at the one-frame boundary matches multiple 1", () => {
  const chrome = { headless: true };
  assert.deepEqual(matchedFrameFloor(16.6, chrome), { basis: "wall-multiple", floorMs: 16.6, multiple: 1 });
  assert.deepEqual(matchedFrameFloor(16.7, chrome), { basis: "wall-multiple", floorMs: 16.6, multiple: 1 });
  const firefox = { headless: true, browser: "firefox" };
  assert.deepEqual(matchedFrameFloor(16.66, firefox), { basis: "wall-multiple", floorMs: 16.6, multiple: 1 });
  // The old 8.3ms firefox reading is no longer the floor: an 8.0 firefox median is real sub-frame work.
  assert.equal(matchedFrameFloor(8.0, firefox), null);
});

test("matchedFrameFloor: a value at a whole multiple of the floor matches that multiple", () => {
  const chrome = { headless: true };
  assert.deepEqual(matchedFrameFloor(33.2, chrome), { basis: "wall-multiple", floorMs: 16.6, multiple: 2 }, "two frames");
  assert.deepEqual(matchedFrameFloor(49.8, chrome), { basis: "wall-multiple", floorMs: 16.6, multiple: 3 }, "three frames");
  assert.deepEqual(matchedFrameFloor(66.4, chrome), { basis: "wall-multiple", floorMs: 16.6, multiple: 4 }, "four frames (the cap)");
});

test("matchedFrameFloor: the cap bounds the multiple, so a far value is real work", () => {
  const chrome = { headless: true };
  // 5x the floor (83ms) is past MAX_FRAME_FLOOR_MULTIPLE: a wall that long is its own work signal.
  assert.equal(MAX_FRAME_FLOOR_MULTIPLE, 4);
  assert.equal(matchedFrameFloor(16.6 * 5, chrome), null, "beyond the cap: not claimed as a floor");
});

test("matchedFrameFloor: work above or below a frame is not floored", () => {
  const chrome = { headless: true };
  // 18.1ms reads through linearly (frame-floor.md), sitting between one and two frames.
  assert.equal(matchedFrameFloor(18.1, chrome), null);
  // A clearly sub-frame 2ms median is real work that escaped the floor, not the floor itself.
  assert.equal(matchedFrameFloor(2, chrome), null);
  // Between two frames (25ms) is real work, not a whole multiple.
  assert.equal(matchedFrameFloor(25, chrome), null);
});

test("matchedFrameFloor: null/headed/unmeasured never match", () => {
  const chrome = { headless: true };
  assert.equal(matchedFrameFloor(null, chrome), null);
  assert.equal(matchedFrameFloor(undefined, chrome), null);
  assert.equal(matchedFrameFloor(16.6, { headless: false }), null);
});

test("frameFloorDominates: one frame is the floor whatever the work; a multi-frame value needs a wait", () => {
  const one = { basis: "wall-multiple", floorMs: 16.6, multiple: 1 };
  const two = { basis: "wall-multiple", floorMs: 16.6, multiple: 2 };
  // n=1 needs no evidence: a latency cannot beat one frame.
  assert.equal(frameFloorDominates(one, null), true);
  assert.equal(frameFloorDominates(one, 0.05), true, "even a busy one-frame value is still one frame");
  // n>=2 fires only when the window is wait-dominated (idle >= 80%): the 33.2ms sub-ms-work case.
  assert.equal(frameFloorDominates(two, 0.98), true, "two frames, ~all idle: a genuine floor");
  // A busy two-frame wall (real work, ~9% idle) is NOT a floor.
  assert.equal(frameFloorDominates(two, 0.09), false, "busy 33ms wall: real work near two frames");
  // No wait signal to judge => an elevated multiple is not claimed.
  assert.equal(frameFloorDominates(two, null), false);
});

// workSignalFloor reads a driver step's frame floor off its reconciling BAR, not its wall value: a
// trusted page.click carries ~8ms of input dispatch inside the step window, so a floored cheap step's
// wall (~41ms) lands off any exact n*floor and matchedFrameFloor misses it. The bar still proves the
// case when the summed real work is sub-frame and the window is idle-dominated (docs/dev/frame-floor.md).

test("workSignalFloor: a floored cheap step (0.63ms work, idle 0.90) is flagged", () => {
  const chrome = { headless: true };
  // [measured] the probe's floored cheap page.click step: work-sum 0.63ms, idle share 0.90.
  assert.deepEqual(
    workSignalFloor(chrome, 0.63, 0.9),
    { basis: "work-signal", floorMs: 16.6, workMs: 0.63 },
    "sub-frame work in an idle-dominated window is a floor, independent of the wall value",
  );
});

test("workSignalFloor: a busy control (26ms work, idle 0.55) is rejected", () => {
  const chrome = { headless: true };
  // [measured] the ~25ms busy control: work ~26ms (over one frame), idle share 0.55.
  assert.equal(workSignalFloor(chrome, 26, 0.55), null, "work over one frame is real work, not a floor");
  // Even sub-frame work is not a floor when the window is not idle-dominated (< IDLE_DOMINANT_SHARE).
  assert.equal(IDLE_DOMINANT_SHARE, 0.8);
  assert.equal(workSignalFloor(chrome, 0.63, 0.79), null, "just under the idle cutoff: not claimed");
  // Work exactly at one frame is not sub-frame.
  assert.equal(workSignalFloor(chrome, 16.6, 0.95), null, "work at the floor is not under it");
});

test("workSignalFloor: no bar (idleShare null) and no deterministic floor (headed) both decline", () => {
  assert.equal(workSignalFloor({ headless: true }, 0.63, null), null, "no idle signal to judge");
  assert.equal(workSignalFloor({ headless: false }, 0.63, 0.95), null, "headed declares no floor");
});

// barFrameFloor (model/spans.ts) is the kind DISPATCH over the two floor bases: a driver STEP is judged
// by its bar's work signal (its wall carries ~8ms of trusted-click input dispatch, so it lands off any
// exact n*floor), a run/measure span by its wall value's multiple. These two cases pin that routing so a
// mutant swapping the arms is caught: each fixture is built so the OTHER arm returns undefined on it.

const bar = (wallMs, { js = 0, style = 0, layout = 0, paint = 0, gc = 0, other = 0, idle = 0 }) => ({
  wallMs,
  slices: {
    js: { ms: js },
    style: { ms: style },
    layout: { ms: layout },
    paint: { ms: paint },
    gc: { ms: gc },
    other: { ms: other },
    idle: { ms: idle },
  },
});

test("barFrameFloor: a floored driver STEP routes to the bar's work signal (basis work-signal)", () => {
  const chrome = { headless: true };
  // A cheap trusted-click step: sub-frame work (0.63ms) in an idle-dominated 41ms window. Its wall
  // (41ms) sits off any exact n*floor, so the wall-multiple arm would MISS it -- proving the dispatch.
  const stepBar = bar(41, { js: 0.63, idle: 39 });
  assert.deepEqual(barFrameFloor("step", 41, stepBar, chrome), {
    basis: "work-signal",
    floorMs: 16.6,
    workMs: 0.63,
  });
  // The wall value alone does NOT floor at 41ms: only the bar's work signal proves the step floored, so
  // routing a step to the wall-multiple arm (the swapped mutant) would return undefined here.
  assert.equal(matchedFrameFloor(41, chrome), null);
});

test("barFrameFloor: a run span routes to the wall-multiple arm (basis wall-multiple)", () => {
  const chrome = { headless: true };
  // A one-frame run window whose bar is BUSY (16.6ms of work, 0 idle): the work-signal arm rejects it
  // (work over a frame, not idle-dominated), so the swapped mutant (run -> work signal) returns
  // undefined. The correct wall-multiple arm reads its 16.6ms wall as one frame.
  const runBar = bar(16.6, { js: 16.6, idle: 0 });
  assert.deepEqual(barFrameFloor("run", 16.6, runBar, chrome), {
    basis: "wall-multiple",
    floorMs: 16.6,
    multiple: 1,
  });
  // Confirm the other arm would decline this fixture, so the assertion above pins the routing.
  assert.equal(workSignalFloor(chrome, 16.6, 0), null, "the work-signal arm rejects a busy run bar");
});
