import type {
  FrameRecord,
  FrameSideTrack,
  FrameState,
  NormalizedEvent,
} from "../model/recording.js";
import { usToMs } from "../model/time.js";

/**
 * The off-thread compositor frame side track: extract per-frame records from Chrome's frame
 * pipeline (`PipelineReporter` async slices) and tally them per span.
 *
 * DISPLAY-ONLY, top to bottom. These frames run on compositor/viz threads, not the renderer main
 * thread, so NOTHING here is summed into a breakdown bar (the wall is main-thread self-time, §9),
 * and the counts are scheduler/settle noise on unchanged code (measured 1->28 on an identical
 * 20-box paint), so they must never gate `assert`/`diff`. The one exact rendering count stays
 * main-thread `Paint`. See docs/dev/rendering-counts.md.
 *
 * The data is already in every Chrome wpd trace via the enabled `disabled-by-default-devtools.
 * timeline.frame` category; this module only parses what is there, with no trace-config change.
 */

/** `PipelineReporter.frame_reporter.state` -> our compact FrameState. Unknown states are dropped. */
const STATE_MAP: Record<string, FrameState> = {
  STATE_PRESENTED_ALL: "presented",
  STATE_PRESENTED_PARTIAL: "presentedPartial",
  STATE_DROPPED: "dropped",
  STATE_NO_UPDATE_DESIRED: "noUpdate",
};

const PIPELINE_REPORTER = "PipelineReporter";

/** Top pipeline stages named on the slowest presented (incl. partial) frame's side-track line. */
const WORST_STAGES_TOP = 3;

/** The `frame_reporter` payload carried on a PipelineReporter begin ("b") event. */
interface FrameReporter {
  state?: string;
  frame_sequence?: number;
  affects_smoothness?: boolean;
}

function frameReporterOf(event: NormalizedEvent): FrameReporter | undefined {
  const args = event.args as { frame_reporter?: FrameReporter } | undefined;
  return args?.frame_reporter;
}

/**
 * One paired compositor frame, before windowing. Carries `startTs` (trace clock, microseconds) so
 * the caller can window it, plus the frame's direct pipeline stages for the worst-frame annotation.
 */
export interface ParsedFrame {
  sequence: number;
  state: FrameState;
  affectsSmoothness: boolean;
  startTs: number;
  durMs: number;
  /** direct child pipeline stages of this frame, in trace order */
  stages: { name: string; ms: number }[];
}

/** An open async slice on the frame track, awaiting its "e". */
interface OpenSlice {
  name: string;
  startTs: number;
  reporter?: FrameReporter;
  /** direct child stages closed while this slice was the innermost PipelineReporter */
  stages: { name: string; ms: number }[];
}

/**
 * Parse the frame track (`PipelineReporter` + its nested stage slices) into completed per-frame
 * records. The frame track is a single nestable-async track per (pid, asyncId): PipelineReporter
 * wraps its stage slices in strict LIFO order, so a per-track stack pairs begin/end exactly and a
 * stage's parent is whatever PipelineReporter is open beneath it.
 *
 * Pure and fixture-testable: it reads only async b/e events that carry an `asyncId` (kept solely in
 * --breakdown mode), so on any other events it returns []. The window rule lives in the caller.
 */
