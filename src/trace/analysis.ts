import type { NormalizedEvent } from "../model/recording.js";
import { usToMs } from "../model/time.js";

export const LONG_TASK_MS = 50;

/**
 * Window membership is start-onward by design: in-page paints land asynchronously
 * AFTER the run:end mark (during the settle flush), so a hard upper bound would drop
 * them. Post-run pollution (cleanup/teardown) is instead kept out of the traced region
 * entirely (see harness phases / driver cleanup deferral)
 */
export const inWindow = (event: NormalizedEvent, start: number | null) =>
  start == null || event.ts >= start;

/**
 * Mark layout/style events that were forced synchronously by JS. The browser only
 * attaches a JS stack to a Layout/UpdateLayoutTree when script triggered it mid-task
 * (reading offsetTop etc.); natural frame-boundary layout has no stack. So:
 * layout/style kind + a resolvable user stack = forced
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
  /**
   * Id of the widest (max-duration) flush at this line, the representative for the blame -> `query
   * get` drill. Absent when no flush here carries a real, addressable id: the chrome `--breakdown`
   * sampled read-site log synthesizes every event with id 0, so those rows carry no id (never a fake
   * one). See representativeEventId
   */
  eventId?: number;
}

/**
 * The representative event id for a set of same-line flushes: the id of the WIDEST (max-duration)
 * flush, so `query get <id>` drills the biggest flush the row aggregates -- the same representative
 * `scopeByReadSite` picks for the row's scope. Returns undefined when no flush carries a real,
 * addressable id.
 *
 * A chrome `--breakdown` sampled blame event is synthesized with id 0 (trace/sampled-blame.ts) and is
 * not addressable by `query get`, so such an event is never eligible to be the representative and a
 * row of only-sampled events yields no id. Every trace-parsed (chrome --deep) or gecko-reassigned
 * (firefox) event carries a real ts-order id, including firefox's own sampled read-site events, whose
 * ids are reassigned; only the synthesized id-0 case is excluded
 */
export function representativeEventId(events: NormalizedEvent[]): number | undefined {
  let widest: NormalizedEvent | undefined;
  for (const event of events) {
    if (event.sampled && event.id === 0) continue;
    if (widest == null || event.dur > widest.dur) widest = event;
  }
  return widest?.id;
}

/** Forced (synchronous) layout/style grouped by source location */
export function forcedLayouts(events: NormalizedEvent[], start: number | null): ForcedGroup[] {
  const groups = new Map<string, { at: string; events: NormalizedEvent[] }>();
  for (const event of events) {
    if (!event.forced || !event.at || !inWindow(event, start)) continue;
    const group = groups.get(event.at) ?? { at: event.at, events: [] };
    group.events.push(event);
    groups.set(event.at, group);
  }
  return [...groups.values()]
    .map((group) => {
      const eventId = representativeEventId(group.events);
      return {
        at: group.at,
        count: group.events.length,
        durMs: group.events.reduce((total, event) => total + usToMs(event.dur), 0),
        ...(eventId != null ? { eventId } : {}),
      };
    })
    .sort((left, right) => right.durMs - left.durMs);
}
