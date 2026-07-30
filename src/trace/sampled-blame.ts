/**
 * Sampled read-site forced-layout blame for the chrome `--breakdown` capture.
 *
 * The light `--breakdown` trace drops `.stack`, so its Layout/UpdateLayoutTree events carry no JS
 * stack and `markForced` cannot name the read that forced a flush. But the fused `v8.cpu_profiler`
 * sample stream keeps sampling THROUGH a synchronous forced layout, and each sample carries its
 * leaf frame's EXECUTING line (`data.lines`, 1-based, trace-stack convention). Joining a main-thread
 * layout/style event's window against those samples recovers the forcing read line, the SAME
 * flush-site semantic the firefox lane samples (docs/dev/blame-semantics.md), as a sampled estimate.
 *
 * [measured] Chrome 150: for a flush wider than one sampler interval the executing line is exact, no
 * lag (471 HIT / 2 off-by-one / 0 wrong, and 458/0/0, on a multi-line synthetic probe); for a flush
 * NARROWER than the interval recall is ~duration/interval (18% at <0.05ms) and the one-statement lag /
 * occasional wrong-adjacent-line the firefox lane documents appear, so a sub-interval attribution is
 * marked low-confidence. Forced COUNTS still need `.stack` (`--deep`): a sampled event is
 * `sampled: true` so `summarize` never counts it as a flush.
 *
 * A minified bundle joins whole modules onto one generated line, so the executing line alone is
 * column-less and ambiguous (it maps thousands of original positions). The blame frame therefore also
 * carries the leaf FUNCTION's callFrame line+column (a real column, the same frame the CPU model
 * resolves); when the executing line cannot be disambiguated the resolver retries there, so the read
 * names the forcing function at line granularity instead of a bundle line (`app.jsx:8`, not
 * `dist/app.js:9`).
 */

import type { NormalizedEvent } from "../model/recording.js";
import { isToolFrameUrl } from "./stacks.js";
import { inWindow } from "./analysis.js";

/** The assembled `--breakdown` sample stream the join reads, all parallel arrays ascending by time. */
export interface CpuSampleStream {
  /** leaf-frame served url per sample node id (from the assembled profile's `nodes[].callFrame.url`) */
  urlByNode: Map<number, string>;
  /** leaf-frame callFrame line+column per sample node id (0-based CDP convention, as the assembled
   * profile stores them), the column-bearing fallback the resolver uses when the executing line cannot
   * be disambiguated. Absent (older assembler) leaves the sampled read with no fallback. */
  frameByNode?: Map<number, { line: number; column: number }>;
  /** node id per sample, parallel to `timestampsUs`/`lines` (ascending by timestamp) */
  samples: number[];
  /** absolute trace-clock timestamp (us) per sample */
  timestampsUs: number[];
  /** per-sample executing line (1-based); a value <= 0 means no line was recorded for that sample */
  lines: number[];
  /** per-sample owning thread (pid/tid), parallel to `samples`. A merged stream interleaves every
   * renderer/worker/OOPIF isolate, so a flush is blamed only on a same-thread sample; absent (older
   * assembler) disables the thread guard and keeps the timestamp-only join. */
  threads?: { pid: number; tid: number }[];
  /** the interval the stream ran at (us); a flush narrower than this is low-confidence */
  intervalUs: number;
}

/**
 * Derive sampled read-site forced-layout blame events from the light-trace layout/style events + the
 * CPU sample stream. One event per flush that has an in-window sample resolving to a user source line;
 * a flush with no such sample yields nothing (the cheap-read miss the firefox lane also has). Pure and
 * order-independent over `events`; the caller runs `attachStacks` + `markForced` on the result so the
 * frame resolves to local source and the event reads `forced` like any read-site blame.
 */
