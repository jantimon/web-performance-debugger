import type { NormalizedEvent } from "../model/recording.js";
import { RUN_START_MARK } from "../model/marks.js";

/**
 * A marker thread carrying LESS than this share of the busiest thread's in-window rendering is a
 * pre-navigation husk (a stray flush on the blank host before the page swapped process), not a
 * co-rendering top page, so the selection re-anchors to the page's new process. Above it, the marker
 * is a live top page whose OOPIF happens to render more, and it keeps the attribution (the OOPIF's
 * own-process counts are a separate off-thread count, never stolen). A blank-host stray is one or two
 * flushes against a real page's dozens-to-thousands, well under this floor; a real top page renders a
 * substantial fraction of the total.
 */
const REANCHOR_MAX_MARKER_SHARE = 0.05;

/** The renderer main thread the counts and the breakdown bar share, plus how it was chosen. */
export interface MainThreadSelection {
  pid: number;
  tid: number;
  /**
   * - `marker` when `wpd:run:start` (the mark the page makes on its own main thread) named the thread
   *   AND that thread stayed the one doing the window's rendering work.
   * - `reanchored` when the marker thread did no (or a vanishing share of the) window's rendering
   *   because the page navigated to a NEW renderer process: a top-level cross-process navigation (a
   *   `--url` boot navigates the blank host page to the target on a new process; a driver step's
   *   `page.goto` does the same) leaves `wpd:run:start` on the pre-navigation renderer. The counts and
   *   the bar must follow the page to its new process, so the selection re-anchors to the thread that
   *   carried the work.
   * - `heuristic` when the marker was missing entirely and the busiest layout/paint thread stood in.
   */
  via: "marker" | "reanchored" | "heuristic";
  /**
   * True when a substantial share of the window's layout/paint landed on a renderer thread whose
   * activity is DISJOINT in time from the selected one: the run crossed into more than one renderer
   * process one after another (successive cross-process navigations), so no single main thread holds
   * the whole run. The counts and bar describe only the selected (busiest) thread; a span whose window
   * ran in a different process cannot be tiled from it. A same-page OOPIF renders CONCURRENTLY with the
   * selected thread (its activity overlaps), so it is not a split -- its own-process counts are a
   * separate off-thread count, never the reason to warn.
   */
  split: boolean;
}

/**
 * Pick the renderer main thread `pid`/`tid` the counts and the breakdown bar share.
 *
 * The marker path names the page's own main thread. The re-anchor separates a top-level cross-process
 * NAVIGATION from an out-of-process IFRAME by the marker thread's SHARE of the window's rendering: a
 * navigated-away marker thread did none of it (or a stray flush or two on the blank host before the
 * swap), while an OOPIF's parent renders its own top page and keeps a substantial share, so it stays
 * selected and the OOPIF never steals the attribution -- its own-process counts are a separate
 * off-thread count. The share (not a strict zero) is what admits a common driver shape: a step that
 * touches the page (one forced layout on the blank host) before navigating leaves a stray count on the
 * pre-nav thread, and a strict zero test reads that as "no swap", anchoring the whole run to the husk
 * and reporting the navigated page's work as ~100% idle. The residual edge the share test cannot split:
 * a near-empty top page (a thin frame wrapper) that renders under the floor while a heavy cross-origin
 * OOPIF renders the rest looks like a swap and re-anchors to the iframe; rare, and it still lands on a
 * real rendering thread, never a fake zero.
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
export function mainThread(events: NormalizedEvent[]): MainThreadSelection | null {
  const start = events.find((event) => event.name === RUN_START_MARK);
  // Count layout/paint per thread, restricted to the run window (start-onward from the marker) so a
  // pre-navigation blank-page flush on the marker thread does not mask the process swap. With no
  // marker there is no window bound, so every layout/paint event is admitted (the legacy heuristic).
  const windowStart = start?.ts ?? null;
  const activity = new Map<
    string,
    { pid: number; tid: number; count: number; firstTs: number; lastTs: number }
  >();
  for (const event of events) {
    if (event.pid == null || event.tid == null) continue;
    if (event.kind !== "layout" && event.kind !== "paint") continue;
    if (windowStart != null && event.ts < windowStart) continue;
    const key = `${event.pid}/${event.tid}`;
    const entry = activity.get(key) ?? {
      pid: event.pid,
      tid: event.tid,
      count: 0,
      firstTs: event.ts,
      lastTs: event.ts,
    };
    entry.count++;
    if (event.ts < entry.firstTs) entry.firstTs = event.ts;
    if (event.ts > entry.lastTs) entry.lastTs = event.ts;
    activity.set(key, entry);
  }
  let busiest: { pid: number; tid: number; count: number; firstTs: number; lastTs: number } | null =
    null;
  for (const entry of activity.values())
    if (!busiest || entry.count > busiest.count) busiest = entry;

  // The run spanned more than one renderer process one after another (successive cross-process
  // navigations) when another thread carries a substantial share of the window's rendering AND its
  // activity is disjoint in time from the selected thread's. Disjoint separates a second navigation
  // (its window follows or precedes the selected thread's) from a same-page OOPIF (concurrent, its
  // window overlaps), so the selected thread genuinely cannot represent the whole run -- record()
  // turns this into a loud note rather than silently tiling the other process's window as idle.
  const heavyThreshold = busiest ? Math.max(3, busiest.count * 0.25) : 0;
  const busiestRange = busiest;
  const split =
    busiestRange != null &&
    [...activity.values()].some(
      (entry) =>
        entry !== busiestRange &&
        entry.count >= heavyThreshold &&
        (entry.lastTs < busiestRange.firstTs || entry.firstTs > busiestRange.lastTs),
    );

  if (start?.pid != null && start.tid != null) {
    const markerCount = activity.get(`${start.pid}/${start.tid}`)?.count ?? 0;
    // The marker thread did none of the window's rendering, or only a vanishing share of it (a stray
    // pre-nav flush on the blank host), while the busiest thread carried the rest: the page navigated
    // to a new renderer process. Re-anchor to the thread that carried the work.
    const swappedAway =
      busiest != null &&
      busiest.count > 0 &&
      (busiest.pid !== start.pid || busiest.tid !== start.tid) &&
      markerCount < busiest.count * REANCHOR_MAX_MARKER_SHARE;
    if (swappedAway) return { pid: busiest!.pid, tid: busiest!.tid, via: "reanchored", split };
    // The marker thread stayed the top page (single process, or a same-page OOPIF whose counts are
    // top-process scoped by design): not a cross-process split, whatever a concurrent OOPIF's share.
    return { pid: start.pid, tid: start.tid, via: "marker", split: false };
  }
  return busiest ? { pid: busiest.pid, tid: busiest.tid, via: "heuristic", split } : null;
}
