// Per-flush layout/style SCOPE: how much each flush relaid out (dirtyObjects/totalObjects, a Layout
// event) or recalculated (elementCount, an UpdateLayoutTree event). Read from the trace event's `args`,
// which ride the light --breakdown trace (only beginData.stackTrace needs the .stack category). A
// count-tier fact, aggregated as a distribution (p50/max) per span, NEVER a sum -- a thrash loop
// re-dirties the same nodes every flush. docs/dev/rendering-counts.md.

import type { FlushScope, NormalizedEvent, ScopeStats, SpanScope } from "../model/recording.js";

/** One Layout flush's scope, from `args.beginData` (+ the container root from `args.endData`). */
interface LayoutFlush {
  /** dirtyObjects: render-tree LayoutObjects relaid out (NOT DOM nodes) */
  dirty: number;
  /** totalObjects: the flush's denominator (the whole document, or a sub-tree when contained) */
  total: number;
  /** partialLayout: the flush was scoped to a sub-tree, not the whole document */
  partial: boolean;
  /** layoutRoots[0].nodeName: the container element a contained flush laid out */
  root?: string;
}

/**
 * A Layout event's scope, or undefined when the event is not a Layout flush or its trace `args` predate
 * the scope fields. Skips a sampled blame annotation (it names a read site, not a measured flush).
 */
export function readLayoutScope(event: NormalizedEvent): LayoutFlush | undefined {
  if (event.kind !== "layout" || event.sampled) return undefined;
  const begin = (
    event.args as
      | { beginData?: { dirtyObjects?: unknown; totalObjects?: unknown; partialLayout?: unknown } }
      | undefined
  )?.beginData;
  if (!begin || typeof begin.dirtyObjects !== "number" || typeof begin.totalObjects !== "number")
    return undefined;
  const end = (event.args as { endData?: { layoutRoots?: { nodeName?: unknown }[] } } | undefined)
    ?.endData;
  const root = end?.layoutRoots?.[0]?.nodeName;
  return {
    dirty: begin.dirtyObjects,
    total: begin.totalObjects,
    partial: begin.partialLayout === true,
    ...(typeof root === "string" ? { root } : {}),
  };
}

/**
 * An UpdateLayoutTree event's `elementCount` (elements recalculated), or undefined when the event is
 * not a style flush or carries no count. Reads the chrome `args.elementCount` and the firefox analog
 * `args.data.elementsStyled` (the Gecko `Styles` marker's own field), so one reader serves both lanes.
 */
export function readStyleScope(event: NormalizedEvent): number | undefined {
  if (event.kind !== "style" || event.sampled) return undefined;
  const args = event.args as
    | { elementCount?: unknown; data?: { elementsStyled?: unknown } }
    | undefined;
  if (typeof args?.elementCount === "number") return args.elementCount;
  if (typeof args?.data?.elementsStyled === "number") return args.data.elementsStyled;
  return undefined;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stats(values: number[]): ScopeStats {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: median(sorted), max: sorted[sorted.length - 1], flushes: sorted.length };
}

/**
 * The layout/style scope DISTRIBUTION over one span window's flushes: `dirtyObjects` p50/max across the
 * Layout flushes, `elementCount` p50/max across the UpdateLayoutTree flushes, and a contained-flush note
 * when any flush was subtree-scoped. Never a sum. Layout scope stays absent when the window laid out
 * nothing (chrome only); style scope stays absent when it recalculated nothing. Returns undefined when
 * the window carried no scope-bearing flush at all, so a scope-less capture stores no field.
 */
export function spanScope(events: NormalizedEvent[]): SpanScope | undefined {
  const dirtyObjects: number[] = [];
  const elementCounts: number[] = [];
  let containedFlushes = 0;
  let sampleRoot: string | undefined;
  for (const event of events) {
    const layout = readLayoutScope(event);
    if (layout) {
      dirtyObjects.push(layout.dirty);
      if (layout.partial) {
        containedFlushes++;
        if (sampleRoot == null && layout.root != null) sampleRoot = layout.root;
      }
    }
    const styleElements = readStyleScope(event);
    if (styleElements != null) elementCounts.push(styleElements);
  }
  const scope: SpanScope = {};
  if (dirtyObjects.length) scope.layoutObjects = stats(dirtyObjects);
  if (elementCounts.length) scope.elementsStyled = stats(elementCounts);
  if (containedFlushes > 0)
    scope.contained = { flushes: containedFlushes, ...(sampleRoot != null ? { sampleRoot } : {}) };
  return Object.keys(scope).length ? scope : undefined;
}

/**
 * Layout/style scope per forced read-site source line (chrome --deep blame). Keyed by the flush event's
 * `at`, each entry carries the WIDEST flush at that line -- the max-`dirtyObjects` Layout flush's
 * dirty/total, the max `elementCount`, and a contained-flush's container root -- so a blame row shows the
 * biggest relayout it caused. Only lines with a scope-bearing flush appear. --breakdown blame is sampled
 * (no flush args), so its rows carry no scope and this map is empty there.
 */
export function scopeByReadSite(events: NormalizedEvent[]): Map<string, FlushScope> {
  const wide = new Map<
    string,
    { layout?: LayoutFlush; elements?: number; containedRoot?: string }
  >();
  for (const event of events) {
    if (!event.at) continue;
    const layout = readLayoutScope(event);
    const styleElements = readStyleScope(event);
    if (!layout && styleElements == null) continue;
    const acc = wide.get(event.at) ?? {};
    if (layout && (acc.layout == null || layout.dirty > acc.layout.dirty)) acc.layout = layout;
    if (layout?.partial && acc.containedRoot == null && layout.root != null)
      acc.containedRoot = layout.root;
    if (styleElements != null && (acc.elements == null || styleElements > acc.elements))
      acc.elements = styleElements;
    wide.set(event.at, acc);
  }
  const out = new Map<string, FlushScope>();
  for (const [at, acc] of wide) {
    const scope: FlushScope = {};
    if (acc.layout) scope.layoutObjects = { dirty: acc.layout.dirty, total: acc.layout.total };
    if (acc.elements != null) scope.elementsStyled = acc.elements;
    if (acc.containedRoot != null) scope.containedRoot = acc.containedRoot;
    if (Object.keys(scope).length) out.set(at, scope);
  }
  return out;
}
