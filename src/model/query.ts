// Shapes emitted by the `query`/`cpu-diff` verbs under `--format json|toon`. These are
// derived views over the on-disk artifacts (model/recording.ts), kept here so the command
// call sites can be annotated and the JSON contract cannot silently drift.

import type {
  CpuBreakdown,
  CpuFunction,
  CpuGroupStat,
  CpuJsSlice,
  CpuSlice,
  CpuSystem,
  DirtiedByWrite,
  EngineSoftNav,
  EventKind,
  FirefoxDirtiedByReport,
  FrameSideTrack,
  InteractionTiming,
  LayoutShift,
  NavigationKind,
  FlushScope,
  SoftNavRoute,
  SpanAggregation,
  SpanCounts,
  SpanAddons,
  SpanKind,
  SpanScope,
  StepLcp,
  StepLoaf,
  TargetLane,
  ThrashReport,
} from "./recording.js";
import type { CaptureMode } from "../record/capture.js";
import type { Measured } from "./measured.js";
import type { SpanSliceDiff } from "./spans.js";
import type { SoftNavVerdict } from "./soft-nav.js";
import type { FrameFloor, WallMultipleFloor } from "./frame-floor.js";
import type { AllocFunction, AllocGroupStat, AllocSamplingConfig } from "./alloc.js";

/** Functions below the `--top` cutoff in an allocation overview, rolled up. */
export interface AllocDropped {
  frames: number;
  selfBytes: number;
}

/**
 * `query alloc` output: the total sampled bytes headline, the by-package/by-file rollups, and the hot
 * (top-allocating) functions. The allocation analog of `CpuOverview`. `totalBytes` is directional
 * (~10-20%); the byPackage/byFile SHARES denominate on it and are the trustworthy signal (~5%).
 */
export interface AllocOverview {
  /** path to the raw .heapprofile (absolute back-pointer) */
  profile: string;
  /** total sampled bytes attributed to rankable user frames (the share denominator) */
  totalBytes: number;
  sampleCount: number;
  sampling: AllocSamplingConfig;
  byPackage: AllocGroupStat[];
  byFile: AllocGroupStat[];
  /** top functions by self bytes (length bounded by `--top`) */
  hot: AllocFunction[];
  dropped: AllocDropped;
  hints: string[];
}

/** Functions below the `--top` cutoff in a CPU overview, rolled up. */
export interface CpuDropped {
  frames: number;
  selfMs: number;
}

/** `query cpu` output: JS self-time headline, by-package/by-file rollups, and the hot list. */
export interface CpuOverview {
  /** path to the raw .cpuprofile (absolute back-pointer) */
  profile: string;
  /** JS self-time (the headline; the byPackage/byFile shares denominate on it) */
  jsSelfMs: number;
  /** non-idle sampled total (js + gc + engine/native); NOT the headline, and never a share denominator */
  activeMs: number;
  totalMs: number;
  sampleCount: number;
  sampleIntervalUs: number;
  system: CpuSystem;
  /** reconciling js/browser/gc/idle bar; absent on lanes without honest idle (Firefox) or old models */
  breakdown?: CpuBreakdown;
  byPackage: CpuGroupStat[];
  byFile: CpuGroupStat[];
  /** top functions by self time (length bounded by `--top`) */
  hot: CpuFunction[];
  dropped: CpuDropped;
  hints: string[];
}

/** One caller or callee of a function, with the time on that edge. */
export interface CpuEdgeRef {
  id: number;
  fn: string;
  ms: number;
}

/** `query frame <id>` output: the function plus its top callers and callees. */
export interface FrameQueryResult {
  function: CpuFunction;
  callers: CpuEdgeRef[];
  callees: CpuEdgeRef[];
}

/**
 * One row of `query blame`: events sharing a source location, rolled up. The location is structured
 * (`source` + `line` + `column`) to match the human table's columns, so a consumer reads the fields
 * directly instead of parsing a `file:line:col` string (the old `at` shape). `source` is relative to
 * root for a local file, or the origin/url for a remote frame; `line`/`column` are absent when the
 * frame carried no position.
 */
