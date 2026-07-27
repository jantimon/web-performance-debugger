import type { NormalizedEvent } from "../model/recording.js";
import { usToMs } from "../model/time.js";

export const LONG_TASK_MS = 50;

// Window membership is start-onward by design: in-page paints land asynchronously
// AFTER the run:end mark (during the settle flush), so a hard upper bound would drop
// them. Post-run pollution (cleanup/teardown) is instead kept out of the traced region
// entirely (see harness phases / driver cleanup deferral).
export const inWindow = (event: NormalizedEvent, start: number | null) =>
  start == null || event.ts >= start;

/**
 * Mark layout/style events that were forced synchronously by JS. The browser only
 * attaches a JS stack to a Layout/UpdateLayoutTree when script triggered it mid-task
 * (reading offsetTop etc.); natural frame-boundary layout has no stack. So:
 * layout/style kind + a resolvable user stack = forced.
 */
export function markForced(events: NormalizedEvent[]): void {
  for (const event of events) {
    if ((event.kind === "layout" || event.kind === "style") && event.at) event.forced = true;
  }
}

export interface ForcedGroup {
  at: string;
  count: number;
  durMs: number;
}

/** Forced (synchronous) layout/style grouped by source location. */
export function forcedLayouts(events: NormalizedEvent[], start: number | null): ForcedGroup[] {
  const groups = new Map<string, ForcedGroup>();
  for (const event of events) {
    if (!event.forced || !event.at || !inWindow(event, start)) continue;
    const group = groups.get(event.at) ?? { at: event.at, count: 0, durMs: 0 };
    group.count++;
    group.durMs += usToMs(event.dur);
    groups.set(event.at, group);
  }
  return [...groups.values()].sort((left, right) => right.durMs - left.durMs);
}
