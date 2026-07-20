import { test } from "node:test";
import assert from "node:assert/strict";
import {
  frameFloorsMs,
  matchedFrameFloorMs,
  SHELL_FRAME_FLOOR_MS,
  NEW_HEADLESS_FRAME_FLOOR_MS,
} from "../../dist/model/frame-floor.js";

// The one-frame floor that pins wall/INP on sub-frame work. matchedFrameFloorMs decides when a
// median "sits on the floor" so a caller can surface the sample spread beside it (frame-floor.md).

test("frameFloorsMs: chrome shell (default headless) carries both cadence candidates", () => {
  // Shell is 120Hz here but unverified on a 60Hz display, so both boundaries are candidates.
  assert.deepEqual(frameFloorsMs({ headless: true, headlessMode: "shell" }), [
    SHELL_FRAME_FLOOR_MS,
    NEW_HEADLESS_FRAME_FLOOR_MS,
  ]);
  // headlessMode absent (older recording) is treated as the shell default.
  assert.deepEqual(frameFloorsMs({ headless: true }), [
    SHELL_FRAME_FLOOR_MS,
    NEW_HEADLESS_FRAME_FLOOR_MS,
  ]);
});

test("frameFloorsMs: chrome new-headless is the single 60Hz floor", () => {
  assert.deepEqual(frameFloorsMs({ headless: true, headlessMode: "new" }), [
    NEW_HEADLESS_FRAME_FLOOR_MS,
  ]);
});

test("frameFloorsMs: firefox is 120Hz", () => {
  assert.deepEqual(frameFloorsMs({ headless: true, browser: "firefox" }), [SHELL_FRAME_FLOOR_MS]);
});

test("frameFloorsMs: headed declares no deterministic floor", () => {
  // Headed flaps 120/60Hz run to run, so no floor can be claimed.
  assert.deepEqual(frameFloorsMs({ headless: false }), []);
});

test("matchedFrameFloorMs: a median at a cadence boundary matches that floor", () => {
  const newHeadless = { headless: true, headlessMode: "new" };
  assert.equal(matchedFrameFloorMs(16.6, newHeadless), NEW_HEADLESS_FRAME_FLOOR_MS);
  assert.equal(matchedFrameFloorMs(16.7, newHeadless), NEW_HEADLESS_FRAME_FLOOR_MS);
  const firefox = { headless: true, browser: "firefox" };
  assert.equal(matchedFrameFloorMs(8.0, firefox), SHELL_FRAME_FLOOR_MS);
});

test("matchedFrameFloorMs: shell matches either 8.3 or 16.6", () => {
  const shell = { headless: true, headlessMode: "shell" };
  assert.equal(matchedFrameFloorMs(8.3, shell), SHELL_FRAME_FLOOR_MS);
  assert.equal(matchedFrameFloorMs(16.6, shell), NEW_HEADLESS_FRAME_FLOOR_MS);
});

test("matchedFrameFloorMs: real work above the frame is not floored", () => {
  const shell = { headless: true, headlessMode: "shell" };
  // 18.1ms reads through linearly (frame-floor.md), so it sits outside both bands.
  assert.equal(matchedFrameFloorMs(18.1, shell), null);
  // A clearly sub-frame 2ms median is real work that escaped the floor, not the floor itself.
  assert.equal(matchedFrameFloorMs(2, shell), null);
  // The gap between the two candidate frames is not floored.
  assert.equal(matchedFrameFloorMs(12, shell), null);
});

test("matchedFrameFloorMs: null/headed/unmeasured never match", () => {
  const shell = { headless: true, headlessMode: "shell" };
  assert.equal(matchedFrameFloorMs(null, shell), null);
  assert.equal(matchedFrameFloorMs(undefined, shell), null);
  assert.equal(matchedFrameFloorMs(16.6, { headless: false }), null);
});