export interface BlameEntry {
  /** bare source path/url of the read site (no `:line:col`); relative to root for a local file */
  source: string;
  /** 1-based line of the read site; absent when the frame carried no line */
  line?: number;
  /** 1-based column of the read site; absent when the frame carried no column (a line-only sample) */
  column?: number;
  count: number;
  /** how many of `count` were synchronously forced by JS (thrashing) */
  forced: number;
  durMs: number;
  kinds: EventKind[];
  /**
   * The DOM properties read at this line (Firefox read-site forced blame), e.g.
   * "HTMLElement.offsetWidth". Absent on lanes that do not name the forcing property (Chrome, which
   * names the read line but not the accessor).
   */
  properties?: string[];
  /**
   * The WRITE end of the forced-flush dual annotation: the mutation(s) that dirtied the DOM so this read forced
   * a synchronous flush. Chrome `--deep` only (its invalidation records name the write); absent on
   * every other lane. `at` is the read (who paid), `dirtiedBy` the write (who caused).
   */
  dirtiedBy?: DirtiedByWrite[];
  /**
   * The representative raw event for the blame -> `query get` drill: the id of the WIDEST
   * (max-duration) flush at this source line, the same flush `scope` describes. Drill it with
   * `query get <eventId>` for the raw event (its stack + args); `query events` browses/filters the
   * rest. Absent on the chrome `--breakdown` sampled rows (their events are synthesized with id 0, not
   * addressable), so absent means "no addressable raw event", never a fake id.
   */
  eventId?: number;
  /**
   * Per-row confidence of the sampled read line, three-way so a consumer can tell a sampled-confident
   * row from a not-sampled one:
   *   - ABSENT: not a sampled row -- the exact chrome `--deep` (`.stack`) and firefox lanes, which do
   *     not sample the read site. Absent means "not sampled", never a misleading "confident".
   *   - `false`: a chrome `--breakdown` sampled row with at least one flush WIDER than one sampler
   *     interval, so the read line is confident.
   *   - `true`: a chrome `--breakdown` sampled row every flush of which was NARROWER than one interval,
   *     so the read line can lag one statement or land on an adjacent line.
   * See docs/dev/blame-semantics.md and model/capture-mode.ts `blameRowLowConfidence`.
   */
  lowConfidence?: boolean;
  /**
   * Layout/style SCOPE of the widest flush at this read site: how much it relaid out
   * (`layoutObjects` dirty/total) or recalculated (`elementsStyled`), and the container root of a
   * subtree-contained flush. A count-tier fact beside `durMs`, never a proxy for it. Chrome `--deep`
   * only (its stored flush events carry the trace `args`); absent on the sampled `--breakdown` and
   * firefox rows, which have no flush args. See FlushScope.
   */
  scope?: FlushScope;
}

/**
 * One span's slices in the single shape `query spans` reports across every engine. The keys are the
 * SUPERSET of what the two stored breakdown shapes carry (chrome's seven-slice `SpanBreakdown` and
 * the four/six-slice `CpuModel.breakdown`), so a matrix consumer reads the same field names on
 * chrome, firefox, and node.
 *
 * Honesty (the Measured<T> contract, see model/measured.ts): a slice a lane could not observe is an
 * explicit `null`, NEVER a fabricated 0. `style`/`layout` are null on the node lane (its four-slice
 * profile has no DOM work to split); `paint` is null whenever the span comes from a
 * `CpuModel.breakdown` (that bar carries no main-thread paint concept at all) AND on firefox stored
 * breakdowns, where paint is off-main-thread (a compositor side track, never summed into the wall).
 * So `paint` is null on every firefox span, stored bar or synthesized, and a consumer must treat it
 * as not-measured, never coerce it to 0.
 */
export interface UnifiedSlices {
  /** scripting self-time, split by owning package; measured on every lane */
  js: CpuJsSlice;
  /** style recalc; null when the lane did not split it (node) */
  style: Measured<CpuSlice>;
  /** layout/reflow; null when the lane did not split it (node) */
  layout: Measured<CpuSlice>;
  /** main-thread paint record; null when the source bar carries no paint concept (CpuModel.breakdown) */
  paint: Measured<CpuSlice>;
  /** garbage collection; measured on every lane */
  gc: CpuSlice;
  /** task remainder + unclassified (chrome `other`) / engine work unsplit (`browser`), unified */
  other: CpuSlice;
  /** the window not covered by any main-thread work; on a paint-terminated span this is vsync wait */
  idle: CpuSlice;
}

/**
 * Compact framework-addon presence for a `query spans` overview row: the identity facts a bulk
 * consumer needs WITHOUT drilling each span (React version + build), never the whole per-span fact
 * object. The full facts -- commitCount, the node-lane server-phase rollup -- stay on the `query span`
 * drill (SpanAnatomy.addons). Present only where the stored span carried the addon's facts (detection
 * rides the run span); a version/build the lane did not observe is absent, never a fabricated value.
 * See docs/dev/react-attribution.md.
 */
export interface SpanOverviewAddons {
  react?: {
    /** the reconciler's React version (e.g. "19.2.0"); absent when detection saw none */
    version?: string;
    /** dev vs prod build from the reconciler's bundleType; absent when detection saw none */
    build?: "development" | "production";
  };
}

/**
 * One span in `query spans` output: the run window, a driver step, or a user `performance.measure`.
 * `Σ measured slices + idle` reconciles to the tiled window (up to on-disk rounding dust or a
 * `residualMs`), the same closure the stored breakdowns promise: on a run/measure span that window IS
 * `wallMs`; on a STEP span it is `windowMs` (the bar tiles iteration 0, while `wallMs` is the
 * median headline).
 */
