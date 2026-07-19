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
 * `ts` order (measured against `examples/forces-layout.mjs`, docs/dev/engine-mapping.md, probe G):
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
 * genuine mutation stack (`Inline CSS ... mutated`, `Node was inserted...`). The layout-kind
 * `LayoutInvalidationTracking` stack is deliberately NOT used: on a style-driven invalidation its
 * stack names the forcing READ, not the write, so trusting it would mis-label the write as the read.
 */

/** N: a run at/over this many thrash steps earns the "layout thrashed Nx" headline. A named constant. */
export const THRASH_HEADLINE_MIN = 3;

/** How many interleave steps the rollup keeps; the rest collapse into `omitted` (size cap). */
export const THRASH_SEQUENCE_CAP = 12;

/** The full detector result over a window: the rollup plus dirtied-by writes keyed by read-site. */
export interface ThrashAnalysis {
  report: ThrashReport;
  /** dirtied-by writes per forced read-site (source line), the dual annotation for blame/digest. */
  dirtiedByReadSite: Record<string, DirtiedByWrite[]>;
}

/** Layout or style if `event` is a layout/style invalidation write; null otherwise. */
function writeKindOf(event: NormalizedEvent): "layout" | "style" | null {
  if (event.kind !== "invalidation") return null;
  const kind = invalidationKind(event.name);
  return kind === "layout" || kind === "style" ? kind : null;
}

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
 * in-window flushes are reported, since the run window is what scopes the span.
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
        if (writeKind === "layout") gapLayoutWrites++;
        else {
          gapStyleWrites++;
          if (event.at) gapDirtiedBy.push({ at: event.at, reason: reasonOf(event) });
        }
        continue;
      }
      if ((event.kind === "layout" || event.kind === "style") && event.forced) {
        if (inWindow(event, start)) {
          const matching = event.kind === "layout" ? gapLayoutWrites : gapStyleWrites;
          annotations.push({
            kind: event.kind,
            read: event.at,
            dirtiedBy: dedupeWrites(gapDirtiedBy),
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

/** Render one thrash step as `write(at) -> read(at)`, the interleave the thrash report surfaces. */
export function renderThrashStep(step: ThrashStep): string {
  const read = `read ${step.read ?? "?"} (${step.kind})`;
  if (!step.dirtiedBy.length) return read;
  const write = step.dirtiedBy
    .map((entry) => (entry.reason ? `${entry.at} (${entry.reason})` : entry.at))
    .join(", ");
  return `write ${write} -> ${read}`;
}
