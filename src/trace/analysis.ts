import type { InvalidationRecord, NormalizedEvent } from "../model/recording.js";
import { usToMs, msToUs } from "../model/time.js";
import { invalidationKind } from "./classify.js";

export const LONG_TASK_MS = 50;

// Window membership is start-onward by design: in-page paints land asynchronously
// AFTER the run:end mark (during the settle flush), so a hard upper bound would drop
// them. Post-run pollution (cleanup/teardown) is instead kept out of the traced region
// entirely (see harness phases / driver cleanup deferral).
export const inWindow = (event: NormalizedEvent, start: number | null) =>
  start == null || event.ts >= start;

/**
 * Mark layout/style events that were forced synchronously by JS. The browser only
 * attaches a JS stack to a Layout/RecalcStyle when script triggered it mid-task
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

export interface LongTask {
  id: number;
  ts: number;
  durMs: number;
  dominantKind?: string;
  dominantMs?: number;
  at?: string;
}

/** Tasks at/over `thresholdMs`, each with its dominant child work kind + source. */
export function longTasks(
  events: NormalizedEvent[],
  start: number | null,
  thresholdMs = LONG_TASK_MS,
): LongTask[] {
  const thresholdUs = msToUs(thresholdMs);
  const tasks = events.filter(
    (event) => event.kind === "task" && event.dur >= thresholdUs && inWindow(event, start),
  );
  return tasks
    .map((task) => {
      const end = task.ts + task.dur;
      const byKind = new Map<string, number>();
      // Blame the source by summed duration, matching dominantKind: a frequent-but-cheap site
      // should not outrank the one expensive layout/script that actually dominated the task.
      const atDurations = new Map<string, number>();
      for (const event of events) {
        if (event === task || event.kind === "task" || event.ts < task.ts || event.ts > end)
          continue;
        byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + event.dur);
        if (event.at) atDurations.set(event.at, (atDurations.get(event.at) ?? 0) + event.dur);
      }
      let dominantKind: string | undefined;
      let dominantUs = 0;
      for (const [kind, durationUs] of byKind) {
        if (durationUs > dominantUs) {
          dominantUs = durationUs;
          dominantKind = kind;
        }
      }
      let at: string | undefined;
      let atMaxUs = 0;
      for (const [location, durationUs] of atDurations) {
        if (durationUs > atMaxUs) {
          atMaxUs = durationUs;
          at = location;
        }
      }
      return {
        id: task.id,
        ts: task.ts,
        durMs: usToMs(task.dur),
        dominantKind,
        dominantMs: usToMs(dominantUs),
        at,
      };
    })
    .sort((left, right) => right.durMs - left.durMs);
}

/** Flatten invalidation events (with reasons) for a window; derived, not stored. */
export function extractInvalidations(
  events: NormalizedEvent[],
  start: number | null,
): InvalidationRecord[] {
  const out: InvalidationRecord[] = [];
  for (const event of events) {
    if (event.kind !== "invalidation" || !inWindow(event, start)) continue;
    const data = (event.args as any)?.data ?? {};
    out.push({
      kind: invalidationKind(event.name),
      name: event.name,
      ts: event.ts,
      reason: data.reason,
      nodeName: data.nodeName,
      at: event.at,
    });
  }
  return out;
}