export interface SpanEntry {
  label: string;
  kind: SpanKind;
  /**
   * Headline wall (ms). On a run span it is the trace-clock window the slices tile. On a run span
   * SYNTHESIZED from `CpuModel.breakdown` (`SpansResult.source === "cpu-model"`: default-mode chrome,
   * node, firefox without user measures) it is the profiler's own sampled window, which brackets the
   * whole timed loop INCLUDING the settle wait -- so it can exceed the run span's summed timed samples.
   * The human header labels that case `sampled window`. On a STEP span it is the MEDIAN of the step's
   * per-iteration walls, NOT the tiled window: the bar tiles iteration 0 (`windowMs`), so on an outlier
   * iteration 0 the two diverge and the median is the honest headline. On a `measure` span the wall IS
   * the tiled window (a single occurrence, or the lower-median-by-wall pick of a repeated label).
   */
  wallMs: number;
  /**
   * The bar's own trace-clock window (ms) the slices tile, present ONLY on a STEP span (where it can
   * differ from the page-clock median `wallMs`). The bar tiles iteration 0, so `Σ measured slices +
   * idle` reconciles to this, not to the median headline. Absent on run/measure spans, whose `wallMs`
   * IS the tiled window.
   */
  windowMs?: number;
  /**
   * How this span's numbers combine the recording's timed iterations -- the one contract a consumer
   * needs before comparing spans, because a recording mixes them. `"sum"`: the window spans every
   * iteration, so slices/`wallMs` are a TOTAL across `iterations` (the run span: chrome's `wpd:run`
   * window covers the whole loop; the CpuModel-synthesized run brackets the whole timed loop).
   * `"first"`: the numbers describe ONE iteration -- a step span windowed to the FIRST timed iteration
   * (counts never scale with `--iterations`), or a `performance.measure` seen only once. `"median"`: a
   * `performance.measure` label that recurred, reported as the lower-median-by-wall occurrence (a real
   * reconciling sample, not per-slice averages); `samples`/`wallMinMs`/`wallMaxMs` disclose the merge.
   * At `iterations === 1` with no repeated measures the labels coincide; the label is still the
   * truthful one for the span.
   */
  aggregation: SpanAggregation;
  /** timed iterations behind this recording (`meta.iterations`); 1 unless `--iterations` repeated run() */
  iterations: number;
  slices: UnifiedSlices;
  /** off-thread compositor frame side track (chrome --breakdown only; absent otherwise). Display-only. */
  frames?: FrameSideTrack;
  /** carried through when the source breakdown did not fully close (lost events/clock skew) */
  residualMs?: number;
  /**
   * Real occurrences merged into this bar when `aggregation` is `"median"` (a repeated
   * `performance.measure` label). Absent for run/step spans and single-occurrence measures. Counts
   * real occurrences, not lookups: the bar IS one of these samples.
   */
  samples?: number;
  /** wall (ms) of the shortest merged occurrence; disclosed with `samples`. `wallMinMs <= wallMs <= wallMaxMs`. */
  wallMinMs?: number;
  /** wall (ms) of the longest merged occurrence; disclosed with `samples`. */
  wallMaxMs?: number;
  /** a driver step's navigation classification (none/hard/soft/soft-hash); absent on run/measure spans */
  navigation?: NavigationKind;
  /** the URL the step started on; absent on run/measure spans */
  beforeUrl?: string;
  /** the URL the step ended on; absent on run/measure spans */
  afterUrl?: string;
  /**
   * Layout/style scope distribution across this span window's flushes (chrome --breakdown; firefox
   * style only). A count-tier distribution beside the slice ms, never a proxy for it. Absent when the
   * capture stored none. The `query spans` HUMAN table omits it to stay legible; drill with `query
   * span` for the block. See SpanScope.
   */
  scope?: SpanScope;
  /**
   * The one-frame cadence floor this span sits on (a `FrameFloor`, discriminated by `basis`), present
   * ONLY when frame-DOMINATED (frame-floor.md). A run/measure span floors by its wall VALUE landing on
   * n frames (`wall-multiple`: a sub-frame value, or a wait-dominated multi-frame wall); a driver STEP
   * floors by its BAR (`work-signal`: sub-frame real work in an idle-dominated window, since its wall
   * carries input dispatch off any exact multiple). Absent when the span is real work, unmeasured, or
   * the lane declares no floor. The same tag `query span` carries in its detail (SpanAnatomy.frameFloor),
   * surfaced on the overview so a consumer reads flooring off the row instead of recomputing it.
   */
  frameFloor?: FrameFloor;
  /**
   * Compact framework-addon presence (React version + build) lifted onto the overview row, so a bulk
   * `query spans` consumer reads framework identity without drilling each span. Present only where the
   * stored span carried addon facts (detection rides the run span); absent otherwise. The full
   * per-span facts (commitCount, server phases) stay on SpanAnatomy.addons. See SpanOverviewAddons.
   */
  addons?: SpanOverviewAddons;
}