export function sampledForcedBlameEvents(
  events: NormalizedEvent[],
  stream: CpuSampleStream,
  windowStart: number | null,
  thread: { pid: number; tid: number } | null,
): NormalizedEvent[] {
  const { samples, timestampsUs, lines, threads, urlByNode, frameByNode, intervalUs } = stream;
  if (lines.length === 0 || samples.length === 0) return [];

  // The layout/style flushes to blame, main-thread windowed and in ts order so the sample pointer
  // below only moves forward (a nested flush starts no earlier than its parent).
  const flushes = events
    .filter(
      (event) =>
        (event.kind === "layout" || event.kind === "style") &&
        !event.sampled &&
        inWindow(event, windowStart) &&
        (thread == null || (event.pid === thread.pid && event.tid === thread.tid)),
    )
    .sort((left, right) => left.ts - right.ts);

  const out: NormalizedEvent[] = [];
  // First sample whose timestamp could fall in the current (ascending-start) flush window.
  let lower = 0;
  for (const flush of flushes) {
    const windowEndUs = flush.ts + flush.dur;
    while (lower < timestampsUs.length && timestampsUs[lower] < flush.ts) lower++;
    let picked: {
      url: string;
      line: number;
      fallback?: { line: number; column: number };
    } | null = null;
    for (
      let index = lower;
      index < timestampsUs.length && timestampsUs[index] <= windowEndUs;
      index++
    ) {
      const line = lines[index];
      if (line == null || line <= 0) continue;
      // The merged stream interleaves every isolate; a flush on the main thread must be blamed only on a
      // sample that ran on THAT thread. A worker/OOPIF/other-renderer sample can share the flush's
      // timestamp window but names an unrelated source line, so skip it. No `thread` filter (thread ==
      // null) leaves the flush unrestricted, so the per-sample thread guard only ever narrows.
      if (thread != null && threads != null) {
        const owner = threads[index];
        if (!owner || owner.pid !== thread.pid || owner.tid !== thread.tid) continue;
      }
      const url = urlByNode.get(samples[index]) ?? "";
      // A native accessor node (empty url) or a tool/harness frame is not the read site; keep scanning.
      if (!url || isToolFrameUrl(url)) continue;
      // The leaf function's own callFrame position (0-based CDP): the column-bearing fallback the
      // resolver retries at when the executing line is unresolvable on a minified bundle. +1 to the
      // 1-based trace-stack convention resolveFrame expects; skip a positionless (-1) frame.
      const nodeFrame = frameByNode?.get(samples[index]);
      const fallback =
        nodeFrame && nodeFrame.line >= 0
          ? { line: nodeFrame.line + 1, column: nodeFrame.column + 1 }
          : undefined;
      picked = { url, line, fallback };
      break;
    }
    if (!picked) continue;
    out.push({
      id: 0,
      name: flush.kind === "style" ? "RecalcStyles" : "Layout",
      ts: flush.ts,
      dur: flush.dur,
      ph: "X",
      kind: flush.kind,
      // A sampled annotation, not a measured flush: summarize skips it so it never inflates a count.
      sampled: true,
      args: {
        data: {
          // extractStack reads `stackTrace[].url`/`lineNumber`; attachStacks maps it to local source.
          // `lineOnly`: a sample carries an executing LINE but no column, so the resolver must not map
          // it through generated column 0 (a wrong original line on a minified single-line bundle); it
          // maps only when the generated line is unambiguous. `fallbackLine`/`fallbackColumn` name the
          // leaf function's column-bearing position, which the resolver retries at (the same frame the
          // CPU model resolves) so a minified-bundle read still names the forcing function, not a
          // bundle line.
          stackTrace: [
            {
              url: picked.url,
              lineNumber: picked.line,
              lineOnly: true,
              ...(picked.fallback
                ? { fallbackLine: picked.fallback.line, fallbackColumn: picked.fallback.column }
                : {}),
            },
          ],
          // A flush narrower than one sampler interval may catch an adjacent line or none, so flag it.
          ...(flush.dur < intervalUs ? { lowConfidence: true } : {}),
        },
      },
    });
  }
  return out;
}
