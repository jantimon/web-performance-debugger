import type { EventKind } from "../model/recording.js";

const LAYOUT = new Set(["Layout"]);
const STYLE = new Set(["UpdateLayoutTree", "RecalcStyles", "RecalcStyle", "ParseAuthorStyleSheet"]);
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
const PAINT = new Set(["Paint"]);
const COMPOSITE = new Set([
  "CompositeLayers",
  "Composite Layers",
  "UpdateLayer",
  "UpdateLayerTree",
  "Commit",
]);
const INVALIDATION = new Set([
  "LayoutInvalidationTracking",
  "PaintInvalidationTracking",
  "ScheduleStyleInvalidationTracking",
  "StyleRecalcInvalidationTracking",
  "StyleInvalidatorInvalidationTracking",
  "InvalidateLayout",
  "LayoutImageUnsized",
]);
const TASK = new Set(["RunTask"]);
const SCRIPTING = new Set([
  "FunctionCall",
  "EvaluateScript",
  "v8.run",
  "v8.compile",
  "RunMicrotasks",
  "TimerFire",
  "RequestAnimationFrame",
  "FireAnimationFrame",
]);

export const EVENT_KINDS: EventKind[] = [
  "layout",
  "style",
  "paint",
  "composite",
  "invalidation",
  "scripting",
  "task",
  "usertiming",
  "other",
];

export const isEventKind = (value: string): value is EventKind =>
  (EVENT_KINDS as string[]).includes(value);

export function classify(name: string, cat: string): EventKind {
  if (LAYOUT.has(name)) return "layout";
  if (STYLE.has(name)) return "style";
  if (PAINT.has(name)) return "paint";
  if (COMPOSITE.has(name)) return "composite";
  if (INVALIDATION.has(name)) return "invalidation";
  if (TASK.has(name)) return "task";
  if (cat.includes("blink.user_timing")) return "usertiming";
  if (SCRIPTING.has(name) || cat.includes("v8")) return "scripting";
  return "other";
}

export function invalidationKind(name: string): "layout" | "paint" | "style" | "other" {
  if (name.startsWith("Layout") || name === "InvalidateLayout") return "layout";
  if (name.startsWith("Paint")) return "paint";
  if (name.includes("Style")) return "style";
  return "other";
}