/**
 * One span's row when the capture built no reconciling bar for it (a default driver step, or a step
 * that navigated): its wall, aggregation and windowed Measured counts, with no
 * slices. The `slices`-less counterpart to `SpanEntry`, kept honest by the Measured contract -- a
 * count the capture did not take is `null`, never a fabricated 0. `--deep` carries exact counts here;
 * the sampling capture modes carry only the wall + INP.
 */
export interface SpanCountsEntry {
  label: string;
  kind: SpanKind;
  /** trace-clock window width; null when a navigating step could not be priced */
  wallMs: number | null;
  aggregation: SpanAggregation;
  /** a step's position within its iteration; absent on run/measure spans */
  index?: number;
  counts: SpanCounts;
  /** worst-interaction INP (ms) for a driver step; absent when none crossed the floor */
  inpMs?: number | null;
  /** a driver step's navigation classification (none/hard/soft/soft-hash); absent on run/measure spans */
  navigation?: NavigationKind;
  /** the URL the step started on; absent on run/measure spans */
  beforeUrl?: string;
  /** the URL the step ended on; absent on run/measure spans */
  afterUrl?: string;
  /**
   * The one-frame cadence floor this span's `wallMs` pins to, present only when frame-dominated (see
   * SpanEntry.frameFloor). A bar-less row carries no bar and no idle split, so it is always a
   * `wall-multiple` floor and only a sub-frame (single-frame) wall is tagged here; a multi-frame wall
   * needs the wait signal a bar would carry.
   */
  frameFloor?: WallMultipleFloor;
  /** Compact framework-addon presence (React version + build); see SpanEntry.addons. Present only
   * where the stored span carried addon facts (detection rides the run span), absent otherwise. */
  addons?: SpanOverviewAddons;
}

/**
 * `query spans` output: one unified per-span breakdown array across chrome/firefox/node. `source`
 * says where the spans came from -- `breakdowns` (the recording's stored per-span bars: chrome
 * --breakdown, or firefox with user measures) or `cpu-model` (a single `run` span synthesized from
 * `CpuModel.breakdown` when no per-span bars were stored: firefox/node without measures, default-mode
 * chrome). The `run` span is always present when any bar exists, so this never comes back empty.
 */
export interface SpansResult {
  /** the --target axis this recording was produced on: chrome | firefox | node */
  target: TargetLane;
  source: "breakdowns" | "cpu-model";
  spans: SpanEntry[];
  /**
   * Step/measure spans the capture built no reconciling bar for -- a driver step in the default
   * capture (whose only bar is the run's CpuModel bar), or a step that navigated. They
   * carry wall/INP/aggregation + Measured counts, slices not-measured, so the overview lists EVERY
   * span (the documented run + steps + measures) even when only the run has a bar, rather than
   * dropping the steps. Absent when every span already appears in `spans`.
   */
  barlessSpans?: SpanCountsEntry[];
  /** how many spans the `query spans` flood filter (--min-wall/--filter) hid; 0 when no filter was
   * passed. The `query spans` emitter always sets it (0 included), so a filtered result is never a
   * silent cut; optional only because the intermediate builder result omits it before emit. */
  hidden?: number;
  /** the flood filter that produced `spans` (`{}` when none was passed). Set by the `query spans`
   * emitter alongside `hidden`; optional for the same reason. */
  filter?: { minWallMs?: number; labelIncludes?: string };
}

/**
 * The source block `query spans` adds when the target is a RUN-GROUP: which member the overview
 * bar came from, and which members answer the counts/blame axes a single bar cannot. Its presence is
 * what distinguishes a `GroupSpansResult` from a plain `SpansResult` -- a consumer reads the bar as one
 * member's real sample, never as the whole group's, and knows where to drill for the rest.
 */
export interface GroupSpansProvenance {
  /** the run-group's name (its manifest identity) */
  name: string;
  /** the member the overview bar/spans were drawn from */
  overviewFrom: string;
  /** the member that carries exact counts, or null when no member does */
  countsFrom: string | null;
  /** the member that carries forced-layout blame + the event log, or null when none does */
  blameFrom: string | null;
  /** group-level disclosures (count disagreement across members, partial formation) */
  notes: string[];
}

/** `query spans` on a run-group: a `SpansResult` plus the `group` source block. */
export interface GroupSpansResult extends SpansResult {
  group: GroupSpansProvenance;
}

/**
 * The `query spans` output shape: a plain recording yields a `SpansResult`; a run-group yields a
 * `GroupSpansResult`. The presence of the `group` field discriminates the two, so a JSON/TOON consumer
 * branches on it rather than guessing.
 */
