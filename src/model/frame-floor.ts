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

/**
 * The share of a window that must be idle/waiting for it to read as wait-dominated. Two surfaces share
 * it: `frameFloorDominates` labels a multi-frame value (n>=2) a frame floor only above this (idle for a
 * wall, presentation delay for an INP), so a busy 33ms wall (real work, ~9% idle) is never mislabeled a
 * two-frame floor; `idleShareSuffix` (output/ascii.ts) tags a span wall `~N% idle` at the same cutoff.
 * [measured, docs/dev/frame-floor.md] on a 33ms two-frame wall 0.8 is 6.6ms of real work: a span with
 * 1.2ms of work (idle 0.96) is labeled a floor, one with 8.6ms (idle 0.74) keeps its real-work reading,
 * so the cutoff errs toward NOT claiming a floor and there is no realistic mislabel band.
 */
export const IDLE_DOMINANT_SHARE = 0.8;

/**
 * A wall/INP pinned to a whole number of frames because its VALUE lands within tolerance of n*floor.
 * The correct detector for a bench/in-page/measure wall and for INP, none of which carry a driver
 * input-dispatch offset, so their value sits on the boundary. `multiple` 1 = one frame, up to
 * MAX_FRAME_FLOOR_MULTIPLE.
 */
export interface WallMultipleFloor {
  basis: "wall-multiple";
  floorMs: number;
  multiple: number;
}

/**
 * A driver STEP flagged floored by its reconciling BAR rather than its wall value. A trusted
 * `page.click` carries ~8ms of input-dispatch latency inside the step window (docs/dev/driver-timing.md),
 * so a floored cheap step's wall lands off any exact n*floor (matchedFrameFloor misses it: a 41ms wall
 * sits between 2x=33.2 and 3x=49.8). The bar still proves the case: the summed real-work slices
 * (js+style+layout+paint+gc) are sub-frame and the window is idle-dominated, so the step did sub-frame
 * work and waited out the frame. `workMs` is that sub-frame work sum.
 */
export interface WorkSignalFloor {
  basis: "work-signal";
  floorMs: number;
  workMs: number;
}

/**
 * How a span's wall/INP was found to sit on the one-frame cadence floor: by its value landing on a
 * whole multiple of the floor (`wall-multiple`), or by its bar showing sub-frame work in an
 * idle-dominated window (`work-signal`, a driver step whose wall carries input dispatch). Consumers
 * narrow on `basis`.
 */
export type FrameFloor = WallMultipleFloor | WorkSignalFloor;

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
): WallMultipleFloor | null {
  if (ms == null) return null;
  for (const floor of frameFloorsMs(meta))
    for (let multiple = 1; multiple <= MAX_FRAME_FLOOR_MULTIPLE; multiple++)
      if (Math.abs(ms - floor * multiple) <= FRAME_FLOOR_TOLERANCE_MS)
        return { basis: "wall-multiple", floorMs: floor, multiple };
  return null;
}

/**
 * Whether a value that matched n frames is frame-DOMINATED (worth annotating as a floor) given the
 * share of it spent waiting. n=1 needs no evidence: a latency cannot beat one frame, so a one-frame
 * value IS the floor whatever it did. n>=2 fires only when the window is wait-dominated
 * (`waitShare >= IDLE_DOMINANT_SHARE`), so a genuinely busy two-frame wall (real work near 33ms) is
 * not mislabeled. `waitShare` null (no breakdown/interaction split to judge) declines an elevated
 * multiple rather than claim one it cannot justify.
 */
export function frameFloorDominates(match: WallMultipleFloor, waitShare: number | null): boolean {
  if (match.multiple === 1) return true;
  return waitShare != null && waitShare >= IDLE_DOMINANT_SHARE;
}

/**
 * A driver step's frame floor read off its reconciling BAR (the `work-signal` basis), or null. Fires
 * when the summed real-work slices (`workMs`) are under one frame AND the window is idle-dominated
 * (`idleShare >= IDLE_DOMINANT_SHARE`): the step did sub-frame work and waited out the frame, whatever
 * its wall landed on (a trusted-click ~8ms of input dispatch lands in the idle share, off any exact
 * n*floor, so `matchedFrameFloor` cannot see it). [measured, docs/dev/frame-floor.md] a floored cheap
 * step reads work 0.63ms / idle share 0.90 -> flagged; a busy control reads work ~26ms / idle 0.55 ->
 * rejected (work over the frame). `idleShare` null (no bar to judge) declines, as does a lane with no
 * deterministic floor (headed).
 */
export function workSignalFloor(
  meta: FloorMeta,
  workMs: number,
  idleShare: number | null,
): WorkSignalFloor | null {
  if (idleShare == null || idleShare < IDLE_DOMINANT_SHARE) return null;
  const floors = frameFloorsMs(meta);
  if (floors.length === 0) return null;
  const floorMs = floors[0];
  if (workMs >= floorMs) return null;
  return { basis: "work-signal", floorMs, workMs };
}
