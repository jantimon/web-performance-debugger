import type {
  DirtiedByWrite,
  NormalizedEvent,
  ThrashReport,
  ThrashStep,
} from "../model/recording.js";
import { invalidationKind } from "./classify.js";
import { inWindow } from "./analysis.js";
import { mainThread } from "./main-thread.js";

/**
 * Layout-thrashing detector + dirtied-by annotation over a Chrome `--deep` event log.
 *
 * The signature of thrashing is write->read->write->read on one frame: each geometry read re-flushes
 * a layout an intervening write dirtied. The rule, per top-level `RunTask` window, main thread, in
 * `ts` order (measured against `examples/forces-layout.mjs`; docs/dev/engine-mapping.md):
 *
 *   - A forced flush is a `layout`/`style` event with a resolved read-site stack (`event.forced`).
 *   - A write is an `invalidation`-kind event of layout or style kind (`invalidationKind`).
 *   - A forced flush counts as a thrash step iff >= 1 write of ITS OWN kind sat in the gap since the
 *     previous flush in the same task. Matching by kind (not any layout|style write) is the
 *     semantically-correct rule: it excludes a flush that re-read clean geometry. [measured] on the
 *     probe this counts 42 of 43 forced flushes; the one it drops is the `focus()` Layout re-read,
 *     whose gap holds only a `:focus`-recalc STYLE write and no layout write -- a genuine non-thrash
 *     (relaxing to "any layout|style write" would count it, 43/43, but over-report that re-read).
 *
 * The dirtied-by write comes from the STYLE-kind invalidation records in the gap, which carry the
 * genuine mutation stack (`Inline CSS ... mutated`, `Node was inserted...`), plus exactly one
 * layout-kind case: `LayoutInvalidationTracking` with reason "Removed from layout" names the WRITE
 * (a synchronous DOM detach stamps the record at mutation time; [measured] byte-stable, and pure
 * removeChild emits no style-kind write at all, so this is its only write signal). Every other
 * layout-kind reason ("Added to layout", "Style changed") stamps at the forced recalc and names the
 * READ, so trusting those would mis-label the write as the read. docs/dev/engine-mapping.md.
 */

/** N: a run at/over this many thrash steps earns the "layout thrashed Nx" headline. A named constant. */
export const THRASH_HEADLINE_MIN = 3;

/** How many interleave steps the rollup keeps; the rest collapse into `omitted` (size cap). */
export const THRASH_SEQUENCE_CAP = 12;

/** The full detector result over a window: the rollup plus dirtied-by writes keyed by read-site. */
export interface ThrashAnalysis {
  report: ThrashReport;
  /** dirtied-by writes per forced read-site (source line), the dual annotation for blame and the span anatomy. */
  dirtiedByReadSite: Record<string, DirtiedByWrite[]>;
}

/** Layout or style if `event` is a layout/style invalidation write; null otherwise. */
function writeKindOf(event: NormalizedEvent): "layout" | "style" | null {
  if (event.kind !== "invalidation") return null;
  const kind = invalidationKind(event.name);
  return kind === "layout" || kind === "style" ? kind : null;
}

/** The one layout-kind invalidation reason whose stack names the write (a synchronous DOM detach);
 * all other layout-kind reasons stamp at the forced recalc and name the read. */
const LAYOUT_WRITE_REASON = "Removed from layout";