export type SpansOutput = SpansResult | GroupSpansResult;

/**
 * One forced (synchronous) layout/style read-site within a span, with the write(s) that dirtied it.
 * The read location is structured (`source` + `line` + `column`), the same shape `query blame
 * --forced` emits (BlameEntry), so a consumer reads the fields directly instead of parsing a
 * `file:line:col` string.
 */
export interface SpanForced {
  /** bare source path/url of the geometry read that forced the flush (no `:line:col`); relative to root for a local file */
  source: string;
  /** 1-based line of the read site; absent when the frame carried no line */
  line?: number;
  /** 1-based column of the read site; absent when the frame carried no column (a line-only sample) */
  column?: number;
  count: number;
  durMs: number;
  /** id of the widest flush at this line for the `query get <eventId>` drill; absent on the chrome
   * --breakdown sampled rows (synthesized id 0, not addressable). See BlameEntry.eventId. */
  eventId?: number;
  /** the mutation(s) that dirtied the DOM so this read forced a flush (chrome --deep only) */
  dirtiedBy?: DirtiedByWrite[];
  /** layout/style scope of the widest flush at this read site (chrome --deep only). See FlushScope. */
  scope?: FlushScope;
}

/**
 * Hot functions within a span's window, on the CPU-sampler SCRIPTING axis (never the bar's `js`
 * slice; see model/recording.ts SpanHot). Three scopes:
 *  - `run-window`: the resolved CpuModel IS the run window (the sampler brackets the whole timed
 *    loop), so a run span reports its own hot list exactly. `pooledSamples` is the model's total
 *    sample count.
 *  - `step-window` / `measure-pooled`: read from the span's stored `SpanHot` refs, resolved to names
 *    via the sibling CpuModel `functions[]`. A step tallies its single iteration-0 window; a measure
 *    pools across `occurrences`. `functions` carry SPAN-LOCAL self time (`selfMs` = samples *
 *    interval, `selfPct` = share of `pooledSamples`); the `id` still indexes the model, so
 *    `query frame <id>` works.
 *
 * `suppressed` is true when the span had fewer than the pooled-sample floor: `functions` is omitted
 * (raise --iterations) rather than a fabricated top-N. A span whose CPU windowing is not
 * reconstructable at its capture-mode/kind reports `hot: null` instead of this shape.
 */
export interface SpanHotFunctions {
  scope: "run-window" | "step-window" | "measure-pooled";
  /** JS self-time the shares denominate on: `run-window` the model's jsSelfMs; else pooledSamples * interval */
  scriptingMs: number;
  /** ranked-JS samples the ranking is built from (`run-window`: the model's total sample count) */
  pooledSamples: number;
  /** occurrences pooled: N for a repeated measure, 1 for run/step */
  occurrences: number;
  /** true when no ranking was emitted: `functions` omitted. `suppressionReason` says why. */
  suppressed?: boolean;
  /**
   * Why a suppressed tally carries no `functions`, so the reader gets the right next step instead of a
   * blanket "raise --iterations":
   *  - `below-floor`: 0 < `pooledSamples` < the floor. A thin-but-real pool; raise --iterations.
   *  - `no-js`: `pooledSamples` 0 and the window ran essentially no JS. Nothing to rank, not an error.
   *  - `not-covered`: `pooledSamples` 0 but the bar attributes real JS to this window, so the sampler
   *    missed it. In driver mode the V8 CPU profiler resets on each cross-document navigation, so a
   *    window that ran before the run's last navigation carries no samples; raising --iterations
   *    cannot recover them.
   * Present only when `suppressed`.
   */
  suppressionReason?: "below-floor" | "no-js" | "not-covered";
  /** top functions by self time, length bounded by `--top`; absent when suppressed. Stored
   * per-span rows carry span-local selfMs/selfPct and no totalMs (a run-wide total beside a
   * span-local self would read as the span's own); the run-window list keeps CpuFunction whole. */
  functions?: (Omit<CpuFunction, "totalMs"> & { totalMs?: number })[];
}

/**
 * `query span <label>` output: one span's full anatomy. `slices` is the reconciling bar's unified
 * shape when the capture mode built one, else null (capture-mode-honest, never fabricated). `counts` are Measured
 * throughout. `forced`/`thrash`/`firefoxDirtiedBy` are present only when an event-log capture mode (chrome
 * --deep, firefox) carried the records they read; `thrash` is the run window's layout-thrashing
 * rollup, chrome --deep only. `hot` is the span-windowed hot functions, or null when the CPU
 * windowing is not reconstructable at this capture-mode/kind (see SpanHotFunctions). Span identity is
 * kind+label; a bare label matching more than one kind is a collision the caller resolves, never a
 * silent join.
 */
