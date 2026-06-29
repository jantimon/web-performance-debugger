import type { EventKind } from "../model/recording.js";

const LAYOUT = new Set(["Layout"]);
const STYLE = new Set(["UpdateLayoutTree", "RecalcStyles", "RecalcStyle", "ParseAuthorStyleSheet"]);
const PAINT = new Set(["Paint", "PaintImage", "RasterTask", "Rasterize"]);
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