/** The invalidation reason string a record carried, if any. */
function reasonOf(event: NormalizedEvent): string | undefined {
  const reason = (event.args as { data?: { reason?: unknown } } | undefined)?.data?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * Top-level tasks on the (already ts-ordered) main-thread stream: a `RunTask` not fully nested inside
 * a longer one. The interleave is walked per task so "since the previous flush" never crosses a task
 * boundary. On the probe the whole interaction is one task; the rule generalizes without change.
 */
function topLevelTasks(ordered: NormalizedEvent[]): NormalizedEvent[] {
  const tasks = ordered.filter((event) => event.kind === "task");
  return tasks.filter(
    (task) =>
      !tasks.some(
        (other) =>
          other !== task &&
          other.dur > task.dur &&
          task.ts >= other.ts &&
          task.ts + task.dur <= other.ts + other.dur,
      ),
  );
}

interface FlushAnnotation {
  kind: "layout" | "style";
  read?: string;
  /** style-kind mutation writes in this flush's gap (the surfaceable write end) */
  dirtiedBy: DirtiedByWrite[];
  /** a write of the flush's OWN kind sat in the gap (the matching-kind thrash rule) */
  thrash: boolean;
}

function dedupeWrites(writes: DirtiedByWrite[]): DirtiedByWrite[] {
  const out: DirtiedByWrite[] = [];
  for (const write of writes)
    if (!out.some((kept) => kept.at === write.at && kept.reason === write.reason)) out.push(write);
  return out;
}

/**
 * Walk each top-level task and annotate every in-window forced flush with the writes in its gap. The
 * gap resets at EVERY flush (in-window or not: a flush still cleans the geometry), while only
 * in-window flushes are reported, since the run window is what scopes the span. A forced flush
 * outside any top-level task is not walked and so never counts as a thrash step; on the renderer
 * main thread every layout/style flush nests under a task, so nothing real is dropped.
 */
function annotateForcedFlushes(events: NormalizedEvent[], start: number | null): FlushAnnotation[] {
  const picked = mainThread(events);
  const main = picked
    ? events.filter((event) => event.pid === picked.pid && event.tid === picked.tid)
    : events;
  const ordered = [...main].sort((left, right) => left.ts - right.ts || left.id - right.id);
  const annotations: FlushAnnotation[] = [];
  for (const task of topLevelTasks(ordered)) {
    const taskEnd = task.ts + task.dur;
    let gapLayoutWrites = 0;
    let gapStyleWrites = 0;
    let gapDirtiedBy: DirtiedByWrite[] = [];
    for (const event of ordered) {
      if (event === task || event.ts < task.ts || event.ts > taskEnd) continue;
      const writeKind = writeKindOf(event);
      if (writeKind) {
        if (writeKind === "layout") {
          gapLayoutWrites++;
          if (event.at && reasonOf(event) === LAYOUT_WRITE_REASON)
            gapDirtiedBy.push({ at: event.at, reason: reasonOf(event) });
        } else {
          gapStyleWrites++;
          if (event.at) gapDirtiedBy.push({ at: event.at, reason: reasonOf(event) });
        }
        continue;
      }
      if ((event.kind === "layout" || event.kind === "style") && event.forced) {
        if (inWindow(event, start)) {
          const matching = event.kind === "layout" ? gapLayoutWrites : gapStyleWrites;
          // A synchronous detach cannot occupy the same source position as the read it forced, so a
          // "Removed from layout" entry whose `at` equals this flush's read-site is not a write: it
          // is the recalc-time stamp of a display:none removal, named at the read line. Drop it; a
          // genuine removeChild names a distinct write line and stays. The thrash count is read from
          // gapLayoutWrites above and untouched. See docs/dev/engine-mapping.md.
          const dirtiedBy = dedupeWrites(gapDirtiedBy).filter(
            (write) => !(write.reason === LAYOUT_WRITE_REASON && write.at === event.at),
          );
          annotations.push({
            kind: event.kind,
            read: event.at,
            dirtiedBy,
            thrash: matching >= 1,
          });
        }
        gapLayoutWrites = 0;
        gapStyleWrites = 0;
        gapDirtiedBy = [];
      }
    }
  }
  return annotations;
}

/**
 * Run the detector over a window's events. `start` is the run-window start (null = whole trace).
 * Empty result (count 0, no dirtied-by) on a log with no invalidation records, which is how every
 * non-`--deep` lane reads: not-available, never a fabricated thrash.
 */
export function analyzeThrash(
  events: NormalizedEvent[],
  start: number | null,
  cap = THRASH_SEQUENCE_CAP,
): ThrashAnalysis {
  const annotations = annotateForcedFlushes(events, start);
  const thrashSteps = annotations
    .filter((annotation) => annotation.thrash)
    .map((annotation) => ({
      kind: annotation.kind,
      read: annotation.read,
      dirtiedBy: annotation.dirtiedBy,
    }));
  const dirtiedByReadSite: Record<string, DirtiedByWrite[]> = {};
  for (const annotation of annotations) {
    if (!annotation.read || !annotation.dirtiedBy.length) continue;
    const existing = dirtiedByReadSite[annotation.read] ?? [];
    dirtiedByReadSite[annotation.read] = dedupeWrites([...existing, ...annotation.dirtiedBy]);
  }
  return {
    report: {
      count: thrashSteps.length,
      steps: thrashSteps.slice(0, cap),
      omitted: Math.max(0, thrashSteps.length - cap),
    },
    dirtiedByReadSite,
  };
}

/** Distinct writes named per rendered step; a gap dirtying more lines says "+N more". */
const WRITES_PER_STEP_CAP = 4;

/** Render one thrash step as `write(at) → read(at)`, the interleave the thrash report surfaces. */
export function renderThrashStep(step: ThrashStep): string {
  const read = `read ${step.read ?? "?"} (${step.kind})`;
  if (!step.dirtiedBy.length) return read;
  const named = step.dirtiedBy.slice(0, WRITES_PER_STEP_CAP);
  const omitted = step.dirtiedBy.length - named.length;
  const write = named
    .map((entry) => (entry.reason ? `${entry.at} (${entry.reason})` : entry.at))
    .join(", ");
  const suffix = omitted > 0 ? `, +${omitted} more` : "";
  return `write ${write}${suffix} → ${read}`;
}