export interface SpanAnatomy {
  /** absolute back-pointer to the recording this anatomy was read from */
  recording: string;
  /** the --target axis: chrome | firefox | node */
  target: TargetLane;
  label: string;
  kind: SpanKind;
  aggregation: SpanAggregation;
  /** timed iterations behind this recording (`meta.iterations`) */
  iterations: number;
  /** headline wall (ms). On a STEP span the MEDIAN of its per-iteration walls, not the tiled window
   * (that is `windowMs`); on run/measure spans the tiled window itself. See SpanEntry.wallMs. */
  wallMs: number | null;
  /**
   * The frame-cadence floor this span sits on (a `FrameFloor`, discriminated by `basis`), set only when
   * frame-DOMINATED, so a `--format json` consumer can detect a floored span programmatically rather
   * than parse the human note. A run/measure span floors by its wall VALUE (`wall-multiple`); a driver
   * STEP by its BAR (`work-signal`: sub-frame real work in an idle-dominated window, its wall carrying
   * input dispatch). Absent when the span is real work or the lane declares no floor (headed). The
   * human report surfaces the faster sample / js slice beside it. See docs/dev/frame-floor.md.
   */
  frameFloor?: FrameFloor;
  /** the frame-cadence floor `inpMs` pins to (always `wall-multiple`: INP carries no input-dispatch
   * offset); a floored INP is the frame boundary, not the interaction's own cost (the sub-frame cost
   * is `interaction.processingMs`). Absent when INP is real work, unmeasured, or the lane declares no
   * floor. See SpanAnatomy.frameFloor. */
  inpFrameFloor?: WallMultipleFloor;
  /** the bar's own iteration-0 window (ms) the slices tile, present only on a STEP span (its bar tiles
   * iteration 0, which can diverge from the page-clock median `wallMs`). See SpanEntry.windowMs. */
  windowMs?: number;
  /** real occurrences merged into this span when `aggregation` is `"median"` (a repeated measure) */
  samples?: number;
  wallMinMs?: number;
  wallMaxMs?: number;
  /** the reconciling bar's unified slices; null when this capture mode built no bar for the span */
  slices: UnifiedSlices | null;
  /** carried through when the source breakdown did not fully close (lost events/clock skew) */
  residualMs?: number;
  /** off-thread compositor frame side track (chrome --breakdown only). Display-only. */
  frames?: FrameSideTrack;
  /** per-span layout/style scope distribution (chrome --breakdown; firefox style only); absent when
   * the capture stored none. A count-tier distribution beside the slice ms. See SpanScope. */
  scope?: SpanScope;
  /** exact rendering counts windowed to this span's representative occurrence; Measured throughout */
  counts: SpanCounts;
  /** worst-interaction INP (ms) for a driver step; null when no interaction crossed the 16ms floor */
  inpMs?: number | null;
  /** in-page CWV split of `inpMs` (a driver step); absent when no interaction was observed */
  interaction?: InteractionTiming | null;
  /** Long Animation Frames observed in a driver step's window (Chrome only); absent otherwise. Names
   * the scripts that made a frame slow, so a step attributes to source even with no CPU sampler. */
  loaf?: StepLoaf;
  /** a driver step's navigation classification (none/hard/soft/soft-hash); absent on run/measure spans */
  navigation?: NavigationKind;
  /** the URL the step started on; absent on run/measure spans */
  beforeUrl?: string;
  /** the URL the step ended on; absent on run/measure spans */
  afterUrl?: string;
  /** Chrome's own soft-navigation verdict (default-on Chrome 151), read opportunistically beside
   * `navigation`; absent when the engine fired no entry or the browser has no support. `query span`
   * reconciles it with `navigation` (see model/soft-nav.ts). */
  engineSoftNav?: EngineSoftNav;
  /** How the url+timeOrigin `navigation` classifier and Chrome's `engineSoftNav` heuristic relate
   * (agree / classifier-only / engine-only) with a non-alarmist note. The same reconciliation the human
   * report prints, exposed to `--format json`; absent when there is nothing to reconcile ("none"). See
   * model/soft-nav.ts. */
  softNavAgreement?: SoftNavVerdict;
  /** route-transition metrics (LCP-equivalent / CLS / INP on the route clock) for a step the engine
   * soft-navigated (Chrome 151+), keyed by the soft nav's navigationId; absent otherwise. See SoftNavRoute. */
  softNav?: SoftNavRoute;
  /** boot LCP for a step that started a fresh document (a hard-navigation step); absent otherwise */
  lcp?: StepLcp;
  /** CLS (spec session-window max) with shifting elements attributed, for a driver step (Chrome only);
   * absent on firefox/node, run/measure spans, and steps that observed no qualifying shift */
  layoutShift?: LayoutShift;
  /** forced read-sites in this span's window; present only in an event-log capture mode (chrome/firefox --deep) */
  forced?: SpanForced[];
  /** the layout-thrashing rollup for the run window (chrome --deep only, run span) */
  thrash?: ThrashReport;
  /** firefox --deep dirtied-by write report for this window (Gecko cause stacks, first-invalidation-only) */
  firefoxDirtiedBy?: FirefoxDirtiedByReport;
  /** hot functions within this span's window; null when not reconstructable at this capture-mode/kind */
  hot: SpanHotFunctions | null;
  /**
   * Framework-addon facts for this span, keyed by addon name (`react`, `react-dev`). Present only when
   * a framework addon was active (`--framework auto`) and its factual signals were present for this
   * span; absent otherwise. Additive: a consumer that ignores it reads the anatomy exactly as before.
   * See docs/dev/react-attribution.md.
   */
  addons?: SpanAddons;
  hints: string[];
}

