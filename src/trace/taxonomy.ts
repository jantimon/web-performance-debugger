import type { EventKind } from "../model/recording.js";

/** The six non-idle work slices an event kind can land in; `idle` is the window remainder, not a
 * kind, so it is never a taxonomy row. */
export type WorkSlice = "js" | "style" | "layout" | "paint" | "gc" | "other";

/**
 * One row of the event taxonomy: everything the pipeline needs to know about an `EventKind` in one
 * place, so `classify`, `EVENT_KINDS`, the breakdown's `sliceOf`, and the summary's counters all
 * read from the SAME source instead of three drifting name lists.
 */
interface KindRow {
  /** exact trace event names that classify to this kind (matched before the category rules) */
  names: ReadonlySet<string>;
  /** which breakdown work slice this kind's self-time lands in */
  slice: WorkSlice;
  /**
   * Extra match beyond the exact-name set, evaluated at this kind's precedence position in
   * `classify` (a category substring, or the V8.GC* name prefix). Absent when exact names are the
   * only rule.
   */
  match?: (name: string, cat: string) => boolean;
}

// One declarative table, one row per EventKind. Adding a kind to the `EventKind` union makes this
// `Record` a compile error (a missing key), which is the single point that forces every derived
// consumer below to be revisited. Key order is the public EVENT_KINDS order; classify's precedence
// is a separate ordering (CLASSIFY_ORDER in classify.ts), because gc must be tested before the
// scripting v8-category fallback.
export const TAXONOMY: Record<EventKind, KindRow> = {
  layout: { names: new Set(["Layout"]), slice: "layout" },
  // The style-event names Chrome 150 emits: `UpdateLayoutTree` (the recalc) and
  // `ParseAuthorStyleSheet` (parsing author CSS). Both bill to the `style` slice.
  //
  // [measured] `ParseAuthorStyleSheet` is a stylesheet PARSE, not a recalc: it fires only when new
  // author CSS is parsed inside the window (an injected/loaded `<link rel=stylesheet>`), and Blink
  // logs it WITHOUT incrementing `RecalcStyleCount`. Inline `<style>`, `insertRule`, and DOM/class
  // mutations never emit it. Its time is real main-thread style work, so it stays on the `style`
  // slice (the breakdown bar bills it). The reported `styleCount` is CDP `RecalcStyleCount` (the
  // merge prefers it), already parse-free because Blink never counts the parse. The trace-DERIVED
  // fallback does exclude it: summing every `style` event gives recalc + parses > `RecalcStyleCount`,
  // so `summarize` skips `STYLE_PARSE_NAMES` and sums `UpdateLayoutTree` alone.
  // See docs/dev/rendering-counts.md.
  style: {
    names: new Set(["UpdateLayoutTree", "ParseAuthorStyleSheet"]),
    slice: "style",
  },
  // Main-thread paint only, and deliberately just this one name.
  //
  // Blink emits one `Paint` per dirtied paint chunk, on the main thread, inside the frame that
  // painted it: [measured] exactly N+1 for N dirtied regions, ZERO variance over 40 runs, and
  // `will-change: transform` (own compositor layer) does not move it. That makes paintCount an exact
  // count of paint work, in the same trust tier as the CDP layout/style counters.
  //
  // Three neighbouring names are excluded because they are not paint work you can act on:
  //   - RasterTask/Rasterize run on RASTER WORKER threads, so their count tracks tiling and
  //     scheduler behaviour, not the page. [measured] they fire ~35x when NOTHING is dirtied and 14x
  //     for 40 dirtied boxes: anti-correlated with the paint work. Including them costs the count its
  //     reproducibility (3->39 on identical work) and with it the right to gate CI.
  //   - PaintImage nests INSIDE a Paint event, so counting it double-counts the same work.
  // They stay in the event log and are reachable by name (`query events --name RasterTask`); they are
  // just not a count anyone should gate on. See docs/dev/rendering-counts.md.
  paint: { names: new Set(["Paint"]), slice: "paint" },
  composite: {
    names: new Set([
      "CompositeLayers",
      "Composite Layers",
      "UpdateLayer",
      "UpdateLayerTree",
      "Commit",
    ]),
    slice: "other",
  },
  invalidation: {
    names: new Set([
      "LayoutInvalidationTracking",
      "PaintInvalidationTracking",
      "ScheduleStyleInvalidationTracking",
      "StyleRecalcInvalidationTracking",
      "StyleInvalidatorInvalidationTracking",
      "InvalidateLayout",
      "LayoutImageUnsized",
    ]),
    slice: "other",
  },
  scripting: {
    names: new Set([
      "FunctionCall",
      "EvaluateScript",
      "v8.run",
      "v8.compile",
      "RunMicrotasks",
      "TimerFire",
      "RequestAnimationFrame",
      "FireAnimationFrame",
    ]),
    slice: "js",
    // A v8-category event with no more specific name is scripting. Checked AFTER gc in classify so a
    // GC event whose category includes "v8" does not land here.
    match: (_name, cat) => cat.includes("v8"),
  },
  // Garbage collection on the renderer main thread. [measured, real trace] the light --breakdown
  // category set (devtools.timeline, no v8.gc) emits `MinorGC`/`MajorGC` as complete events with a
  // duration on the main thread; the `V8.GC*` family is mostly instant markers / background-thread
  // work, matched by prefix defensively so any main-thread member nests as gc rather than leaking
  // into `other`. classify() runs in every mode, so `MinorGC`/`MajorGC`/`V8.GC*` reclassify from
  // `other` to `gc` everywhere; no rendering count derives from the gc kind, so only the kind label
  // shifts (the seven-slice breakdown is what consumes the gc slice). See docs/dev/rendering-counts.md.
  gc: {
    names: new Set(["MinorGC", "MajorGC"]),
    slice: "gc",
    match: (name) => name.startsWith("V8.GC"),
  },
  task: { names: new Set(["RunTask"]), slice: "other" },
  usertiming: {
    names: new Set<string>(),
    slice: "other",
    match: (_name, cat) => cat.includes("blink.user_timing"),
  },
  // The floor bucket: task remainder + anything unclassified (composite/invalidation/user-timing/
  // other). classify falls back to this when no row above matched, so it carries no name rule.
  other: { names: new Set<string>(), slice: "other" },
};

/**
 * Style events that are a stylesheet PARSE, not a recalc. Real main-thread style work (kept on the
 * `style` slice, so the breakdown bar bills it), but Blink never increments `RecalcStyleCount` for
 * them. A trace-DERIVED style count/duration (the fallback used when a CDP delta is absent) must
 * exclude these to match CDP `RecalcStyleCount`/`RecalcStyleDuration`. See
 * docs/dev/rendering-counts.md.
 */
export const STYLE_PARSE_NAMES: ReadonlySet<string> = new Set(["ParseAuthorStyleSheet"]);

/**
 * Which breakdown work slice an event kind lands in, read straight off the taxonomy table. There is
 * no silent `default` fallback: the `Record<EventKind, ...>` table is total, so a new EventKind is a
 * compile error at the table itself rather than a kind that silently buckets as `other` here.
 */
export function sliceOf(kind: EventKind): WorkSlice {
  return TAXONOMY[kind].slice;
}
