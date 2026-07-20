import type { RecordingMeta } from "./recording.js";

/**
 * The one-frame floor (ms) a headless lane's `wall`/`INP` cannot report under. wall/INP end at a
 * paint, and a paint lands on a frame boundary, so any interval shorter than one frame reads as one
 * frame; sub-frame work collapses onto the floor (docs/dev/frame-floor.md). The cadence is a property
 * of the headless mode: chrome-headless-shell and Firefox run ~120Hz (8.3ms), chrome new-headless
 * ~60Hz (16.6ms).
 */
export const SHELL_FRAME_FLOOR_MS = 8.3;
export const NEW_HEADLESS_FRAME_FLOOR_MS = 16.6;

/** How far a median may sit from a cadence boundary and still count as "on the floor": the +0.1ms
 * the floor adds, Firefox's whole-ms coarseness, and a little rAF jitter. Work a full frame above the
 * floor (18 -> 18.1) reads through linearly, so it stays outside this band. */
const FRAME_FLOOR_TOLERANCE_MS = 1.2;

type FloorMeta = Pick<RecordingMeta, "headless" | "headlessMode" | "browser">;

/**
 * The candidate one-frame floors for a lane. Empty when no deterministic floor applies: headed Chrome
 * flaps 120/60Hz run to run (frame-floor.md), so it declares none. Shell defaults to 120Hz here but
 * its cadence on a 60Hz display is unverified, so shell carries BOTH boundaries as candidates rather
 * than a single hardcoded 8.3 that would miss a floored median on a 60Hz host.
 */
export function frameFloorsMs(meta: FloorMeta): number[] {
  if (meta.headless === false) return [];
  if (meta.browser === "firefox") return [SHELL_FRAME_FLOOR_MS];
  if (meta.headlessMode === "new") return [NEW_HEADLESS_FRAME_FLOOR_MS];
  return [SHELL_FRAME_FLOOR_MS, NEW_HEADLESS_FRAME_FLOOR_MS];
}

/**
 * The one-frame floor a wall/INP median sits on, or null when the value is real sub-frame-or-above
 * work (or the lane declares no floor). A caller surfaces the sample spread beside a floored median so
 * the number is not read as "no difference": sub-frame work differing several fold all reports the
 * frame time.
 */
export function matchedFrameFloorMs(ms: number | null | undefined, meta: FloorMeta): number | null {
  if (ms == null) return null;
  for (const floor of frameFloorsMs(meta))
    if (Math.abs(ms - floor) <= FRAME_FLOOR_TOLERANCE_MS) return floor;
  return null;
}
