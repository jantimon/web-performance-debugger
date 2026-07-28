import { test } from "node:test";
import assert from "node:assert/strict";
import {
  frameFloorsMs,
  matchedFrameFloor,
  frameFloorDominates,
  CHROME_HEADLESS_FRAME_FLOOR_MS,
  FIREFOX_FRAME_FLOOR_MS,
  MAX_FRAME_FLOOR_MULTIPLE,
} from "../../dist/model/frame-floor.js";

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
  assert.deepEqual(matchedFrameFloor(16.6, chrome), { floorMs: 16.6, multiple: 1 });
  assert.deepEqual(matchedFrameFloor(16.7, chrome), { floorMs: 16.6, multiple: 1 });
  const firefox = { headless: true, browser: "firefox" };
  assert.deepEqual(matchedFrameFloor(16.66, firefox), { floorMs: 16.6, multiple: 1 });
  // The old 8.3ms firefox reading is no longer the floor: an 8.0 firefox median is real sub-frame work.
  assert.equal(matchedFrameFloor(8.0, firefox), null);
});

test("matchedFrameFloor: a value at a whole multiple of the floor matches that multiple", () => {
  const chrome = { headless: true };
  assert.deepEqual(matchedFrameFloor(33.2, chrome), { floorMs: 16.6, multiple: 2 }, "two frames");
  assert.deepEqual(matchedFrameFloor(49.8, chrome), { floorMs: 16.6, multiple: 3 }, "three frames");
  assert.deepEqual(matchedFrameFloor(66.4, chrome), { floorMs: 16.6, multiple: 4 }, "four frames (the cap)");
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
  const one = { floorMs: 16.6, multiple: 1 };
  const two = { floorMs: 16.6, multiple: 2 };
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
