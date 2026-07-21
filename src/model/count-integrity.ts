// Whether a recording's trace-derived rendering counts are KNOWN-INCOMPLETE, and why. Two capture
// conditions leave the counts undercounting the page's real work, each recorded as a typed meta field
// by record():
//
//   - meta.mainThread.split: the run's rendering landed on more than one renderer process one after
//     another (successive cross-process navigations), so the selected main thread the counts scope to
//     holds only part of it (trace/main-thread.ts).
//   - meta.dataLoss.trace: the trace buffer overran and Chrome dropped events (docs/dev/trace-buffer.md).
//
// A count is a number, not a Measured null, so nothing in the count itself signals the shortfall: a
// consumer reads a plausible wrong figure. So `assert`/`diff --fail-on-regression` REFUSE count and
// count-derived thresholds when this returns a reason -- the not-gateable analogue of the not-measured
// n/a FAIL, never a silent pass over an incomplete count. Timing thresholds (wall/INP) ride
// performance.now, not the trace counts, so they are unaffected.

import type { RecordingMeta } from "./recording.js";

/** A reason the recording's counts cannot be trusted as complete, or null when they are whole. */
export function countIntegrityRefusal(meta: RecordingMeta): string | null {
  if (meta.mainThread?.split)
    return (
      "the run's rendering work was split across renderer processes (successive cross-process " +
      "navigations), so trace-derived counts cover only the busiest thread and are known-incomplete; " +
      "record each navigation in its own run"
    );
  if (meta.dataLoss?.trace)
    return (
      "the trace buffer overflowed and Chrome dropped events, so trace-derived counts can undercount " +
      "and are known-incomplete; reduce the measured work and re-record"
    );
  return null;
}
