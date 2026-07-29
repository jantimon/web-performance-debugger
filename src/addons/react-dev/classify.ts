// Classify the React Performance-Track `TimeStamp` events a development/profiling build writes to the
// trace. React 19.2's tracks API is the extended `console.timeStamp(label, start, end, track,
// trackGroup, color)` [source: facebook/react PR #32736], which emits `TimeStamp` events under
// `devtools.timeline` -- in wpd's `--breakdown` and `--deep` category sets alike, and PERSISTED under
// `--deep` (`classify.ts` maps `TimeStamp` to kind "other", `args.data.track` intact). [measured] a
// driven dev interaction produced 57 such events over 6 clicks; the production build emits ZERO. So
// this is a classify/parse of a field wpd already stores, never a capture change. See
// docs/dev/react-attribution.md#the-persisted-timestamp-shape-under---deep. Pure over the event log, so
// it is unit-testable against synthetic events.

import type { NormalizedEvent } from "../../model/recording.js";
import { usToMs } from "../../model/time.js";
import type { ReactDevFacts, ReactTrackBucket } from "./facts.js";

/** React marks its Performance Tracks with the reconciler's atom symbol in the track/group label
 * (`Scheduler ⚛`, `Components ⚛`), so an event carrying it is React's, not another extension's. */
const REACT_TRACK_MARK = "⚛"; // ⚛

interface TimeStampData {
  track?: unknown;
  trackGroup?: unknown;
}

/** Read `args.data` off a TimeStamp event without trusting its shape (the stored args are opaque). */
function timeStampData(event: NormalizedEvent): TimeStampData | null {
  const args = event.args;
  if (args == null || typeof args !== "object") return null;
  const data = (args as { data?: unknown }).data;
  if (data == null || typeof data !== "object") return null;
  return data as TimeStampData;
}

/** Whether an event is a React Performance-Track `TimeStamp` (its track or group carries the atom mark). */
function isReactTrackEvent(event: NormalizedEvent): boolean {
  if (event.name !== "TimeStamp") return false;
  const data = timeStampData(event);
  if (!data) return false;
  const track = typeof data.track === "string" ? data.track : "";
  const group = typeof data.trackGroup === "string" ? data.trackGroup : "";
  return track.includes(REACT_TRACK_MARK) || group.includes(REACT_TRACK_MARK);
}

/**
 * Classify the React track events in one span window into per-track buckets. Returns null when the
 * window carried NONE, so the caller leaves the fact absent rather than emitting an empty summary
 * (never a fabricated zero). The per-component `performance.measure` stream is a separate, richer
 * channel already folded by `query spans`, so it is deliberately not read here.
 */
export function classifyReactTracks(windowEvents: NormalizedEvent[]): ReactDevFacts | null {
  const byTrack = new Map<string, { group: string; count: number; us: number }>();
  let total = 0;
  let totalUs = 0;
  for (const event of windowEvents) {
    if (!isReactTrackEvent(event)) continue;
    const data = timeStampData(event)!;
    const track = (typeof data.track === "string" && data.track) || "(untracked)";
    const group = (typeof data.trackGroup === "string" && data.trackGroup) || "";
    const durationUs = Math.max(0, event.dur);
    const bucket = byTrack.get(track) ?? { group, count: 0, us: 0 };
    bucket.count += 1;
    bucket.us += durationUs;
    byTrack.set(track, bucket);
    total += 1;
    totalUs += durationUs;
  }
  if (total === 0) return null;
  const tracks: ReactTrackBucket[] = [...byTrack.entries()]
    .map(([track, bucket]) => ({
      track,
      group: bucket.group,
      count: bucket.count,
      ms: usToMs(bucket.us),
    }))
    .sort((left, right) => right.count - left.count);
  return { total, totalMs: usToMs(totalUs), tracks };
}
