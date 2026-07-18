import type { EventKind } from "../model/recording.js";
import { TAXONOMY } from "./taxonomy.js";

export const EVENT_KINDS: EventKind[] = Object.keys(TAXONOMY) as EventKind[];

export const isEventKind = (value: string): value is EventKind =>
  (EVENT_KINDS as string[]).includes(value);

/**
 * The order classify tests kinds in, which is NOT the EVENT_KINDS order: gc is checked before the
 * scripting v8-category fallback (a GC event's category can include "v8", which would otherwise
 * classify it as scripting and hide it inside the js slice), and usertiming's category check
 * precedes scripting's. Exact-name kinds first, then the two category/prefix matchers; `other` is
 * the fallback when no row matches.
 */
const CLASSIFY_ORDER: EventKind[] = [
  "layout",
  "style",
  "paint",
  "composite",
  "invalidation",
  "gc",
  "task",
  "usertiming",
  "scripting",
];

export function classify(name: string, cat: string): EventKind {
  for (const kind of CLASSIFY_ORDER) {
    const row = TAXONOMY[kind];
    if (row.names.has(name) || row.match?.(name, cat)) return kind;
  }
  return "other";
}

export function invalidationKind(name: string): "layout" | "paint" | "style" | "other" {
  if (name.startsWith("Layout") || name === "InvalidateLayout") return "layout";
  if (name.startsWith("Paint")) return "paint";
  if (name.includes("Style")) return "style";
  return "other";
}
