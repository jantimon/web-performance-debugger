import type { RecordingMeta } from "./recording.js";

/**
 * The one-frame floor (ms) a headless lane's `wall`/`INP` cannot report under. wall/INP end at a
 * paint, and a paint lands on a frame boundary, so any interval shorter than one frame reads as one
 * frame; sub-frame work collapses onto the floor (docs/dev/frame-floor.md). Chrome's built-in headless
 * sits on Chromium's synthetic ~60Hz BeginFrame default (16.6ms) when no display drives it (CI, an
 * idle panel). Firefox tracks the host display refresh, so on the idle-panel / display-less hosts wpd
 * runs on (CI, an un-driven dev panel) it sits on the same ~16.6ms floor as Chrome; the 8.3ms / 120Hz
 * reading is display-contingent, produced only by a live 120Hz panel, so it is not the floor to stamp.
 */
export const CHROME_HEADLESS_FRAME_FLOOR_MS = 16.6;
export const FIREFOX_FRAME_FLOOR_MS = 16.6;

/** How far a value may sit from a cadence boundary (n frames) and still count as "on the floor": the
 * +0.1ms the floor adds, Firefox's whole-ms coarseness, and a little rAF jitter. Work a full frame
 * above the boundary (18 -> 18.1) reads through linearly, so it stays outside this band. */
const FRAME_FLOOR_TOLERANCE_MS = 1.2;

/**
 * The highest multiple of the one-frame floor a wall/INP is checked against. n=1 is a sub-frame
 * measure/INP; n=2 covers a two-frame wall (e.g. a span that waits an extra vsync, the 33.2ms case);
 * up to 4 (~66ms at 60Hz). Past 4 a wall is long enough that its own work signal, not the frame
 * count, is the story, and a 1.2ms band around an exact multiple is more coincidence than signal.
 */
export const MAX_FRAME_FLOOR_MULTIPLE = 4;

/** The share of a value that must be waiting (idle for a wall, presentation delay for an INP) before a
 * multi-frame value (n>=2) is read as frame-dominated rather than real work near n frames. Reuses the
 * idle-dominant threshold the wall report already leans on, so a busy 33ms wall (real work, ~9% idle)
 * is never mislabeled a two-frame floor. */
export const FRAME_FLOOR_WAIT_SHARE = 0.8;

/** A wall/INP value that pins to a whole number of frames: the one-frame floor it sits on and which
 * multiple. `multiple` 1 = one frame, 2 = two frames, up to MAX_FRAME_FLOOR_MULTIPLE. */
export interface FrameFloorMatch {
  floorMs: number;
  multiple: number;
}

type FloorMeta = Pick<RecordingMeta, "headless" | "browser">;

/**
 * The candidate one-frame floors for a lane. Empty when no deterministic floor applies: headed Chrome
 * flaps 120/60Hz run to run (frame-floor.md), so it declares none. Both headless Chrome and headless
 * Firefox sit on the single synthetic-60Hz / display-tracked ~16.6ms floor in wpd's environments.
 */
export function frameFloorsMs(meta: FloorMeta): number[] {
  if (meta.headless === false) return [];
  if (meta.browser === "firefox") return [FIREFOX_FRAME_FLOOR_MS];
  return [CHROME_HEADLESS_FRAME_FLOOR_MS];
}

/**
 * The one-frame floor and multiple a wall/INP value pins to (within tolerance of n frames, n up to
 * MAX_FRAME_FLOOR_MULTIPLE), or null when the value is real sub-frame-or-above work (or the lane
 * declares no floor). A value near n frames with n>=2 is as frame-dominated as a one-frame measure and
 * equally hides sub-frame work, so it earns the same surfacing. The CALLER additionally gates an
 * elevated multiple on the window's wait signal (see `frameFloorDominates`), so a busy multi-frame
 * wall (real work) is not claimed as a floor.
 */
export function matchedFrameFloor(
  ms: number | null | undefined,
  meta: FloorMeta,
): FrameFloorMatch | null {
  if (ms == null) return null;
  for (const floor of frameFloorsMs(meta))
    for (let multiple = 1; multiple <= MAX_FRAME_FLOOR_MULTIPLE; multiple++)
      if (Math.abs(ms - floor * multiple) <= FRAME_FLOOR_TOLERANCE_MS)
        return { floorMs: floor, multiple };
  return null;
}

/**
 * Whether a value that matched n frames is frame-DOMINATED (worth annotating as a floor) given the
 * share of it spent waiting. n=1 needs no evidence: a latency cannot beat one frame, so a one-frame
 * value IS the floor whatever it did. n>=2 fires only when the window is wait-dominated
 * (`waitShare >= FRAME_FLOOR_WAIT_SHARE`), so a genuinely busy two-frame wall (real work near 33ms) is
 * not mislabeled. `waitShare` null (no breakdown/interaction split to judge) declines an elevated
 * multiple rather than claim one it cannot justify.
 */
export function frameFloorDominates(match: FrameFloorMatch, waitShare: number | null): boolean {
  if (match.multiple === 1) return true;
  return waitShare != null && waitShare >= FRAME_FLOOR_WAIT_SHARE;
}
