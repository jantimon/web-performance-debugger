import type {
  EngineSoftNav,
  InteractionTiming,
  LayoutShift,
  NavigationKind,
  SoftNavRoute,
  StepLcp,
  StepLoaf,
} from "./recording.js";

/**
 * The driver->steps contract: one measured step as browser/driver.ts's runDriver produces it,
 * consumed by trace/steps.ts's mergeSteps. A pipeline record, not a stored artifact type
 */
export interface DriverStep {
  /** this step's position WITHIN its iteration; the same label gets the same index every time */
  index: number;
  /**
   * Which clock priced `wallMs`: "trace" when the trace window between the step's marks priced it,
   * "page" when it is the page's own performance.now delta. Absent when wallMs is null. A "page"
   * wall beside a trace-clock breakdown does not reconcile with the bar
   */
  wallClock?: "trace" | "page";
  /**
   * Which timed iteration produced this step (0-based). Optional so a programmatic caller may
   * hand-build single-iteration steps; absent is read as 0 (see mergeSteps)
   */
  iteration?: number;
  /**
   * "prepare" for a step measured inside prepare(), which runs ONCE before the timed loop, so it
   * has one sample no matter what --iterations says. Absent means "timed". Kept distinct rather
   * than folded into `iteration` because the two ask different questions: a prepare step is not
   * iteration 0 of anything, and treating it as such would make the idempotency check see an extra
   * label in iteration 0 and fail every repeated run whose prepare() measured something
   */
  phase?: "prepare" | "timed";
  /**
   * Unique within the pass: the N in this step's `wpd:step:N` marks. Distinct from `index`
   * because a repeated flow measures "mount" once per iteration, and two windows sharing a mark
   * name could not be told apart in the trace. Absent falls back to `index`, which is the same
   * number whenever only one iteration ran
   */
  markIndex?: number;
  label: string;
  /**
   * The step's wall on the clock the capture mode has: the page's own `performance.now()` delta between the
   * step's marks (this field, `pageWallMs`), overridden by the trace-clock window between the same
   * marks when a trace was captured (--breakdown/--deep). Never the node-side `performance.now()`
   * around `page.click`, which measures the tool process: ~20ms of that is input dispatch in no
   * renderer timeline (docs/dev/driver-timing.md). Null when neither clock can price the step (a
   * navigating step in the no-trace default capture mode: a new document resets the page clock, so the two
   * marks no longer share one, and there is no trace to span it)
   */
  wallMs: number | null;
  /**
   * The page-side `performance.now()` delta between this step's marks, measured in-page. Null when
   * the step navigated (the marks land on documents with different `timeOrigin`, so their delta is
   * meaningless). `wallMs` starts here and is upgraded to the trace-clock window when a trace exists
   */
  pageWallMs: number | null;
  inpMs: number | null;
  /** in-page CWV split of `inpMs`; null when no interaction crossed the 16ms Event Timing floor */
  interaction: InteractionTiming | null;
  /**
   * Long Animation Frames observed in this step's window (Chrome only). Absent when none were
   * observed, or the browser has no `long-animation-frame` support (Firefox): nothing is stored, so
   * a firefox step never reports a fabricated zero. See summarizeLoaf
   */
  loaf?: StepLoaf;
  /** how the document changed across the step (none/hard/soft/soft-hash); see classifyNavigation */
  navigation?: NavigationKind;
  /** `page.url()` at the step's start mark */
  beforeUrl?: string;
  /** `page.url()` at the step's end mark; a step's pair is self-contained (no cross-step continuity) */
  afterUrl?: string;
  /** Chrome's own soft-navigation verdict (default-on Chrome 151), read opportunistically beside
   * `navigation`; absent when the engine fired no entry or the browser has no support. See shapeEngineSoftNav */
  engineSoftNav?: EngineSoftNav;
  /** route-transition metrics (LCP-equivalent / CLS / INP on the route clock) for a step the engine
   * soft-navigated (Chrome 151+), keyed by the soft nav's navigationId; absent when no engine soft-nav
   * fired. See shapeSoftNavRoute */
  softNav?: SoftNavRoute;
  /** boot LCP, present only on a HARD-navigation step (a fresh document); see shapeLcp */
  lcp?: StepLcp;
  /** CLS (spec session-window max) for this step, with shifting elements attributed (Chrome only);
   * absent when no qualifying shift was observed or the browser has no support. See computeLayoutShift */
  layoutShift?: LayoutShift;
  /**
   * Raw per-step framework-addon probe payload read at this step's flush (`window.__wpdAddonStepRead`),
   * keyed by addon name. Opaque here (it crossed the page boundary); an addon's `enrich` shapes it into
   * the stored `Span.addons` facts. Absent when no addon installed a per-step probe (e.g. --framework
   * off) or the window read nothing. Carried from iteration 0 through mergeSteps
   */
  addons?: Record<string, unknown>;
}