/** One member's own numbers for a stitched span, tagged by its capture mode. Walls are shown PER
 * member and never combined -- a group holds N captures of one workload, not one measurement. */
export interface GroupSpanMember {
  mode: CaptureMode;
  variant?: string;
  wallMs: number | null;
  aggregation: SpanAggregation;
  iterations: number;
}

/** Which member each stitched panel was drawn from, so every number carries its source and trust tier. */
export interface GroupSpanSources {
  slices?: string;
  counts?: string;
  forced?: string;
  hot?: string;
  inp?: string;
}

/**
 * `query span <label>` output on a RUN-GROUP: the stitch. One anatomy view drawing each panel from
 * the member that measures it -- the reconciling bar + hot functions from the breakdown member, the
 * exact counts + forced read-sites + thrash from the deep member -- with every panel tagged in
 * `sources` and each member's own wall listed in `members` (never combined). A group NEVER averages:
 * the bar is ONE member's real reconciling sample, the counts ONE member's exact figures. A panel no
 * member measured is null/absent (a loud gap), never fabricated.
 */
export interface GroupSpanStitch {
  group: string;
  target: TargetLane;
  label: string;
  kind: SpanKind;
  /** each member's own wall for this span, tagged by mode; NEVER combined into one number */
  members: GroupSpanMember[];
  /** which member each panel below came from */
  sources: GroupSpanSources;
  /** the reconciling bar's slices (from the bar member); null when no member built one */
  slices: UnifiedSlices | null;
  residualMs?: number;
  frames?: FrameSideTrack;
  /** per-span layout/style scope distribution (from the bar member); absent when none stored */
  scope?: SpanScope;
  /** exact rendering counts (from the counts member); Measured throughout */
  counts: SpanCounts;
  inpMs?: number | null;
  interaction?: InteractionTiming | null;
  loaf?: StepLoaf;
  /** the step's navigation classification (identical across members: one workload); absent on run/measure */
  navigation?: NavigationKind;
  beforeUrl?: string;
  afterUrl?: string;
  /** Chrome's own soft-navigation verdict (identical across members); absent when none fired */
  engineSoftNav?: EngineSoftNav;
  /** how the classifier and the engine soft-nav verdict relate (see SpanAnatomy.softNavAgreement);
   * absent when there is nothing to reconcile */
  softNavAgreement?: SoftNavVerdict;
  /** route-transition metrics for a soft-navigating step (from whichever member observed them); absent
   * when no engine soft-nav fired. See SoftNavRoute. */
  softNav?: SoftNavRoute;
  /** boot LCP for a hard-navigation step (identical across members); absent otherwise */
  lcp?: StepLcp;
  /** CLS (spec session-window max) with shifting elements attributed, from whichever member observed it
   * (Chrome only); absent when no member observed a shift */
  layoutShift?: LayoutShift;
  /** forced read-sites (from the deep member) */
  forced?: SpanForced[];
  /** the layout-thrashing rollup (chrome --deep member, run span) */
  thrash?: ThrashReport;
  /** firefox --deep dirtied-by write report (from a gecko-deep member) */
  firefoxDirtiedBy?: FirefoxDirtiedByReport;
  /** hot functions (from the CPU-bearing member) */
  hot: SpanHotFunctions | null;
  /** group-level disclosures (count disagreement across members, partial formation), surfaced so a
   * stitched number is never read as agreed when the members did not agree */
  notes: string[];
  hints: string[];
}

/** Per-package self-time delta in a CPU diff. */
export interface CpuPackageDelta {
  package: string;
  baseMs: number;
  currentMs: number;
  delta: number;
}

/** Per-function self-time delta in a CPU diff. */
export interface CpuFunctionDelta {
  fn: string;
  source?: string;
  file?: string;
  package: string;
  baseMs: number;
  currentMs: number;
  delta: number;
}

/**
 * `cpu-diff` output: net JS-self-time delta plus per-package and per-function movers. The gated axis is
 * `netJsSelfMs` (the JS-only headline the per-function/package rows sum to), so a change that is
 * entirely gc/engine/native or sampler noise on the non-idle total cannot trip the gate.
 */
