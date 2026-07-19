import type { NormalizedEvent } from "../model/recording.js";
import { RUN_START_MARK } from "../model/marks.js";

/**
 * The renderer main thread's pid/tid, plus how it was picked:
 * - `marker` when `wpd:run:start` (the mark the page makes on its own main thread) named the thread
 *   AND that thread carried the window's rendering work.
 * - `reanchored` when the marker named a thread that did NONE of the window's layout/paint but another
 *   thread did: a top-level cross-process navigation (a `--url` boot navigates the blank host page to
 *   the target on a NEW renderer process) leaves `wpd:run:start` on the pre-navigation renderer, whose
 *   main thread then does no rendering. The counts and the bar must follow the page to its new process,
 *   so the selection re-anchors to the thread that carried the work.
 * - `heuristic` when the marker was missing entirely and the busiest layout/paint thread stood in.
 * - null when no candidate thread exists at all.
 *
 * The re-anchor fires ONLY when the marker thread carries zero in-window rendering work, which is what
 * separates a process swap from an out-of-process iframe: an OOPIF runs its own layout on its own
 * thread while the marker (top) thread keeps doing the top page's work, so the marker thread's count
 * stays > 0 and it wins -- the OOPIF never steals the attribution. A single-process recording (the
 * marker thread did all the work) always resolves to `marker`, unchanged.
 *
 * Only the --breakdown/--deep captures keep pid/tid, so every other mode yields null here and its
 * consumers count the single thread they were given.
 *
 * buildSummary scopes every trace-derived count (layout/style AND paint/forced/invalidation/
 * long-task/total) to the thread this selector returns, and the breakdown bar (trace/breakdown.ts)
 * tiles that same thread. The run selects here from its own event log; a per-step summary is handed
 * the run's selection (buildRecordingSpans) rather than re-running this heuristic on a step window
 * with no run:start marker, so a step's counts sit on the same thread as the bar it sits under.
 */
export function mainThread(
  events: NormalizedEvent[],
): { pid: number; tid: number; via: "marker" | "reanchored" | "heuristic" } | null {
  const start = events.find((event) => event.name === RUN_START_MARK);
  // Count layout/paint per thread, restricted to the run window (start-onward from the marker) so a
  // pre-navigation blank-page flush on the marker thread does not mask the process swap. With no
  // marker there is no window bound, so every layout/paint event is admitted (the legacy heuristic).
  const windowStart = start?.ts ?? null;
  const activity = new Map<string, { pid: number; tid: number; count: number }>();
  for (const event of events) {
    if (event.pid == null || event.tid == null) continue;
    if (event.kind !== "layout" && event.kind !== "paint") continue;
    if (windowStart != null && event.ts < windowStart) continue;
    const key = `${event.pid}/${event.tid}`;
    const entry = activity.get(key) ?? { pid: event.pid, tid: event.tid, count: 0 };
    entry.count++;
    activity.set(key, entry);
  }
  let busiest: { pid: number; tid: number; count: number } | null = null;
  for (const entry of activity.values())
    if (!busiest || entry.count > busiest.count) busiest = entry;

  if (start?.pid != null && start.tid != null) {
    const markerCount = activity.get(`${start.pid}/${start.tid}`)?.count ?? 0;
    // The marker thread did none of the window's rendering work, but another thread did: the page
    // navigated to a new renderer process. Re-anchor to the thread that carried the work.
    if (
      markerCount === 0 &&
      busiest != null &&
      busiest.count > 0 &&
      (busiest.pid !== start.pid || busiest.tid !== start.tid)
    )
      return { pid: busiest.pid, tid: busiest.tid, via: "reanchored" };
    return { pid: start.pid, tid: start.tid, via: "marker" };
  }
  return busiest ? { pid: busiest.pid, tid: busiest.tid, via: "heuristic" } : null;
}
