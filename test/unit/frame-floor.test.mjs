import { test } from "node:test";
import assert from "node:assert/strict";
import {
  frameFloorsMs,
  matchedFrameFloorMs,
  CHROME_HEADLESS_FRAME_FLOOR_MS,
  FIREFOX_FRAME_FLOOR_MS,
} from "../../dist/model/frame-floor.js";

// The one-frame floor that pins wall/INP on sub-frame work. matchedFrameFloorMs decides when a
// median "sits on the floor" so a caller can surface the sample spread beside it (frame-floor.md).

test("frameFloorsMs: chrome built-in headless is the single synthetic-60Hz floor", () => {
  assert.deepEqual(frameFloorsMs({ headless: true }), [CHROME_HEADLESS_FRAME_FLOOR_MS]);
});

test("frameFloorsMs: firefox headless is the single 120Hz floor", () => {
  assert.deepEqual(frameFloorsMs({ headless: true, browser: "firefox" }), [FIREFOX_FRAME_FLOOR_MS]);
});

test("frameFloorsMs: headed declares no deterministic floor", () => {
  // Headed flaps 120/60Hz run to run, so no floor can be claimed.
  assert.deepEqual(frameFloorsMs({ headless: false }), []);
});

test("matchedFrameFloorMs: a median at a cadence boundary matches that floor", () => {
  const chrome = { headless: true };
  assert.equal(matchedFrameFloorMs(16.6, chrome), CHROME_HEADLESS_FRAME_FLOOR_MS);
  assert.equal(matchedFrameFloorMs(16.7, chrome), CHROME_HEADLESS_FRAME_FLOOR_MS);
  const firefox = { headless: true, browser: "firefox" };
  assert.equal(matchedFrameFloorMs(8.0, firefox), FIREFOX_FRAME_FLOOR_MS);
});

test("matchedFrameFloorMs: real work above or below the frame is not floored", () => {
  const chrome = { headless: true };
  // 18.1ms reads through linearly (frame-floor.md), so it sits outside the band.
  assert.equal(matchedFrameFloorMs(18.1, chrome), null);
  // A clearly sub-frame 2ms median is real work that escaped the floor, not the floor itself.
  assert.equal(matchedFrameFloorMs(2, chrome), null);
  // Firefox's 8.3 floor is not chrome's floor: an 8.3 chrome median is real sub-frame work.
  assert.equal(matchedFrameFloorMs(8.3, chrome), null);
});

test("matchedFrameFloorMs: null/headed/unmeasured never match", () => {
  const chrome = { headless: true };
  assert.equal(matchedFrameFloorMs(null, chrome), null);
  assert.equal(matchedFrameFloorMs(undefined, chrome), null);
  assert.equal(matchedFrameFloorMs(16.6, { headless: false }), null);
});