export interface CpuDiffResult {
  baseline: { file: string; jsSelfMs: number };
  current: { file: string; jsSelfMs: number };
  /** per-function deltas below this (ms) are treated as sampling noise */
  noiseMs: number;
  /** current jsSelfMs - baseline jsSelfMs; the axis `--fail-on-regression` gates */
  netJsSelfMs: number;
  netJsSelfPct: number;
  byPackage: CpuPackageDelta[];
  functions: CpuFunctionDelta[];
  /**
   * Disclosures that qualify the gate verdict; empty in the normal case. Carries the resolving-floor
   * note when BOTH sides' jsSelfMs sit below the sampler's resolving power, where the JS-self net gate
   * is quantization-bound and does not fire.
   */
  notes: string[];
}

/**
 * The run-level count/timing fields `diff` compares, one per DiffMetricRow. These are the same field
 * names the run span and meta carry (`layoutCount`, `wallMs`, `jsSelfMs`), so a consumer joins a row
 * to a field by `key` without parsing the human label.
 */
export type DiffMetricKey =
  | "layoutCount"
  | "styleCount"
  | "paintCount"
  | "forcedLayoutCount"
  | "layoutInvalidations"
  | "styleInvalidations"
  | "longTaskCount"
  | "inpMs"
  | "wallMs"
  | "jsSelfMs";

/**
 * One metric row of a `diff`: base and current values with their delta. `base`/`current` keep the
 * Measured contract's `null` when a side did not measure the field (never a fabricated 0), and `delta`
 * is `null` whenever either side is null. `gated` marks a field that participates in
 * `--fail-on-regression` (the exact counts); `regression` is true only for a gated field whose delta
 * worsened, so the advisory rows (INP/wall/JS self) always report `regression: false`.
 */
export interface DiffMetricRow {
  key: DiffMetricKey;
  /** human label, e.g. "forced layout", "INP ms" */
  label: string;
  gated: boolean;
  base: number | null;
  current: number | null;
  /** current - base; null when either side did not measure the field */
  delta: number | null;
  regression: boolean;
}

/**
 * One capture axis that differs between the two diffed recordings. A `blocksGating` axis refuses a
 * `--fail-on-regression` gate, since a delta on it reflects the capture change, not the code.
 */
export interface DiffComparabilityAxis {
  axis: string;
  base: string;
  current: string;
  blocksGating: boolean;
}

/**
 * `diff` output: two recordings compared field-by-field. `metrics` are the run-level count/timing
 * rows; `sliceDeltas` the advisory per-span slice-ms deltas; `comparability` the capture axes that
 * differ. `regressions` lists the gated count rows that worsened, as `"metric: base -> current (+delta)"`.
 * `gateRefusal`, when present, is why a requested `--fail-on-regression` gate could not be evaluated
 * (an incompatible capture, or known-incomplete counts): the gate then exits 1 on the refusal, not on
 * a fabricated verdict. `failed` is the process verdict this view corresponds to (exit 1), so a
 * consumer reads it off the view rather than the exit code. The human report serializes the same data.
 */
export interface DiffView {
  baseline: string;
  current: string;
  comparability: DiffComparabilityAxis[];
  metrics: DiffMetricRow[];
  sliceDeltas: SpanSliceDiff;
  regressions: string[];
  gateRefusal?: string;
  failOnRegression: boolean;
  failed: boolean;
}

/**
 * One member pairing in a `diff` of two run-groups: the per-mode `DiffView` when both groups carry the
 * member, else the side it appeared on (not compared).
 */
export interface GroupDiffMember {
  /** the member's capture-mode + variant label */
  member: string;
  /** the pair diff; absent when the member was on one side only */
  diff?: DiffView;
  /** the side a one-sided member appeared on (not compared); absent when it was paired */
  onlyIn?: "baseline" | "current";
}

/**
 * `diff` output on two RUN-GROUPS: members paired by capture mode + variant, each pair diffed with the
 * same per-recording `DiffView`. `refusal`, when present, is why the whole diff was declined (the two
 * groups measured different workloads). `failed` is the process verdict (exit 1). The presence of
 * `members` (vs a plain `DiffView`) discriminates the two shapes.
 */
export interface GroupDiffView {
  /** the baseline group's name */
  baseline: string;
  /** the current group's name */
  current: string;
  refusal?: string;
  members: GroupDiffMember[];
  failOnRegression: boolean;
  failed: boolean;
}

/**
 * The `diff` output shape: a plain-recording diff yields a `DiffView`; a run-group diff yields a
 * `GroupDiffView`. The presence of the `members` field discriminates the two, so a JSON/TOON consumer
 * branches on it rather than guessing.
 */
export type DiffOutput = DiffView | GroupDiffView;