export function parseFrames(events: NormalizedEvent[]): ParsedFrame[] {
  // events are already ts-sorted by parseTrace; a per-track stack needs that order.
  const stacks = new Map<string, OpenSlice[]>();
  const frames: ParsedFrame[] = [];
  for (const event of events) {
    if (event.asyncId == null) continue;
    if (event.ph !== "b" && event.ph !== "e") continue;
    const isReporter = event.name === PIPELINE_REPORTER;
    const isOtherAsyncSlice = !isReporter && frameReporterOf(event) === undefined;
    // `isOtherAsyncSlice` is true for EVERY non-reporter async slice, not only frame stages: a frame
    // stage carries no frame_reporter (that lives on the reporter's begin), but neither does any
    // unrelated async slice. Correctness does not need to tell them apart, because a stage is only
    // ever recorded when a PipelineReporter is open beneath it on the same track (see the "e" branch),
    // and unrelated tracks never nest inside a PipelineReporter -- so their slices open and close with
    // no reporter parent and contribute nothing.
    if (!isReporter && !isOtherAsyncSlice) continue;
    // Assumes (pid, asyncId) is not shared by a foreign non-frame slice sitting inside an open
    // reporter's lifetime: such a collision would be recorded as a bogus stage. Chrome's async ids are
    // display-only and effectively unique per track, and this side track is itself display-only, so
    // the risk is acceptable.
    const key = `${event.pid}/${event.asyncId}`;
    const stack = stacks.get(key) ?? [];
    if (event.ph === "b") {
      stack.push({
        name: event.name,
        startTs: event.ts,
        reporter: isReporter ? frameReporterOf(event) : undefined,
        stages: [],
      });
      stacks.set(key, stack);
      continue;
    }
    // "e": close the innermost open slice on this track.
    const slice = stack.pop();
    if (!slice) continue;
    const durMs = usToMs(event.ts - slice.startTs);
    if (slice.name === PIPELINE_REPORTER) {
      const state = slice.reporter?.state ? STATE_MAP[slice.reporter.state] : undefined;
      if (state && typeof slice.reporter?.frame_sequence === "number") {
        frames.push({
          sequence: slice.reporter.frame_sequence,
          state,
          affectsSmoothness: slice.reporter.affects_smoothness === true,
          startTs: slice.startTs,
          durMs,
          stages: slice.stages,
        });
      }
    } else {
      // A stage: attribute it to the PipelineReporter now innermost on the track, if any.
      const parent = stack[stack.length - 1];
      if (parent?.name === PIPELINE_REPORTER) parent.stages.push({ name: slice.name, ms: durMs });
    }
  }
  return frames;
}

/**
 * Frames belonging to a span, selected by frame START time.
 *
 * `startOnward` (the run span) takes every frame from `startTs` on with NO upper bound: the frame
 * that presents a span's work lands AFTER its end marker (settle-tail), so bounding at `endTs` would
 * drop exactly the presented frame the work produced. rendering-counts.md: Chrome's window rule is
 * start-onward, or it measures nothing. A bounded sub-span (a step / user measure) claims frames
 * whose start falls in `[startTs, endTs)`.
 */
export function windowFrames(
  frames: ParsedFrame[],
  startTs: number,
  endTs: number,
  startOnward: boolean,
): ParsedFrame[] {
  return frames.filter(
    (frame) => frame.startTs >= startTs && (startOnward || frame.startTs < endTs),
  );
}

/**
 * Tally a windowed frame set into the display side track: verdict counts, the raw per-frame list,
 * and the top pipeline-stage durations of the slowest presented (incl. partial) frame. Returns null for an empty
 * set, so the caller leaves the span's `frames` field absent rather than attaching an all-zero
 * tally.
 */
export function summarizeFrames(frames: ParsedFrame[]): FrameSideTrack | null {
  if (frames.length === 0) return null;
  const tally = { presented: 0, presentedPartial: 0, dropped: 0, noUpdate: 0 };
  for (const frame of frames) tally[frame.state]++;

  // Slowest presented frame, counting partial presentations too (a noUpdate/dropped one has no
  // presentation to decompose).
  let slowest: ParsedFrame | null = null;
  for (const frame of frames) {
    if (frame.state !== "presented" && frame.state !== "presentedPartial") continue;
    if (!slowest || frame.durMs > slowest.durMs) slowest = frame;
  }
  const worstStages = slowest
    ? [...slowest.stages].sort((left, right) => right.ms - left.ms).slice(0, WORST_STAGES_TOP)
    : [];

  const records: FrameRecord[] = frames.map((frame) => ({
    sequence: frame.sequence,
    state: frame.state,
    affectsSmoothness: frame.affectsSmoothness,
    durMs: frame.durMs,
  }));

  return {
    ...tally,
    total: frames.length,
    ...(worstStages.length ? { worstStages } : {}),
    frames: records,
  };
}
