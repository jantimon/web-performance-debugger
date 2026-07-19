import type { NormalizedEvent } from "../model/recording.js";
import { RUN_START_MARK } from "../model/marks.js";

/**
 * The renderer main thread's pid/tid, plus how it was picked: `marker` when `wpd:run:start` (the
 * mark the page makes on its own main thread) named the thread, `heuristic` when that marker was
 * missing and the thread carrying the most layout/paint work stood in. A lost marker degrades to a
 * heuristic rather than to nothing; null when no candidate exists at all. Only the --breakdown
 * capture keeps pid/tid, so every other mode yields null here and its consumers count the single
 * thread they were given.
 *
 * buildSummary scopes every trace-derived count (layout/style AND paint/forced/invalidation/
 * long-task/total) to the thread this selector returns, and the breakdown bar (trace/breakdown.ts)
 * tiles that same thread. The run selects here from its own event log; a per-step summary is handed
 * the run's selection (buildRecordingSpans) rather than re-running this heuristic on a step window
 * with no run:start marker, so a step's counts sit on the same thread as the bar it sits under.
 */
export function mainThread(
  events: NormalizedEvent[],
): { pid: number; tid: number; via: "marker" | "heuristic" } | null {
  const start = events.find((event) => event.name === RUN_START_MARK);
  if (start?.pid != null && start.tid != null)
    return { pid: start.pid, tid: start.tid, via: "marker" };
  const activity = new Map<string, { pid: number; tid: number; count: number }>();
  for (const event of events) {
    if (event.pid == null || event.tid == null) continue;
    if (event.kind !== "layout" && event.kind !== "paint") continue;
    const key = `${event.pid}/${event.tid}`;
    const entry = activity.get(key) ?? { pid: event.pid, tid: event.tid, count: 0 };
    entry.count++;
    activity.set(key, entry);
  }
  let best: { pid: number; tid: number; count: number } | null = null;
  for (const entry of activity.values()) if (!best || entry.count > best.count) best = entry;
  return best ? { pid: best.pid, tid: best.tid, via: "heuristic" } : null;
}
