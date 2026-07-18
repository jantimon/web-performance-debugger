import type { NormalizedEvent } from "../model/recording.js";
import { RUN_START_MARK, RUN_END_MARK, matchStepEdgeMark } from "../model/marks.js";
import { classify } from "./classify.js";

interface RawTraceEvent {
  cat?: string;
  name: string;
  ts: number;
  dur?: number;
  ph: string;
  pid?: number;
  tid?: number;
  /** async-event correlation id: `id2.{local,global}` (nestable async) or the flat `id` (numeric at runtime) */
  id?: string | number;
  id2?: { local?: string; global?: string };
  args?: unknown;
}

/**
 * Parse a raw DevTools trace buffer (JSON) into normalized, classified events.
 *
 * `keepThreadIds` retains each event's `pid`/`tid`. Off by default so no other mode carries thread
 * ids on its stored events; --breakdown turns it on because the seven-slice engine tiles the
 * renderer main thread alone and must tell it from raster/compositor threads.
 */
export function parseTrace(
  rawJson: string | { traceEvents?: RawTraceEvent[] },
  options?: { keepThreadIds?: boolean },
): NormalizedEvent[] {
  const obj = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  const raw: RawTraceEvent[] = Array.isArray(obj) ? obj : (obj.traceEvents ?? []);
  const keepThreadIds = options?.keepThreadIds === true;
  const out: NormalizedEvent[] = [];
  let id = 0;
  for (const rawEvent of raw) {
    if (typeof rawEvent.ts !== "number" || !rawEvent.name) continue;
    // keep complete (X), instant (I/R), and async begin (b) events; drop metadata (M)
    if (rawEvent.ph === "M") continue;
    const cat = rawEvent.cat ?? "";
    const event: NormalizedEvent = {
      id: id++,
      name: rawEvent.name,
      ts: rawEvent.ts,
      dur: typeof rawEvent.dur === "number" ? rawEvent.dur : 0,
      ph: rawEvent.ph,
      kind: classify(rawEvent.name, cat),
      args: rawEvent.args,
    };
    if (keepThreadIds) {
      if (typeof rawEvent.pid === "number") event.pid = rawEvent.pid;
      if (typeof rawEvent.tid === "number") event.tid = rawEvent.tid;
      // Pairing key for async begin/end slices (the frame side track pairs PipelineReporter b/e).
      // Kept only here so non-breakdown recordings' events stay byte-for-byte.
      const asyncId = rawEvent.id2?.local ?? rawEvent.id2?.global ?? rawEvent.id;
      // the flat `id` can be numeric; store a string so asyncId keys pair uniformly.
      if (asyncId != null) event.asyncId = String(asyncId);
    }
    out.push(event);
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
    const step = matchStepEdgeMark(event.name);
    if (!step) continue;
    if (step.edge === "start") starts.set(step.index, event.ts);
    else ends.set(step.index, event.ts);
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
    if (event.name === RUN_START_MARK) startTs = event.ts;
    if (event.name === RUN_END_MARK) endTs = event.ts;
  }
  return { startTs, endTs };
}
