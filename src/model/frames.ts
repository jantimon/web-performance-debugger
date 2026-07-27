/** Terminal verdict of a compositor frame, from PipelineReporter's `frame_reporter.state`. */
export type FrameState = "presented" | "presentedPartial" | "dropped" | "noUpdate";

/**
 * One compositor frame from Chrome's off-thread frame pipeline (a `PipelineReporter` async slice).
 *
 * DISPLAY-ONLY. These are scheduler/settle noise on unchanged code (compositor warmth + how many
 * vsync ticks the settle window happens to span), and 20 recolored boxes present as the same frame
 * count as 1 box, so a frame count does not even track paint work. Only main-thread `Paint` is exact
 * enough to gate. See docs/dev/rendering-counts.md.
 */
export interface FrameRecord {
  /** compositor `frame_sequence`: the frame's identity within the run */
  sequence: number;
  state: FrameState;
  /** the frame was on the smoothness-critical path (a dropped/late one is visible jank) */
  affectsSmoothness: boolean;
  /** frame-pipeline duration (begin-impl-frame -> presentation), ms */
  durMs: number;
}

/**
 * The per-span off-thread frame side track (Chrome --breakdown only). Tallies `PipelineReporter`
 * verdicts, and for the slowest presented (incl. partial) frame carries its top pipeline-stage
 * durations.
 *
 * DISPLAY-ONLY, and the type is shaped so the rule is enforced by construction: this lives on
 * SpanBreakdown, NEVER on RecordingSummary, so the gate readers (`assert`/`diff`, which see only the
 * summary) structurally cannot reach it. Nothing here is summed into any breakdown bar either -- the
 * wall is main-thread self-time and these frames run on compositor/viz threads (the §9 rule). The
 * counts are scheduler noise, the one reason they must not gate; see FrameRecord and
 * docs/dev/rendering-counts.md.
 */
export interface FrameSideTrack {
  presented: number;
  presentedPartial: number;
  dropped: number;
  noUpdate: number;
  /** every frame in the span's window (presented + partial + dropped + noUpdate) */
  total: number;
  /** top pipeline-stage durations of the slowest presented (incl. partial) frame; absent when none presented */
  worstStages?: { name: string; ms: number }[];
  /** raw per-frame records (few per span), for JSON drill-in */
  frames: FrameRecord[];
}
