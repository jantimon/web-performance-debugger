import type { NormalizedEvent } from "../model/recording.js";
import { classify } from "./classify.js";

interface RawTraceEvent {
  cat?: string;
  name: string;
  ts: number;
  dur?: number;
  ph: string;
  pid?: number;
  tid?: number;
  args?: unknown;
}

/** Parse a raw DevTools trace buffer (JSON) into normalized, classified events. */
export function parseTrace(rawJson: string | { traceEvents?: RawTraceEvent[] }): NormalizedEvent[] {
  const obj = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  const raw: RawTraceEvent[] = Array.isArray(obj) ? obj : (obj.traceEvents ?? []);
  const out: NormalizedEvent[] = [];
  let id = 0;
  for (const rawEvent of raw) {
    if (typeof rawEvent.ts !== "number" || !rawEvent.name) continue;
    // keep complete (X), instant (I/R), and async begin (b) events; drop metadata (M)
    if (rawEvent.ph === "M") continue;
    const cat = rawEvent.cat ?? "";
    out.push({
      id: id++,
      name: rawEvent.name,
      ts: rawEvent.ts,
      dur: typeof rawEvent.dur === "number" ? rawEvent.dur : 0,
      ph: rawEvent.ph,
      kind: classify(rawEvent.name, cat),
      args: rawEvent.args,
    });
  }
  out.sort((left, right) => left.ts - right.ts);
  return out;
}

export interface StepWindow {
  index: number;
  startTs: number;
  endTs: number | null;
}

/** Locate per-step [start,end] windows from wpd:step:N:start/end markers. */
export function findSteps(events: NormalizedEvent[]): StepWindow[] {
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  for (const event of events) {
    let match = /^wpd:step:(\d+):start$/.exec(event.name);
    if (match) {
      starts.set(Number(match[1]), event.ts);
      continue;
    }
    match = /^wpd:step:(\d+):end$/.exec(event.name);
    if (match) ends.set(Number(match[1]), event.ts);
  }
  return [...starts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, startTs]) => ({ index, startTs, endTs: ends.get(index) ?? null }));
}

/** Locate the [start,end] trace-clock window from our user-timing marker events. */
export function findWindow(events: NormalizedEvent[]): {
  startTs: number | null;
  endTs: number | null;
} {
  let startTs: number | null = null;
  let endTs: number | null = null;
  for (const event of events) {
    if (event.name === "wpd:run:start") startTs = event.ts;
    if (event.name === "wpd:run:end") endTs = event.ts;
  }
  return { startTs, endTs };
}
