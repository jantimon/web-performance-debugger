import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BlameSemantic,
  CpuBreakdown,
  CpuFunction,
  CpuModel,
  EventKind,
  NormalizedEvent,
  Recording,
  RecordingMeta,
  Span,
  SpanCounts,
  SpanHot,
} from "../model/recording.js";
import { matchedFrameFloorMs } from "../model/frame-floor.js";
import type {
  BlameEntry,
  GroupSpanMember,
  GroupSpansProvenance,
  GroupSpanSources,
  GroupSpanStitch,
  SpanAnatomy,
  SpanCountsEntry,
  SpanForced,
  SpanHotFunctions,
  UnifiedSlices,
} from "../model/query.js";
import { MIN_POOLED_HOT_SAMPLES } from "../profile/span-hot.js";
import {
  buildSpans,
  buildSpanCounts,
  recordingLane,
  parseSpanKindLabel,
  filterSpanEntries,
  spanPassesFilter,
  type SpanCountsOverview,
} from "../model/spans.js";
import { isFirefoxDeep, isGeckoCaptureMode } from "../model/capture-mode.js";
import { bold, cyan, dim } from "../output/color.js";
import {
  num,
  table,
  middleEllipsis,
  idleShareSuffix,
  spanWallProvenance,
  LABEL_COL_MAX,
  SOURCE_COL_MAX,
} from "../output/ascii.js";
import { analyzeThrash } from "../trace/thrash.js";
import { firefoxDirtiedBy } from "../trace/firefox-dirtied.js";
import { forcedLayouts } from "../trace/analysis.js";
import { findSteps } from "../trace/parse.js";
import { deserialize, serialize, isFormat, type Format } from "../output/format.js";
import { assertRecordingArtifact } from "../model/artifact.js";
import { printSpanBreakdowns, printCpuBreakdown } from "./cpu.js";
import { loadCpuModel, shortSource } from "../profile/cpuprofile.js";
import { resolveTarget, hintTarget, resolveConsumption } from "./resolve.js";
import {
  assertMemberMode,
  loadGroup,
  loadMemberRecording,
  memberLabel,
  memberRecordingPath,
  resolveVerbTarget,
  routingNote,
} from "./group.js";
import { pickMember, type GroupMember, type RunGroup } from "../model/group.js";
import { formatMeasured, type Measured } from "../model/measured.js";
import { usToMs } from "../model/time.js";
import { EVENT_KINDS, isEventKind } from "../trace/classify.js";

interface OutOpts {
  json?: boolean;
  format?: string;
}

async function load(file: string): Promise<Recording> {
  const abs = await resolveTarget(file, "recording");
  const raw = await fs.readFile(abs, "utf8");
  const rec = deserialize(raw, path.extname(abs).toLowerCase()) as Recording;
  assertRecordingArtifact(rec, abs);
  return rec;
}

function structuredFormat(opts: OutOpts): Format | null {
  if (opts.format) {
    if (!isFormat(opts.format)) throw new Error("--format must be json or toon");
    return opts.format;
  }
  return opts.json ? "json" : null;
}

/**
 * Load a recording for an event-log verb (events/get/blame), routing a run-group to the member that
 * carries the event log (chrome --deep, or any firefox gecko member) and disclosing the routing in
 * human output. A group with no such member fails loudly in resolveVerbTarget, never a silent empty
 * result.
 */
async function loadEventLogTarget(file: string, opts: OutOpts): Promise<Recording> {
  const routed = await resolveVerbTarget(
    file,
    "blame",
    "the event log (forced-layout blame / events)",
  );
  const rec = await load(routed.target);
  const routeLine = routingNote(routed, "the event log");
  if (routeLine && !structuredFormat(opts)) console.log(dim(routeLine));
  return rec;
}

function emit(value: unknown, fmt: Format): void {
  console.log(serialize(value, fmt));
}

function eventsInWindow(rec: Recording): NormalizedEvent[] {
  const start = rec.window.startTs;
  return rec.events.filter((event) => start == null || event.ts >= start);
}

/**
 * The deep event log (`rec.events`) is stored only where a reader consumes it: --deep (chrome) and
 * firefox. In every other capture mode it is empty by design, so `query events`/`get`/`blame` say "not
 * captured in this capture mode" rather than reporting an empty result as if the page did nothing. A --deep
 * run that genuinely observed nothing still has the log (it just came back empty), so the capture mode,
 * not the array length, is the test.
 */
function requireEventLog(rec: Recording, file: string): void {
  // --breakdown stores a SAMPLED read-site blame log (edge marks + sampled forced Layout/RecalcStyles
  // events), so blame/events/get read it there too; the full invalidation event log is still --deep/firefox.
  if (
    rec.meta.passes.includes("deep") ||
    rec.meta.passes.includes("breakdown") ||
    isGeckoCaptureMode(rec.meta.passes)
  )
    return;
  throw new Error(
    `${file}: the event log was not captured in this capture mode (${rec.meta.passes.join("+")}). Events, ` +
      `forced-layout blame, and invalidation records are stored under --deep (chrome), --breakdown ` +
      `(chrome, sampled read-site blame only), or --target firefox. Re-record with --deep for the full log.`,
  );
}

/** How many hot functions a span anatomy lists before a `--top` override. */
const DEFAULT_SPAN_HOT = 15;
/** How many forced read-sites / thrash writes the human anatomy prints before eliding the rest. */
const ANATOMY_FORCED_CAP = 12;

export interface SpanQuery extends OutOpts {
  /** how many hot functions to include in the span's window (default DEFAULT_SPAN_HOT) */
  top?: number;
  /** list each dropped/smoothness-affecting frame under the bar (default: a one-line count) */
  frames?: boolean;
}

/**
 * The trace-clock window of one span, recovered from the stored event log so forced read-sites can be
 * scoped to the span. The run window is `rec.window`; a step's edges are its `wpd:step:N:start|end`
 * marks; a user measure's are its first in-window `performance.measure` begin/end. Falls back to the
 * run window when the span's own marks are not in this log (a capture mode with no event log never
 * reaches here). endTs null leaves the window open-ended, which the start-onward `forcedLayouts` handles.
 */
function spanWindow(rec: Recording, span: Span): { startTs: number | null; endTs: number | null } {
  if (span.kind === "step" && span.index != null) {
    const match = findSteps(rec.events).find((step) => step.index === span.index);
    if (match) return { startTs: match.startTs, endTs: match.endTs };
  }
  if (span.kind === "measure") {
    const win = measureWindow(rec.events, span.label, rec.window.startTs, rec.window.endTs);
    if (win) return win;
  }
  return { startTs: rec.window.startTs, endTs: rec.window.endTs };
}

/** First in-window occurrence of a user `performance.measure` label as a trace-clock window. */
function measureWindow(
  events: NormalizedEvent[],
  label: string,
  runStart: number | null,
  runEnd: number | null,
): { startTs: number; endTs: number } | null {
  const begins: number[] = [];
  for (const event of events) {
    if (event.kind !== "usertiming" || event.name !== label) continue;
    if (event.ph === "b") begins.push(event.ts);
    else if (event.ph === "e") {
      const startTs = begins.shift();
      if (startTs == null) continue;
      if (runStart != null && startTs < runStart) continue;
      if (runEnd != null && event.ts > runEnd) continue;
      return { startTs, endTs: event.ts };
    }
  }
  return null;
}

/**
 * `query span <label>`: one span's full anatomy. `<label>` is a bare label (matched across kinds) or a
 * `kind:label` qualifier, since span identity is kind+label; a bare label that matches more than one
 * kind is a collision the caller resolves rather than a silent join. The anatomy carries the bar (when
 * the capture mode built one, else capture-mode-honest null), the wall/aggregation/samples/spread, the
 * Measured counts, INP/interaction when the span had one, the forced-layout read-sites + dirtied-by
 * writes + thrash rollup an event-log capture mode (chrome --deep, firefox) captured, and the hot functions within the
 * span's window (run span only; per-step/measure windowing is not reconstructable at read time).
 */
export async function querySpan(file: string, label: string, query: SpanQuery): Promise<void> {
  // A run-group STITCHES one span across its members (bar+hot from the breakdown member, counts+forced
  // from the deep member); a plain recording renders the single-member anatomy below.
  const consumption = await resolveConsumption(file);
  if (consumption.kind === "group")
    return void (await querySpanGroup(consumption.path, label, query));
  const abs = consumption.path;
  const rec = await load(abs);

  const qualifier = parseSpanKindLabel(label);
  const wantedLabel = qualifier?.label ?? label;
  const wantedKind = qualifier?.kind;
  const matches = rec.spans.filter(
    (span) => span.label === wantedLabel && (wantedKind == null || span.kind === wantedKind),
  );
  if (!matches.length) {
    const available = rec.spans.map((span) => `${span.kind}:${span.label}`).join(", ");
    throw new Error(
      `No span '${label}' in ${file}. Available: ${available || "(none)"}. List them with ` +
        `\`query spans ${file}\`.`,
    );
  }
  if (matches.length > 1) {
    // Span identity is kind+label; a bare label matching more than one kind is a collision the caller
    // resolves by qualifying `kind:label`, never a silent join on the label alone.
    const forms = matches.map((span) => `${span.kind}:${span.label}`).join(", ");
    throw new Error(
      `'${label}' matches ${matches.length} spans of different kinds in ${file}: ${forms}. Re-run ` +
        `with the qualified form, e.g. \`query span ${file} ${matches[0].kind}:${wantedLabel}\`.`,
    );
  }

  const span = matches[0];
  const model = await tryLoadCpuModel(abs);
  // Drill-in hints get the friendly target (`latest` when this IS the latest, else a cwd-relative
  // path) so a pasted command carries no absolute home/scratch path; the stored `recording`
  // back-pointer stays absolute for cwd-independent reopening.
  const hintPath = await hintTarget(abs);
  const anatomy = buildSpanAnatomy(rec, abs, span, model, query.top ?? DEFAULT_SPAN_HOT, hintPath);

  const fmt = structuredFormat(query);
  if (fmt) return emit(anatomy, fmt);
  printSpanAnatomy(anatomy, span, model, rec.meta, query.frames ?? false);
}

/** Load the sibling CPU model if one exists; a missing/absent model is not an error for the anatomy.
 * Only the "no model here" case (ENOCPUMODEL) is swallowed: a corrupt or unreadable sibling surfaces
 * rather than masquerading as "no CPU model", which would read as a capture mode that never sampled. */
async function tryLoadCpuModel(recordingPath: string): Promise<CpuModel | undefined> {
  try {
    return await loadCpuModel(recordingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOCPUMODEL") throw error;
    return undefined;
  }
}

/** Assemble one span's anatomy from the recording, its sibling CPU model, and the event-log records. */
function buildSpanAnatomy(
  rec: Recording,
  recordingPath: string,
  span: Span,
  model: CpuModel | undefined,
  topN: number,
  hintPath: string,
): SpanAnatomy {
  const iterations = rec.meta.iterations ?? 1;
  const target = recordingLane(rec.meta);

  // Unified slices: prefer the stored bar; a run span with no stored bar falls back to the sibling
  // CpuModel run bar (the same source rule as `query spans`). null when this capture mode built no bar.
  const spansResult = buildSpans(rec.spans, model?.breakdown, target, iterations);
  const entry = spansResult?.spans.find(
    (candidate) => candidate.label === span.label && candidate.kind === span.kind,
  );

  // Forced read-sites, thrash, and the firefox write report come from the deep event log, scoped to
  // this span's window. Absent in every capture mode that captured no log (the empty array is that lane's
  // "not captured", so the capture mode gates it, not the array length).
  // --breakdown carries the sampled read-site blame log (with edge marks so a step/measure window
  // resolves), so forced read-sites surface there too; thrash/dirtied stay --deep (they need the
  // invalidation records --breakdown drops).
  const hasEventLog =
    rec.meta.passes.includes("deep") ||
    rec.meta.passes.includes("breakdown") ||
    isGeckoCaptureMode(rec.meta.passes);
  let forced: SpanForced[] | undefined;
  let thrash: SpanAnatomy["thrash"];
  let firefoxDirtied: SpanAnatomy["firefoxDirtiedBy"];
  if (hasEventLog) {
    const window = spanWindow(rec, span);
    const windowed = rec.events.filter((event) => window.endTs == null || event.ts <= window.endTs);
    // The dirtied-by write map (chrome --deep) is run-level and keyed by the read-site `at`, so it
    // annotates whichever windowed read-sites resolved a write; thrash is a run-window interleave, so
    // it rides only the run span.
    const thrashAnalysis = rec.meta.passes.includes("deep")
      ? analyzeThrash(rec.events, rec.window.startTs)
      : null;
    const dirtiedByReadSite = thrashAnalysis?.dirtiedByReadSite ?? {};
    forced = forcedLayouts(windowed, window.startTs).map((group) => {
      const dirtiedBy = dirtiedByReadSite[group.at];
      return dirtiedBy?.length
        ? { at: group.at, count: group.count, durMs: group.durMs, dirtiedBy }
        : { at: group.at, count: group.count, durMs: group.durMs };
    });
    if (span.kind === "run" && thrashAnalysis) thrash = thrashAnalysis.report;
    if (isFirefoxDeep(rec.meta.passes))
      firefoxDirtied = firefoxDirtiedBy(windowed, window.startTs) ?? undefined;
  }

  // Hot functions within the span window, on the CPU-sampler scripting axis. The run span reads them
  // from the resolved CpuModel (which IS the run window); a step/measure span reads its stored
  // `SpanHot` refs and resolves names via the sibling model. A capture-mode/kind with neither reports null.
  let hot: SpanHotFunctions | null = null;
  if (span.kind === "run" && model)
    hot = {
      scope: "run-window",
      scriptingMs: model.jsSelfMs,
      pooledSamples: model.sampleCount,
      occurrences: 1,
      functions: model.functions.slice(0, topN),
    };
  else if (span.hot && model)
    hot = resolveStoredHot(span.hot, model, topN, span.breakdown?.slices.js.ms ?? 0);

  const hints: string[] = [];
  if (hasEventLog) {
    hints.push(`Forced-layout source lines: wpd query blame ${hintPath} --forced`);
    hints.push(`Drill an event by id: wpd query get ${hintPath} <id>`);
  }
  if (model && span.kind !== "run" && !span.hot)
    hints.push(`Run-window hot functions: wpd query cpu ${hintPath}`);
  // Only suggest `query spans` when this capture mode actually has a bar/CpuModel for it to fold; in the
  // default/--deep capture modes it would error, so a not-available hint would send the reader in a circle.
  if (spansResult) hints.push(`All spans at a glance: wpd query spans ${hintPath}`);

  const residualMs = entry?.residualMs ?? span.breakdown?.residualMs;
  return {
    recording: recordingPath,
    target,
    label: span.label,
    kind: span.kind,
    aggregation: entry?.aggregation ?? span.aggregation,
    iterations,
    wallMs: entry?.wallMs ?? span.wallMs,
    ...(span.samples != null ? { samples: span.samples } : {}),
    ...(span.wallMinMs != null ? { wallMinMs: span.wallMinMs } : {}),
    ...(span.wallMaxMs != null ? { wallMaxMs: span.wallMaxMs } : {}),
    slices: entry?.slices ?? null,
    ...(residualMs != null ? { residualMs } : {}),
    ...(span.frames ? { frames: span.frames } : {}),
    counts: span.counts,
    ...(span.inpMs != null ? { inpMs: span.inpMs } : {}),
    ...(span.interaction ? { interaction: span.interaction } : {}),
    ...(span.loaf ? { loaf: span.loaf } : {}),
    ...(forced ? { forced } : {}),
    ...(thrash ? { thrash } : {}),
    ...(firefoxDirtied ? { firefoxDirtiedBy: firefoxDirtied } : {}),
    hot,
    hints,
  };
}

/**
 * Resolve a span's stored hot refs (`SpanHot`, step/measure) to displayable functions via the sibling
 * CpuModel. Each ref's `id` indexes `model.functions[]` for the name/source/package; the self time is
 * SPAN-LOCAL (`selfMs` = ref samples * interval, `selfPct` = share of the span's pooled samples), so
 * the panel denominates on the span's own scripting samples, never the run-wide model. `scriptingMs`
 * is the span's pooled scripting self-time (pooledSamples * interval). A suppressed tally yields no
 * `functions` and carries a `suppressionReason` (see hotSuppressionReason) so the reader knows
 * whether more iterations help.
 */
/**
 * Why a `pooledSamples`-below-floor tally names no functions, so the reader is pointed at the right
 * fix rather than a blanket "raise --iterations". A nonzero-but-thin pool is `below-floor` (more
 * iterations stabilises it). A ZERO pool is either `no-js` (the window ran essentially no JS, nothing
 * to rank) or `not-covered` (the bar attributes real JS here but the sampler recorded none of it):
 * the split is whether the window's js ms could plausibly have landed a sample. `not-covered` is the
 * navigation gap -- the V8 CPU profiler resets on each cross-document navigation, so a window before
 * the run's last navigation carries no samples -- where raising --iterations cannot help.
 */
export function hotSuppressionReason(
  pooledSamples: number,
  jsMs: number,
  sampleIntervalUs: number,
): "below-floor" | "no-js" | "not-covered" {
  if (pooledSamples > 0) return "below-floor";
  // Expected samples for a window that WAS covered: its js ms over the sampler period. Two or more
  // expected but none observed means the sampler did not run over this window, not bad luck.
  const intervalMs = usToMs(sampleIntervalUs);
  return intervalMs > 0 && jsMs / intervalMs >= 2 ? "not-covered" : "no-js";
}

function resolveStoredHot(
  stored: SpanHot,
  model: CpuModel,
  topN: number,
  jsMs: number,
): SpanHotFunctions {
  const scriptingMs = usToMs(stored.pooledSamples * model.sampleIntervalUs);
  const base: SpanHotFunctions = {
    scope: stored.scope,
    scriptingMs,
    pooledSamples: stored.pooledSamples,
    occurrences: stored.occurrences,
  };
  if (stored.suppressed || !stored.functions)
    return {
      ...base,
      suppressed: true,
      suppressionReason: hotSuppressionReason(stored.pooledSamples, jsMs, model.sampleIntervalUs),
    };
  const functions: (Omit<CpuFunction, "totalMs"> & { totalMs?: number })[] = stored.functions
    .slice(0, topN)
    .map((ref) => {
      const selfPct = stored.pooledSamples > 0 ? (ref.samples / stored.pooledSamples) * 100 : 0;
      const resolved = model.functions[ref.id];
      // The id is the run's frame rank, computed from the same profile, so this lookup hits; the
      // fallback only guards a truncated/foreign model rather than inventing an owner.
      if (!resolved)
        return {
          id: ref.id,
          fn: "(unresolved)",
          package: "(native)",
          selfMs: ref.selfMs,
          selfPct,
        };
      // resolved.totalMs is run-wide; beside a span-local selfMs it would read as the span's own
      // total, so stored-hot rows omit it.
      const { totalMs: _runWideTotal, ...spanLocal } = resolved;
      return { ...spanLocal, selfMs: ref.selfMs, selfPct };
    });
  return { ...base, functions };
}

/** Human report for `query span`: the bar, wall/counts/interaction, forced attribution, hot list. */
function printSpanAnatomy(
  anatomy: SpanAnatomy,
  span: Span,
  model: CpuModel | undefined,
  meta: RecordingMeta,
  showFrames: boolean,
): void {
  const count = (value: Measured<number>): string =>
    formatMeasured(value, (measured) => String(measured));
  console.log(
    `\nspan ${bold(middleEllipsis(anatomy.label, LABEL_COL_MAX))} ${dim(`(${anatomy.kind} · ${anatomy.target} · ${anatomy.aggregation} of ${anatomy.iterations} iteration(s))`)}`,
  );
  const wall = anatomy.wallMs == null ? "—" : `${num(anatomy.wallMs)} ms`;
  const spread =
    anatomy.samples != null && anatomy.wallMinMs != null && anatomy.wallMaxMs != null
      ? dim(
          ` · ${anatomy.samples} samples, wall ${num(anatomy.wallMinMs, 1)}..${num(anatomy.wallMaxMs, 1)} ms`,
        )
      : "";
  // Point-of-use provenance on the wall itself, each firing only where the bare number misleads: a
  // step's wall is a MEDIAN (its header aggregation "first" describes the counts/bar window, not this
  // number), and a settle-dominated window's width reads as workload unless its idle share sits beside
  // it. The idle tag rides only a span whose wall IS the tiled bar window (idleShareSuffix's contract).
  const wallTags: string[] = [];
  const stepMedian = spanWallProvenance(anatomy.kind, span.perIteration?.length ?? 0);
  if (stepMedian) wallTags.push(stepMedian);
  if (span.breakdown) {
    const idleTag = idleShareSuffix(span.breakdown.slices.idle.ms, span.breakdown.wallMs);
    if (idleTag) wallTags.push(`${idleTag} (window, not work)`);
  }
  const wallTail = wallTags.length ? dim(` · ${wallTags.join(" · ")}`) : "";
  console.log(`wall: ${bold(wall)}${spread}${wallTail}`);
  // A wall pinned to a frame-cadence floor hides sub-frame work: libraries whose real re-render is
  // each under the floor all report the floor (a measure floors at one frame, a driver step at the
  // 2-rAF settle, docs/dev/frame-floor.md). Surface the faster sample and the js slice beside it so
  // the floored number is not read as "no difference". "frame floor", not "one-frame", since the
  // step case is two frames.
  const wallFloor = matchedFrameFloorMs(anatomy.wallMs, meta);
  if (wallFloor != null) {
    const minMs = span.stats?.minMs ?? span.wallMinMs;
    const belowFloor: string[] = [];
    if (minMs != null && minMs < anatomy.wallMs! - 0.5)
      belowFloor.push(`min sample ${num(minMs, 1)} ms`);
    if (anatomy.slices?.js) belowFloor.push(`js ${num(anatomy.slices.js.ms, 1)} ms`);
    const detail = belowFloor.length ? `; sub-frame work reads on ${belowFloor.join(" / ")}` : "";
    console.log(
      dim(`  wall sits on the ~${num(wallFloor, 1)} ms frame floor${detail} (frame-floor.md)`),
    );
  }

  // The reconciling bar, when the capture mode built one. A stored bar prints the seven-slice per-span
  // table; a run span with only the sibling CpuModel bar prints that (four/six slices, honestly labelled).
  if (span.breakdown) printSpanBreakdowns([span], anatomy.iterations, meta.browser, showFrames);
  else if (span.kind === "run" && model?.breakdown) printCpuBreakdown(model, anatomy.iterations);
  else
    console.log(
      dim("\n(no reconciling bar in this capture mode; record with --breakdown for one)"),
    );

  console.log("\nRendering counts (Measured: — = not measured in this capture mode, never 0)\n");
  console.log(
    table(
      ["metric", "count"],
      [
        ["layout", count(anatomy.counts.layoutCount)],
        ["style recalc", count(anatomy.counts.styleCount)],
        ["paint", count(anatomy.counts.paintCount)],
        ["forced layout/style", count(anatomy.counts.forcedLayoutCount)],
        ["layout invalidations", count(anatomy.counts.layoutInvalidations)],
        ["style invalidations", count(anatomy.counts.styleInvalidations)],
        ["long tasks ≥50ms", count(anatomy.counts.longTaskCount)],
      ],
    ),
  );
  // Firefox forced counts come from the Reflow/Styles markers, and the read that forced each flush is
  // a sampled estimate: a cheap read can be missed, so `query blame --forced` can locate fewer sites
  // than the count (or none). Say so, so a count with no locatable site is not read as a contradiction.
  const firefoxForced = anatomy.counts.forcedLayoutCount;
  if (meta.browser === "firefox" && firefoxForced != null && firefoxForced > 0)
    console.log(
      dim(
        "\nforced layout/style is marker-derived; the read that forced each flush is a sampled estimate (query blame --forced) that can miss cheap reads, so the located sites can number fewer than the count.",
      ),
    );
  // The chrome run counts and the run bar cover different windows, on purpose, so disclose it where
  // both are on screen. Counts are start-onward from run:start with no upper bound, so a paint the
  // run commits just after run:end (the trailing frame paints on the next tick) is counted; the bar
  // above tiles [run:start, run:end] exactly, so its slice ms stop at run:end. A run count can
  // therefore exceed what its bar slice suggests. Step spans are windowed to their own marks and do
  // not have this gap. Firefox is excluded: the gecko lane windows its markers bounded on both sides
  // and reports paint as not-measured, so the start-onward claim is not true there.
  if (anatomy.kind === "run" && span.breakdown && anatomy.target !== "firefox")
    console.log(
      dim(
        "\ncounts are windowed start-onward from run:start (through the settle drain), so a paint/layout the run commits just after run:end is counted; the bar above tiles [run:start, run:end] only, so a count can exceed its slice ms.",
      ),
    );
  // A measure span carries a reconciling bar (real style/layout/paint slice ms) but no counts: counts
  // window to the run/steps, never to an arbitrary user-measure window. Without this the bar's slice
  // ms beside an all-"—" counts table read as a contradiction. Gated on the rendering slices actually
  // summing above 0, so an all-idle bar (no style/layout/paint to reconcile against) prints no note
  // rather than claiming ms it did not measure. Say it, rather than fabricate counts.
  const renderingSliceMs = span.breakdown
    ? span.breakdown.slices.style.ms +
      span.breakdown.slices.layout.ms +
      (span.breakdown.slices.paint?.ms ?? 0)
    : 0;
  if (
    anatomy.kind === "measure" &&
    span.breakdown &&
    anatomy.target !== "firefox" &&
    anatomy.counts.layoutCount == null &&
    renderingSliceMs > 0
  )
    console.log(
      dim(
        "\ncounts are not windowed to a performance.measure span (they scope to the run/steps), so they read — here even though the bar above measured real style/layout/paint ms in this window.",
      ),
    );

  if (anatomy.inpMs != null || anatomy.interaction) {
    const inp = anatomy.inpMs == null ? "—" : `${num(anatomy.inpMs)} ms`;
    console.log(`\nINP (worst interaction): ${bold(inp)}`);
    if (anatomy.interaction) {
      const { inputDelayMs, processingMs, presentationDelayMs } = anatomy.interaction;
      console.log(
        dim(
          `  input delay ${num(inputDelayMs, 2)} ms · processing ${num(processingMs, 2)} ms · presentation ${num(presentationDelayMs, 2)} ms`,
        ),
      );
    }
    // A floored INP is the frame boundary, not the interaction's own cost; point at the sub-frame
    // signal (the processing split above, the js slice) so it is not read as "every tech is equal".
    const inpFloor = matchedFrameFloorMs(anatomy.inpMs, meta);
    if (inpFloor != null) {
      const signal = anatomy.interaction
        ? "the processing split above"
        : anatomy.slices?.js
          ? `js ${num(anatomy.slices.js.ms, 1)} ms`
          : null;
      const detail = signal ? `; the sub-frame cost is ${signal}` : "";
      console.log(dim(`  INP sits on the ~${num(inpFloor, 1)} ms one-frame floor${detail}`));
    }
  }

  if (anatomy.loaf?.frames.length) {
    const loaf = anatomy.loaf;
    console.log(
      `\nLong animation frames: ${bold(String(loaf.observedFrames))} ${dim(
        `(${num(loaf.totalDurationMs, 1)} ms total, ${num(loaf.totalBlockingMs, 1)} ms blocking over the 50ms budget)`,
      )}`,
    );
    console.log(dim("  scripts the browser blamed (source url is the served script, not a line):"));
    for (const frame of loaf.frames) {
      console.log(`  frame ${num(frame.durationMs, 1)} ms:`);
      for (const script of frame.scripts) {
        const forced =
          script.forcedStyleLayoutMs > 0
            ? dim(` · ${num(script.forcedStyleLayoutMs, 1)} ms forced style/layout`)
            : "";
        const name = script.sourceFunctionName ? ` ${script.sourceFunctionName}` : "";
        console.log(
          `    ${num(script.durationMs, 1)} ms  ${script.invoker}${name} ${dim(`(${script.invokerType})`)}`,
        );
        console.log(`      ${dim(script.sourceURL || "(no source url)")}${forced}`);
      }
      if (!frame.scripts.length) console.log(dim("    (no script attribution)"));
    }
  }

  if (anatomy.forced?.length) {
    console.log("\nForced layout/style by source (read that forced the flush):\n");
    const shown = anatomy.forced.slice(0, ANATOMY_FORCED_CAP);
    console.log(
      table(
        ["count", "ms", "source"],
        shown.map((entry) => [
          entry.count,
          num(entry.durMs, 2),
          middleEllipsis(entry.at, SOURCE_COL_MAX),
        ]),
      ),
    );
    const withWrites = shown.filter((entry) => entry.dirtiedBy?.length);
    if (withWrites.length) {
      console.log(dim("\n  dirtied-by (the write that forced each read):"));
      for (const entry of withWrites) {
        console.log(`  ${entry.at}`);
        for (const write of entry.dirtiedBy!)
          console.log(
            `    ${dim("↳ dirtied by")} ${write.at}${write.reason ? dim(` (${write.reason})`) : ""}`,
          );
      }
    }
    if (anatomy.forced.length > shown.length)
      console.log(dim(`  … +${anatomy.forced.length - shown.length} more source(s)`));
  }

  if (anatomy.thrash && anatomy.thrash.count > 0)
    console.log(
      `\n⚠ layout thrashed ${bold(`${anatomy.thrash.count}x`)} during the run ${dim("(query blame --forced for the full interleave)")}`,
    );

  if (anatomy.firefoxDirtiedBy) {
    console.log(
      "\ndirtied-by (first invalidation only) — the write Gecko blames for each forced flush:",
    );
    console.log(
      dim(
        "  not Chrome's full write set. Read side: query blame --forced; full report: query blame --dirtied.",
      ),
    );
    for (const write of anatomy.firefoxDirtiedBy.writes.slice(0, ANATOMY_FORCED_CAP))
      console.log(`    ${write.at}  ${dim(`(${write.kinds.join(",")} ×${write.count})`)}`);
  }

  if (anatomy.hot) {
    const hot = anatomy.hot;
    const where =
      hot.scope === "measure-pooled"
        ? `across ${hot.occurrences} occurrence(s)`
        : hot.scope === "step-window"
          ? "in the iteration-0 window"
          : "in the run window";
    if (hot.suppressed) {
      // pooledSamples 0 must NOT say "raise --iterations": more iterations of an un-sampled window
      // stay un-sampled. Split by why the pool is empty (see hotSuppressionReason).
      const message =
        hot.suppressionReason === "not-covered"
          ? `\nHot functions: none — the reconciling bar attributes ${num(anatomy.slices?.js.ms ?? 0, 1)} ms of JS ${where}, but the CPU sampler recorded no samples in it. The V8 profiler resets on each cross-document navigation, so a window that ran before the run's last navigation is not sampled; raising --iterations cannot recover it.`
          : hot.suppressionReason === "no-js"
            ? `\nHot functions: none — this window ran no measurable JS ${where}.`
            : `\nHot functions: suppressed — only ${hot.pooledSamples} pooled JS sample(s) ${where} (below the ${MIN_POOLED_HOT_SAMPLES}-sample floor). Raise --iterations for a stable ranking.`;
      console.log(dim(message));
    } else if (!hot.functions?.length) {
      console.log(
        dim(
          `\nHot functions: ${hot.pooledSamples} pooled JS sample(s) ${where}, none above the per-function floor.`,
        ),
      );
    } else {
      console.log(
        `\nHot functions in this span ${dim(`(${hot.scope}, ${where}, ${num(hot.scriptingMs, 1)} ms JS self over ${hot.pooledSamples} sample(s))`)}. self % is the share of the span's pooled JS samples. Drill with ${cyan("`query frame <id>`")}:\n`,
      );
      console.log(
        table(
          ["id", "self ms", "self %", "package", "function (source)"],
          hot.functions.map((fn) => [
            dim(String(fn.id)),
            num(fn.selfMs, 1),
            `${num(fn.selfPct, 1)}%`,
            cyan(fn.package),
            `${fn.fn}${fn.file ? ` ${dim(`(${shortSource(fn.file, fn.source)})`)}` : ""}`,
          ]),
        ),
      );
    }
  } else if (span.kind !== "run") {
    const pointer = model ? " Use `query cpu` for the run-window hot list." : "";
    // Firefox drives steps through the one gecko pass, which windows hot samples for measures
    // only; pointing at --breakdown there would name a flag the lane refuses.
    const remedy =
      anatomy.target === "firefox"
        ? "step spans carry no hot list on firefox; wrap the work in a performance.measure"
        : "record with --breakdown for per-span hot functions";
    console.log(dim(`\nHot functions: not available in this capture mode (${remedy}).${pointer}`));
  }

  if (anatomy.hints.length) {
    console.log("");
    for (const hint of anatomy.hints) console.log(dim(`  • ${hint}`));
  }
}

/** An all-not-measured SpanCounts, for a stitch whose group has no counting member. */
function emptySpanCounts(): SpanCounts {
  return {
    layoutCount: null,
    styleCount: null,
    paintCount: null,
    forcedLayoutCount: null,
    layoutInvalidations: null,
    styleInvalidations: null,
    longTaskCount: null,
  };
}

/**
 * `query span <label>` on a run-group: the stitch. Draws each panel from the member that measures it,
 * tags every panel with its source member, and lists each member's own wall separately (never
 * combined). A panel no member measured is null/absent (a loud gap), never fabricated or averaged.
 */
async function querySpanGroup(
  manifestPath: string,
  label: string,
  query: SpanQuery,
): Promise<void> {
  const group = await loadGroup(manifestPath);
  const stitch = await buildGroupSpanStitch(
    manifestPath,
    group,
    label,
    query.top ?? DEFAULT_SPAN_HOT,
  );
  const fmt = structuredFormat(query);
  if (fmt) return emit(stitch, fmt);
  printGroupSpanStitch(stitch);
}

async function buildGroupSpanStitch(
  manifestPath: string,
  group: RunGroup,
  label: string,
  topN: number,
): Promise<GroupSpanStitch> {
  const qualifier = parseSpanKindLabel(label);
  const wantedLabel = qualifier?.label ?? label;
  const wantedKind = qualifier?.kind;

  // Build each member's OWN anatomy of the span (skip a member that has no such span). Reuses the
  // single-recording buildSpanAnatomy, so each member's numbers are exactly what `query span` on that
  // member would report -- the stitch only chooses which member's panel to surface.
  const perMember = new Map<GroupMember, SpanAnatomy>();
  for (const member of group.members) {
    const abs = memberRecordingPath(manifestPath, member);
    const rec = await loadMemberRecording(manifestPath, member);
    const matches = rec.spans.filter(
      (span) => span.label === wantedLabel && (wantedKind == null || span.kind === wantedKind),
    );
    if (matches.length > 1) {
      const forms = matches.map((span) => `${span.kind}:${span.label}`).join(", ");
      throw new Error(
        `'${label}' matches ${matches.length} spans of different kinds in member '${memberLabel(member)}': ` +
          `${forms}. Re-run with the qualified form, e.g. ${matches[0].kind}:${wantedLabel}.`,
      );
    }
    if (!matches.length) continue;
    const model = await tryLoadCpuModel(abs);
    perMember.set(member, buildSpanAnatomy(rec, abs, matches[0], model, topN, "latest"));
  }
  if (perMember.size === 0) {
    const first = await loadMemberRecording(manifestPath, group.members[0]);
    const available = first.spans.map((span) => `${span.kind}:${span.label}`).join(", ");
    throw new Error(
      `No span '${label}' in run-group '${group.meta.name}'. Available: ${available || "(none)"}. ` +
        `List them with \`query spans latest\`.`,
    );
  }

  const anatomyOf = (member: GroupMember | null): SpanAnatomy | undefined =>
    member ? perMember.get(member) : undefined;
  const kind = [...perMember.values()][0].kind;
  const target = [...perMember.values()][0].target;

  const barMember = pickMember(group, "slice-bar");
  const countsMember = pickMember(group, "counts");
  const forcedMember = pickMember(group, "forced");
  const cpuMember = pickMember(group, "cpu");
  const inpMember = pickMember(group, "inp");

  const barAnatomy = anatomyOf(barMember);
  const countsAnatomy = anatomyOf(countsMember);
  const forcedAnatomy = anatomyOf(forcedMember);
  const cpuAnatomy = anatomyOf(cpuMember);
  const inpAnatomy = anatomyOf(inpMember);

  const slices = barAnatomy?.slices ?? null;
  const counts = countsAnatomy?.counts ?? emptySpanCounts();
  const hot = cpuAnatomy?.hot ?? null;

  const members: GroupSpanMember[] = group.members
    .map((member): GroupSpanMember | null => {
      const anatomy = perMember.get(member);
      if (!anatomy) return null;
      return {
        mode: member.mode,
        ...(member.variant ? { variant: member.variant } : {}),
        wallMs: anatomy.wallMs,
        aggregation: anatomy.aggregation,
        iterations: anatomy.iterations,
      };
    })
    .filter((entry): entry is GroupSpanMember => entry != null);

  const sources: GroupSpanSources = {
    ...(slices != null && barMember ? { slices: memberLabel(barMember) } : {}),
    ...(countsAnatomy && countsMember ? { counts: memberLabel(countsMember) } : {}),
    ...(forcedAnatomy?.forced && forcedMember ? { forced: memberLabel(forcedMember) } : {}),
    ...(hot != null && cpuMember ? { hot: memberLabel(cpuMember) } : {}),
    ...(inpAnatomy?.inpMs != null && inpMember ? { inp: memberLabel(inpMember) } : {}),
  };

  const hints: string[] = [];
  if (forcedMember) hints.push("Forced-layout source lines: wpd query blame latest --forced");
  if (cpuMember) hints.push("Run-window hot functions: wpd query cpu latest");
  hints.push("All spans at a glance: wpd query spans latest");

  return {
    group: group.meta.name,
    target,
    label: wantedLabel,
    kind,
    members,
    sources,
    slices,
    ...(barAnatomy?.residualMs != null ? { residualMs: barAnatomy.residualMs } : {}),
    ...(barAnatomy?.frames ? { frames: barAnatomy.frames } : {}),
    counts,
    ...(inpAnatomy?.inpMs != null ? { inpMs: inpAnatomy.inpMs } : {}),
    ...(inpAnatomy?.interaction ? { interaction: inpAnatomy.interaction } : {}),
    ...(inpAnatomy?.loaf ? { loaf: inpAnatomy.loaf } : {}),
    ...(forcedAnatomy?.forced ? { forced: forcedAnatomy.forced } : {}),
    ...(forcedAnatomy?.thrash ? { thrash: forcedAnatomy.thrash } : {}),
    ...(forcedAnatomy?.firefoxDirtiedBy
      ? { firefoxDirtiedBy: forcedAnatomy.firefoxDirtiedBy }
      : {}),
    hot,
    notes: group.notes ?? [],
    hints,
  };
}

/** Human report for the stitch: per-member walls, then each panel tagged with its source member. */
function printGroupSpanStitch(stitch: GroupSpanStitch): void {
  const count = (value: Measured<number>): string =>
    formatMeasured(value, (measured) => String(measured));
  console.log(
    `\nspan ${bold(middleEllipsis(stitch.label, LABEL_COL_MAX))} ${dim(`(${stitch.kind} · run-group '${stitch.group}' · ${stitch.target})`)}`,
  );
  console.log(dim(`  ${stitchFooterFromSources(stitch)}`));

  console.log("\nWall per member (never combined):\n");
  console.log(
    table(
      ["member", "wall", "agg", "iterations"],
      stitch.members.map((member) => [
        member.variant ? `${member.mode}/${member.variant}` : member.mode,
        member.wallMs == null ? "—" : `${num(member.wallMs, 1)} ms`,
        member.aggregation,
        String(member.iterations),
      ]),
    ),
  );

  if (stitch.slices) {
    console.log(`\nCPU time breakdown ${dim(`(from member '${stitch.sources.slices ?? "?"}')`)}`);
    printUnifiedSlices(stitch.slices);
  } else {
    console.log(dim("\n(no reconciling bar: no member of this group built one)"));
  }

  console.log(
    `\nRendering counts ${dim(`(from member '${stitch.sources.counts ?? "none"}'; Measured: — = not measured, never 0)`)}\n`,
  );
  console.log(
    table(
      ["metric", "count"],
      [
        ["layout", count(stitch.counts.layoutCount)],
        ["style recalc", count(stitch.counts.styleCount)],
        ["paint", count(stitch.counts.paintCount)],
        ["forced layout/style", count(stitch.counts.forcedLayoutCount)],
        ["layout invalidations", count(stitch.counts.layoutInvalidations)],
        ["style invalidations", count(stitch.counts.styleInvalidations)],
        ["long tasks ≥50ms", count(stitch.counts.longTaskCount)],
      ],
    ),
  );

  if (stitch.inpMs != null || stitch.interaction) {
    const inp = stitch.inpMs == null ? "—" : `${num(stitch.inpMs)} ms`;
    console.log(
      `\nINP (worst interaction): ${bold(inp)} ${dim(`(from member '${stitch.sources.inp ?? "?"}')`)}`,
    );
    if (stitch.interaction) {
      const { inputDelayMs, processingMs, presentationDelayMs } = stitch.interaction;
      console.log(
        dim(
          `  input delay ${num(inputDelayMs, 2)} ms · processing ${num(processingMs, 2)} ms · presentation ${num(presentationDelayMs, 2)} ms`,
        ),
      );
    }
  }

  if (stitch.forced?.length) {
    console.log(
      `\nForced layout/style by source ${dim(`(from member '${stitch.sources.forced ?? "?"}'; the read that forced the flush)`)}\n`,
    );
    const shown = stitch.forced.slice(0, ANATOMY_FORCED_CAP);
    console.log(
      table(
        ["count", "ms", "source"],
        shown.map((entry) => [
          entry.count,
          num(entry.durMs, 2),
          middleEllipsis(entry.at, SOURCE_COL_MAX),
        ]),
      ),
    );
    if (stitch.forced.length > shown.length)
      console.log(dim(`  … +${stitch.forced.length - shown.length} more source(s)`));
  }
  if (stitch.thrash && stitch.thrash.count > 0)
    console.log(
      `\n⚠ layout thrashed ${bold(`${stitch.thrash.count}x`)} during the run ${dim("(query blame latest --forced for the full interleave)")}`,
    );

  if (stitch.hot?.functions?.length) {
    console.log(
      `\nHot functions ${dim(`(from member '${stitch.sources.hot ?? "?"}', ${num(stitch.hot.scriptingMs, 1)} ms JS self over ${stitch.hot.pooledSamples} sample(s))`)}. Drill with ${cyan("`query frame <id>`")}:\n`,
    );
    console.log(
      table(
        ["id", "self ms", "self %", "package", "function (source)"],
        stitch.hot.functions.map((fn) => [
          dim(String(fn.id)),
          num(fn.selfMs, 1),
          `${num(fn.selfPct, 1)}%`,
          cyan(fn.package),
          `${fn.fn}${fn.file ? ` ${dim(`(${shortSource(fn.file, fn.source)})`)}` : ""}`,
        ]),
      ),
    );
  }

  // Group-level disclosures (count disagreement across members, partial formation): surface them so a
  // stitched number is never read as agreed when the members did not.
  for (const note of stitch.notes) console.log(dim(`\n${note}`));

  if (stitch.hints.length) {
    console.log("");
    for (const hint of stitch.hints) console.log(dim(`  • ${hint}`));
  }
}

/** The footer rebuilt from a stitch's `sources` for the human header (no GroupMember handles here). */
function stitchFooterFromSources(stitch: GroupSpanStitch): string {
  const bar = stitch.sources.slices ? `bar+hot from ${stitch.sources.slices}` : "no bar member";
  const counts = stitch.sources.counts ? `counts from ${stitch.sources.counts}` : null;
  const forced = stitch.sources.forced ? `forced from ${stitch.sources.forced}` : null;
  const rest = [counts, forced].filter(Boolean).join(", ") || "no counts/forced member";
  return `${bar}, ${rest}. Walls are per member, never combined.`;
}

/** Print a UnifiedSlices bar (js/style/layout/paint/gc/other/idle), Measured-honest (— for not-measured). */
function printUnifiedSlices(slices: UnifiedSlices): void {
  const rows: [string, number | null, string][] = [
    ["js", slices.js.ms, ""],
    ["style", slices.style?.ms ?? null, ""],
    ["layout", slices.layout?.ms ?? null, ""],
    ["paint", slices.paint?.ms ?? null, slices.paint ? "" : dim("(not measured)")],
    ["gc", slices.gc.ms, ""],
    ["other", slices.other.ms, dim("(task remainder + engine/unclassified)")],
    ["idle", slices.idle.ms, dim("(waiting, not work)")],
  ];
  const wall = rows.reduce((total, [, ms]) => total + (ms ?? 0), 0);
  console.log(
    table(
      ["slice", "ms", "%", ""],
      rows.map(([name, ms, note]) => [
        name,
        ms == null ? "—" : num(ms, 1),
        ms == null || wall <= 0 ? "—" : `${num((ms / wall) * 100, 1)}%`,
        note,
      ]),
    ),
  );
}

export interface SpansQuery extends OutOpts {
  /** exact span label to keep (case-sensitive, like a performance.measure name) */
  label?: string;
  /** hide spans below this wall (ms); cuts the sub-N-ms tracking noise */
  minWall?: number;
  /** keep only spans whose label contains this text (case-insensitive substring) */
  filter?: string;
  /** list each dropped/smoothness-affecting frame under a bar (default: a one-line count) */
  frames?: boolean;
}

/** One dim line disclosing how many spans --min-wall/--filter hid, so a filtered view is never
 * mistaken for the whole recording. Silent when the filter hid nothing. */
function printSpanFilterNote(hidden: number): void {
  if (hidden > 0)
    console.log(dim(`\n  ${hidden} span(s) hidden by --min-wall/--filter (drop them to see all).`));
}

/**
 * `query spans`: ONE unified per-span breakdown across chrome/firefox/node -- the run window, each
 * driver step, and every user `performance.measure`, each in the same slice shape. Sources the
 * recording's stored per-span bars when present, else synthesizes the `run` span from
 * `CpuModel.breakdown`, so a recording carrying any bar is never empty. `--label` keeps one exact
 * label; `--min-wall <ms>` hides spans below a wall threshold and `--filter <text>` keeps only labels
 * containing <text> (case-insensitive), for cutting a tag manager's flood of tiny measures. The
 * hidden count is always disclosed.
 */
export async function querySpans(file: string, query: SpansQuery): Promise<void> {
  // A run-group renders the bar-bearing member's overview, plus a disclosure pointing at the deep
  // member's verbs; a plain recording renders itself.
  const consumption = await resolveConsumption(file);
  let abs = consumption.path;
  let overviewMemberForCheck: GroupMember | undefined;
  let groupCtx: {
    name: string;
    overviewLabel: string;
    countsLabel: string | null;
    deepLabel: string | null;
    notes: string[];
  } | null = null;
  if (consumption.kind === "group") {
    const group = await loadGroup(consumption.path);
    // The overview comes from the bar-bearing member; a group with no bar member (e.g. deep-only)
    // falls back to a counting member and renders the bar-less counts overview, exactly as a plain
    // --deep recording does, rather than refusing the documented overview flow.
    const countsMember = pickMember(group, "counts");
    const overviewMember = pickMember(group, "slice-bar") ?? countsMember;
    if (!overviewMember)
      throw new Error(
        `No member of run-group '${group.meta.name}' has a bar or exact counts to overview ` +
          `(members: ${group.members.map((entry) => memberLabel(entry)).join(", ")}).`,
      );
    abs = memberRecordingPath(consumption.path, overviewMember);
    overviewMemberForCheck = overviewMember;
    const deepMember = pickMember(group, "forced");
    groupCtx = {
      name: group.meta.name,
      overviewLabel: memberLabel(overviewMember),
      countsLabel: countsMember ? memberLabel(countsMember) : null,
      deepLabel: deepMember ? memberLabel(deepMember) : null,
      notes: group.notes ?? [],
    };
  }
  const rec = await load(abs);
  // A clobbered member (its file overwritten by another capture mode) points the overview at the
  // wrong capture; fail loudly rather than render its unrelated slices as this member's.
  if (overviewMemberForCheck) assertMemberMode(rec, overviewMemberForCheck, abs);
  // Prefer the recording's spans that carry a bar; reach for the sibling CPU model only when none do
  // (firefox/node without measures, or a default-mode chrome run), where the run bar lives on
  // CpuModel.breakdown instead of on the stored spans.
  const hasBar = rec.spans?.some((span) => span.breakdown);
  let model: CpuModel | undefined;
  let cpuBreakdown: CpuBreakdown | undefined;
  if (!hasBar) {
    try {
      model = await loadCpuModel(abs);
      cpuBreakdown = model.breakdown;
    } catch (error) {
      // Only "no model here" (ENOCPUMODEL) is the empty case buildSpans reports below; a corrupt or
      // unreadable sibling surfaces rather than reading as "no breakdown in this capture mode".
      if ((error as NodeJS.ErrnoException)?.code !== "ENOCPUMODEL") throw error;
    }
  }
  const iterations = rec.meta.iterations ?? 1;
  const result = buildSpans(rec.spans, cpuBreakdown, recordingLane(rec.meta), iterations);
  if (!result) {
    // No reconciling bar at this capture (default/--deep/--precise-wall) and no CpuModel run bar to
    // fall back on. The recording still carries spans with wall + (on --deep) exact counts, so render
    // THAT overview -- label/kind/wall/aggregation/counts, bars not-measured -- rather than refusing
    // the documented overview -> drill flow on the capture with the richest attribution. Only a
    // spans-less artifact is the true empty case.
    const counts = buildSpanCounts(rec.spans, recordingLane(rec.meta), iterations);
    if (!counts)
      throw new Error(
        `${file} carries no spans. Re-record: every current recording holds at least the run span.`,
      );
    return printBarlessSpans(counts, rec.meta, file, query, abs);
  }

  const label = query.label;
  // --label is an exact targeted selector; --min-wall/--filter cut the flood. Apply the selector
  // first, then the flood filter, so `hidden` counts only what the filter removed, never the
  // targeting. spanPassesFilter is shared with the human bar table below so both hide the same spans.
  const spanFilter = { minWallMs: query.minWall, labelIncludes: query.filter };
  const selected = label ? result.spans.filter((span) => span.label === label) : result.spans;
  const { spans, hidden } = filterSpanEntries(selected, spanFilter);
  // Bar-less step/measure rows (a default/--precise-wall driver step whose only bar is the run's) get
  // the same --label selector then flood filter, so a mixed recording lists them alongside the bar
  // rows. Selector first, flood filter second, so `hidden` counts only what the flood filter removed
  // (never the targeting) -- the same order the bar path above uses. A null-wall span (a navigating
  // step with no trace clock) is honest, not sub-threshold: only a MEASURED wall below --min-wall hides.
  const barlessLabelled = label
    ? (result.barlessSpans ?? []).filter((span) => span.label === label)
    : (result.barlessSpans ?? []);
  const barlessSelected = barlessLabelled.filter((span) => {
    if (query.filter && !span.label.toLowerCase().includes(query.filter.toLowerCase()))
      return false;
    if (query.minWall != null && span.wallMs != null && span.wallMs < query.minWall) return false;
    return true;
  });
  const barlessHidden = barlessLabelled.length - barlessSelected.length;
  const totalHidden = hidden + barlessHidden;
  // Drop the builder's unfiltered `barlessSpans` from the spread and re-add the filtered set (only
  // when non-empty), so a pure-bar recording keeps its old shape (no field) and the JSON never
  // carries the pre-filter rows.
  const { barlessSpans: _unfilteredBarless, ...resultWithoutBarless } = result;
  const barlessField = barlessSelected.length ? { barlessSpans: barlessSelected } : {};

  const fmt = structuredFormat(query);
  // Disclose the filter and how many spans it hid in the structured output too, never a silent cut.
  // The opt-in variant travels in the structured output as well, so a JSON/TOON consumer sees which
  // technique this recording is without re-reading meta.
  const variantField = rec.meta.variant ? { variant: rec.meta.variant } : {};
  // A group overview carries its provenance: the bar-bearing member it came from, and the deep member
  // that answers counts/blame -- so a consumer never reads this one member's bar as the whole group.
  const groupField: { group: GroupSpansProvenance } | Record<string, never> = groupCtx
    ? {
        group: {
          name: groupCtx.name,
          overviewFrom: groupCtx.overviewLabel,
          countsFrom: groupCtx.countsLabel,
          blameFrom: groupCtx.deepLabel,
          notes: groupCtx.notes,
        },
      }
    : {};
  if (fmt)
    return emit(
      {
        ...resultWithoutBarless,
        ...variantField,
        ...groupField,
        spans,
        ...barlessField,
        hidden: totalHidden,
        filter: spanFilter,
      },
      fmt,
    );

  // Surface an opt-in variant label next to the recording identity, so a reader knows which technique
  // this recording is (and why a diff gate against another variant would refuse).
  if (rec.meta.variant) console.log(dim(`\nvariant: ${rec.meta.variant}`));
  if (groupCtx) {
    console.log(
      dim(
        `\nrun-group '${groupCtx.name}': overview from member '${groupCtx.overviewLabel}'${groupCtx.deepLabel ? `; exact counts + forced-layout blame live on member '${groupCtx.deepLabel}' (query span/blame latest)` : ""}.`,
      ),
    );
    // Group-level disclosures (count disagreement across members, partial formation) are the honesty
    // valve: surface them so a two-member number is never read as agreed when the members did not.
    for (const note of groupCtx.notes) console.log(dim(`  ${note}`));
  }
  // Human output reuses the existing bar renderers. The stored-bars path prints the seven-slice
  // per-span table; the synthesized run bar prints the CpuModel bar, which already labels
  // style/layout and browser/native honestly for its lane.
  if (result.source === "breakdowns") {
    const barSpans = rec.spans.filter((span) => span.breakdown);
    const selectedBars = label ? barSpans.filter((span) => span.label === label) : barSpans;
    const bars = selectedBars.filter((span) =>
      spanPassesFilter(span.label, span.breakdown!.wallMs, spanFilter),
    );
    if (!bars.length && !barlessSelected.length) {
      if (label) return void console.log(`No span labelled '${label}' in ${file}.`);
      return void console.log(
        `No spans matched the filter in ${file} (${totalHidden} hidden by --min-wall/--filter).`,
      );
    }
    if (bars.length) printSpanBreakdowns(bars, iterations, rec.meta.browser, query.frames ?? false);
    // A step with no bar of its own lists here, below the bars. In a --breakdown recording the reason
    // is a cross-document navigation (its trace window spans the swap but no bar tiles it), NOT a
    // capture mode that lacks bars, so the hint must not tell a --breakdown user to run --breakdown.
    if (barlessSelected.length)
      printBarlessStepRows(
        barlessSelected,
        "navigated cross-document, so carry no reconciling bar",
      );
    printSpanFilterNote(totalHidden);
  } else {
    // The lane's single run bar (synthesized from the CpuModel) plus any bar-less driver steps. A
    // --label targeting the run keeps it in `spans` (length 0 or 1); a --label targeting a step
    // leaves `spans` empty and matches the step in the bar-less set instead.
    const runShown = spans.length > 0;
    if (runShown) printCpuBreakdown(model!, iterations);
    if (barlessSelected.length)
      printBarlessStepRows(
        barlessSelected,
        "no reconciling bar at this capture; record --breakdown for per-span bars",
      );
    if (!runShown && !barlessSelected.length) {
      if (label) return void console.log(`No span labelled '${label}' in ${file}.`);
      return void console.log(
        `No spans matched the filter in ${file} (${totalHidden} hidden by --min-wall/--filter).`,
      );
    }
    printSpanFilterNote(totalHidden);
  }
  // Point drill-down at one span's full anatomy (bar + counts + forced/dirtied + hot functions) and
  // at the event log, where one exists. The hint target is `latest` when this IS the latest recording,
  // else a cwd-relative path, so a pasted command carries no absolute home/scratch path. For a group,
  // the drills target the GROUP (so `query span` stitches, `query events` routes to the deep member),
  // not the bar member the overview happened to come from.
  const hintPath = groupCtx
    ? file === "latest"
      ? "latest"
      : JSON.stringify(file)
    : await hintTarget(abs);
  console.log(
    dim(
      `\n  • One span's anatomy (counts, forced, hot functions): wpd query span ${hintPath} <label>`,
    ),
  );
  // A group has an event log iff a deep member is present; on a plain recording, iff this capture kept one.
  const hasEventLog = groupCtx
    ? groupCtx.deepLabel != null
    : rec.meta.passes.includes("deep") || isGeckoCaptureMode(rec.meta.passes);
  if (hasEventLog)
    console.log(
      dim(`  • The classified event log: wpd query events ${hintPath} (drill: query get)`),
    );
}

/**
 * The bar-less span rows that sit BELOW a bar in a mixed overview: driver steps a sampler-only capture
 * (default/--precise-wall) built no per-span bar for, or a step that navigated cross-document in a
 * --breakdown recording. Listed by wall + INP rather than dropped from the overview; slices/counts are
 * not on these rows, so the table stays to what is real (wall, aggregation, INP). `hint` names WHY the
 * rows have no bar (it differs by capture mode), so a --breakdown user is not told to run --breakdown.
 */
function printBarlessStepRows(spans: SpanCountsEntry[], hint: string): void {
  console.log(`\nspans without a bar ${dim(`(${hint})`)}\n`);
  console.log(
    table(
      ["span", "kind", "wall", "agg", "inp"],
      spans.map((span) => [
        middleEllipsis(span.label, LABEL_COL_MAX),
        span.kind,
        span.wallMs == null ? "—" : `${num(span.wallMs, 1)} ms`,
        span.aggregation,
        span.inpMs == null ? "—" : `${num(span.inpMs, 1)} ms`,
      ]),
    ),
  );
}

/**
 * `query spans` on a bar-less recording (default/--deep/--precise-wall): the overview it CAN render
 * honestly -- label/kind/wall/aggregation and the Measured rendering counts -- with the reconciling
 * bar shown as not-measured. --deep leads with its exact counts here; the sampler-off wall capture modes
 * carry only the wall (counts —). Never a fabricated all-zero bar.
 */
async function printBarlessSpans(
  overview: SpanCountsOverview,
  meta: RecordingMeta,
  file: string,
  query: SpansQuery,
  abs: string,
): Promise<void> {
  const label = query.label;
  const selected = label ? overview.spans.filter((span) => span.label === label) : overview.spans;
  // A null-wall span (a navigating step on a no-trace capture mode) is honest, not sub-threshold: only a
  // MEASURED wall below --min-wall hides. --filter matches the label the usual way.
  const passes = (span: SpanCountsEntry): boolean => {
    const needle = query.filter?.toLowerCase();
    if (needle && !span.label.toLowerCase().includes(needle)) return false;
    if (query.minWall != null && span.wallMs != null && span.wallMs < query.minWall) return false;
    return true;
  };
  const spans = selected.filter(passes);
  const hidden = selected.length - spans.length;
  const spanFilter = { minWallMs: query.minWall, labelIncludes: query.filter };

  const fmt = structuredFormat(query);
  const variantField = meta.variant ? { variant: meta.variant } : {};
  if (fmt) return emit({ ...overview, ...variantField, spans, hidden, filter: spanFilter }, fmt);

  if (!spans.length) {
    if (label) return void console.log(`No span labelled '${label}' in ${file}.`);
    return void console.log(
      `No spans matched the filter in ${file} (${hidden} hidden by --min-wall/--filter).`,
    );
  }

  const count = (value: Measured<number>): string =>
    formatMeasured(value, (measured) => String(measured));
  const isDeep = meta.passes.includes("deep") || isGeckoCaptureMode(meta.passes);
  console.log(
    `\nspans overview ${dim(`(${overview.target}${meta.variant ? ` · variant ${meta.variant}` : ""} · no reconciling bar at this capture · counts Measured: — = not measured, never 0)`)}\n`,
  );
  console.log(
    table(
      ["span", "kind", "wall", "agg", "layout", "style", "paint", "forced", "long≥50ms"],
      spans.map((span) => [
        middleEllipsis(span.label, LABEL_COL_MAX),
        span.kind,
        span.wallMs == null ? "—" : `${num(span.wallMs, 1)} ms`,
        span.aggregation,
        count(span.counts.layoutCount),
        count(span.counts.styleCount),
        count(span.counts.paintCount),
        count(span.counts.forcedLayoutCount),
        count(span.counts.longTaskCount),
      ]),
    ),
  );
  printSpanFilterNote(hidden);
  console.log(
    dim(
      isDeep
        ? "\n  Slice ms (js/style/layout/paint) are suppressed on --deep: the .stack trace inflates them, so this capture leads with exact counts (record --breakdown for the reconciling bar)."
        : "\n  No trace at this capture, so rendering counts and a reconciling bar are not measured (—). Record --breakdown for the bar, or --deep for exact counts and forced-layout blame.",
    ),
  );

  const hintPath = await hintTarget(abs);
  console.log(
    dim(
      `\n  • One span's anatomy (counts, forced, hot functions): wpd query span ${hintPath} <label>`,
    ),
  );
  if (isDeep)
    console.log(
      dim(`  • The classified event log: wpd query events ${hintPath} (drill: query get)`),
    );
}

export async function queryGet(file: string, id: number, opts: OutOpts): Promise<void> {
  const rec = await loadEventLogTarget(file, opts);
  requireEventLog(rec, file);
  const event = rec.events.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`No event with id ${id} in ${file}`);
  emit(event, structuredFormat(opts) ?? "json");
}

export interface EventsQuery extends OutOpts {
  kind?: string;
  name?: string;
  forced?: boolean;
  top?: number;
  sort?: "dur" | "ts";
}

export async function queryEvents(file: string, query: EventsQuery): Promise<void> {
  if (query.kind && !isEventKind(query.kind))
    throw new Error(`Unknown --kind '${query.kind}'. Valid kinds: ${EVENT_KINDS.join(", ")}`);
  const rec = await loadEventLogTarget(file, query);
  requireEventLog(rec, file);
  let events = eventsInWindow(rec);
  if (query.kind) events = events.filter((event) => event.kind === query.kind);
  if (query.name)
    events = events.filter((event) => event.name.toLowerCase().includes(query.name!.toLowerCase()));
  if (query.forced) events = events.filter((event) => event.forced);
  events.sort((firstEvent, secondEvent) =>
    query.sort === "ts" ? firstEvent.ts - secondEvent.ts : secondEvent.dur - firstEvent.dur,
  );
  if (query.top != null) events = events.slice(0, query.top);

  const fmt = structuredFormat(query);
  if (fmt) return emit(events, fmt);
  console.log(
    table(
      ["id", "kind", "name", "ms", "source"],
      events.map((event) => [
        event.id,
        event.kind,
        event.name,
        num(usToMs(event.dur), 3),
        event.at ? middleEllipsis(event.at, SOURCE_COL_MAX) : "",
      ]),
    ),
  );
  console.log(`\n${events.length} event(s)`);
}

export interface BlameQuery extends OutOpts {
  kind?: string;
  forced?: boolean;
  /** show every attributed source line with a `forced` column (incl. forced=0) */
  all?: boolean;
  /** firefox --deep only: the dirtied-by write report, separate from the read-site rows */
  dirtied?: boolean;
  top?: number;
}

export async function queryBlame(file: string, query: BlameQuery): Promise<void> {
  if (query.kind && !isEventKind(query.kind))
    throw new Error(`Unknown --kind '${query.kind}'. Valid kinds: ${EVENT_KINDS.join(", ")}`);
  const rec = await loadEventLogTarget(file, query);
  requireEventLog(rec, file);

  // --dirtied: the firefox --deep write report ALONE (Gecko cause stacks, first-invalidation-only).
  // Kept a distinct mode so the write side never merges into the --forced read-site rows, and so its
  // JSON carries the `semantic: "first-invalidation"` marker a consumer needs to not read it as
  // chrome's exact write set. Refused off this lane, naming where the write identity actually lives.
  if (query.dirtied) return void queryDirtied(rec, file, query);

  let events = eventsInWindow(rec).filter((event) => event.at);
  // --forced narrows to thrashing; --all keeps everything (and reports forced=0 lines)
  if (query.forced && !query.all) events = events.filter((event) => event.forced);
  if (query.kind) events = events.filter((event) => event.kind === query.kind);

  const groups = new Map<
    string,
    {
      at: string;
      count: number;
      forced: number;
      durMs: number;
      kinds: Set<string>;
      properties: Set<string>;
      /** sampled flushes at this line wider than one interval (confident) vs narrower (low-confidence) */
      confident: number;
      lowConfidence: number;
    }
  >();
  for (const event of events) {
    const group = groups.get(event.at!) ?? {
      at: event.at!,
      count: 0,
      forced: 0,
      durMs: 0,
      kinds: new Set<string>(),
      properties: new Set<string>(),
      confident: 0,
      lowConfidence: 0,
    };
    group.count++;
    if (event.forced) group.forced++;
    group.durMs += usToMs(event.dur);
    group.kinds.add(event.kind);
    const data = (
      event.args as { data?: { property?: string; lowConfidence?: boolean } } | undefined
    )?.data;
    // The forcing DOM property (Firefox read-site blame), stashed on the sampled event's args.
    if (typeof data?.property === "string") group.properties.add(data.property);
    // Chrome --breakdown sampled sub-interval flushes are low-confidence; a wider flush (no marker) or
    // any --deep/firefox exact event is confident, so a line with one confident sample is not flagged.
    if (data?.lowConfidence === true) group.lowConfidence++;
    else group.confident++;
    groups.set(event.at!, group);
  }
  let rows = [...groups.values()].sort(
    (left, right) =>
      right.forced - left.forced || right.durMs - left.durMs || right.count - left.count,
  );
  if (query.top != null) rows = rows.slice(0, query.top);

  // dirtied-by: the WRITE that dirtied each forced read-site, from the invalidation records only
  // a --deep trace carries. Absent on every other lane (empty map), so the read stays the headline
  // and no second line prints there.
  // Pass the full event log: the enclosing RunTask can begin just before the run:start mark, and the
  // interleave walk needs it. analyzeThrash windows internally to the in-window flushes.
  const dirtiedByReadSite = rec.meta.passes.includes("deep")
    ? analyzeThrash(rec.events, rec.window.startTs).dirtiedByReadSite
    : {};

  const fmt = structuredFormat(query);
  if (fmt) {
    const entries: BlameEntry[] = rows.map((row) => ({
      at: row.at,
      count: row.count,
      forced: row.forced,
      durMs: row.durMs,
      kinds: [...row.kinds] as EventKind[],
      properties: row.properties.size ? [...row.properties] : undefined,
      dirtiedBy: dirtiedByReadSite[row.at]?.length ? dirtiedByReadSite[row.at] : undefined,
      lowConfidence: row.confident === 0 && row.lowConfidence > 0 ? true : undefined,
    }));
    return emit(entries, fmt);
  }
  if (!rows.length) {
    // Firefox counts forced flushes from markers but blames the read by SAMPLING it, so a cheap read
    // can go uncaught: an empty --forced beside a nonzero count is a sampling miss, NOT "no forced
    // layout". Say which, so the count is not read as a contradiction of the empty result.
    const firefoxForced = rec.summary.forcedLayoutCount;
    if (
      query.forced &&
      rec.meta.browser === "firefox" &&
      firefoxForced != null &&
      firefoxForced > 0
    ) {
      console.log(
        `No forced read-site located, but the recording counts ${firefoxForced} forced layout/style flush(es). ` +
          "Firefox blames the read by sampling it at the ~1ms Gecko interval, so a cheap read can be missed; " +
          "the count is real (marker-derived), the site is what sampling did not catch.",
      );
      return;
    }
    // Chrome --breakdown samples the read from the CPU profile (no `.stack`), so an empty --forced can
    // be a sampling miss, not a measured 0 -- and --breakdown never measures the forced COUNT, so there
    // is no count to reconcile against (unlike firefox above). Say which, and point at --deep.
    if (query.forced && rec.meta.browser !== "firefox" && rec.meta.passes.includes("breakdown")) {
      console.log(
        "No forced read-site sampled on this --breakdown run. The read is sampled from the CPU profile's " +
          "per-sample executing line, so a cheap sub-interval flush can be missed; --breakdown does not " +
          "measure the forced COUNT either. Record --deep for the exact forced count and blame. An empty " +
          "result here is a sampling miss or a genuinely thrash-free run, not a measured 0.",
      );
      return;
    }
    console.log(
      query.forced
        ? "No forced (synchronous) layout/style — no layout thrashing. 🎉"
        : `No source-attributed events (${whatCapturesStacks(rec.meta.blameSemantic)}).`,
    );
    return;
  }
  // The source cell carries the forcing DOM property when the lane names it (Firefox read-site), and a
  // low-confidence marker when every flush at this line was sub-interval (Chrome --breakdown sampled).
  const sourceCell = (row: {
    at: string;
    properties: Set<string>;
    confident: number;
    lowConfidence: number;
  }): string => {
    const at = middleEllipsis(row.at, SOURCE_COL_MAX);
    const withProperty = row.properties.size ? `${at} (${[...row.properties].join(", ")})` : at;
    return row.confident === 0 && row.lowConfidence > 0
      ? `${withProperty} ${dim("~low-confidence (sub-interval)")}`
      : withProperty;
  };
  // `--all` shows the forced column so "ran but forced 0" lines are first-class.
  console.log(
    query.all
      ? table(
          ["events", "forced", "ms", "kinds", "source"],
          rows.map((row) => [
            row.count,
            row.forced,
            num(row.durMs, 3),
            [...row.kinds].join(","),
            sourceCell(row),
          ]),
        )
      : table(
          ["count", "ms", "kinds", "source"],
          rows.map((row) => [
            row.count,
            num(row.durMs, 3),
            [...row.kinds].join(","),
            sourceCell(row),
          ]),
        ),
  );
  // dual annotation: under each forced read-site, the WRITE that dirtied it (Chrome --deep). The
  // read stays the headline (the table above); dirtied-by is the second line, so a reader sees both
  // "who paid" (the read) and "who caused" (the write). Only rows with a resolved write print.
  const dirtiedRows = rows.filter((row) => dirtiedByReadSite[row.at]?.length);
  if (dirtiedRows.length) {
    console.log("\ndirtied-by (the write that forced each read):");
    for (const row of dirtiedRows) {
      console.log(`  ${row.at}`);
      for (const write of dirtiedByReadSite[row.at])
        console.log(
          `    ${dim("↳ dirtied by")} ${write.at}${write.reason ? dim(` (${write.reason})`) : ""}`,
        );
    }
  }
  // Firefox --deep: the dirtied-by WRITE section, appended AFTER the read-site table so a reader sees
  // both without the two ever merging into one row. It is Gecko's cause-stack write identity,
  // first-invalidation-only -- a distinct concept from the read rows above (whose `at` is the read
  // that paid). The full JSON write report is `query blame --dirtied`.
  if (isFirefoxDeep(rec.meta.passes)) {
    const report = firefoxDirtiedBy(eventsInWindow(rec), rec.window.startTs);
    if (report) {
      console.log(
        "\ndirtied-by (first invalidation only) — the write Gecko blames for each flush:",
      );
      console.log(
        dim(
          "  forced-by: n/a (firefox --deep); not Chrome's full write set. Full report: query blame --dirtied",
        ),
      );
      for (const write of report.writes)
        console.log(`    ${write.at}  ${dim(`(${write.kinds.join(",")} ×${write.count})`)}`);
    }
  }
  // Only the forced rows have an engine-specific meaning worth naming, so the note is gated on
  // one being present rather than on the --forced flag: plain `blame` and `--all` show forced and
  // unforced rows together, and an unforced scripting/invalidation row is not a geometry read at
  // all. Saying so over such a table would print the exact read/write confusion the semantic
  // exists to prevent (Chrome's invalidation stacks name the WRITE: docs/dev/blame-semantics.md).
  if (rows.some((row) => row.forced > 0)) {
    const semantic = blameSemanticLine(
      rec.meta.blameSemantic,
      rec.meta.browser,
      rec.meta.passes.includes("breakdown"),
    );
    if (semantic) console.log(`\n${semantic}`);
  }
}

/**
 * `query blame --dirtied`: the firefox --deep dirtied-by write report alone. Refused off the firefox
 * --deep lane -- the write identity comes from Gecko's cause stacks, so there is nothing to show
 * elsewhere (chrome's write set is `query blame` dirtied-by rows + the `query span run` thrash instead).
 */
async function queryDirtied(rec: Recording, file: string, query: BlameQuery): Promise<void> {
  if (query.forced)
    throw new Error(
      "--forced (read-site rows) and --dirtied (the write report) are separate answers; pass one.",
    );
  if (!isFirefoxDeep(rec.meta.passes))
    throw new Error(
      `${file}: --dirtied is the firefox --deep write report (Gecko cause stacks, first-invalidation-only). ` +
        `This recording is not one (passes: ${rec.meta.passes.join("+")}). On firefox, re-record with ` +
        `--deep; on chrome, the write side is the dirtied-by rows under \`query blame\` and the thrash ` +
        `rollup in \`query span run\`.`,
    );
  const report = firefoxDirtiedBy(eventsInWindow(rec), rec.window.startTs);
  const fmt = structuredFormat(query);
  if (fmt) return emit(report ?? { semantic: "first-invalidation", writes: [] }, fmt);
  if (!report) {
    console.log("No JS-forced flush named a write (no cause stack resolved). 🎉");
    return;
  }
  console.log(
    "dirtied-by (first invalidation only) — the write Gecko blames for each forced flush.",
  );
  console.log(
    dim(
      "forced-by: n/a (firefox --deep). Gecko records only the FIRST invalidation since the last flush, so\n" +
        "this is not Chrome's full write set. The read that forced each flush is the sampled read-site\n" +
        "blame: query blame --forced.",
    ),
  );
  console.log(
    table(
      ["count", "kinds", "write"],
      report.writes.map((write) => [write.count, write.kinds.join(","), write.at]),
    ),
  );
}

/**
 * Which engine attributed this recording's events, for the "nothing to show" message. Naming
 * Chrome unconditionally would be wrong on a Firefox recording, pointing the reader at a stack
 * source that lane does not have. Absent semantic => no blame pass ran at all.
 */
function whatCapturesStacks(semantic: BlameSemantic | undefined): string {
  if (semantic === "invalidation-site")
    return "Firefox captures cause stacks for layout/style via the Gecko profiler";
  if (semantic === "flush-site")
    return "the run captures the geometry read that forced the flush (Chrome --deep via the trace's `.stack`, Chrome --breakdown + Firefox by sampling it)";
  return "this run captured no blame: the default and --precise-wall capture modes run no trace, and --target node has no DOM; record with --deep (chrome) or --target firefox";
}

/**
 * One line saying what the `source` column of the FORCED rows points at. Without it the table
 * invites the one comparison it cannot support: the same probe blamed in both engines shares zero
 * lines, because each engine answers a different question (see BlameSemantic). Human output only --
 * structured consumers read `meta.blameSemantic` off the recording, which is durable and does not
 * depend on having run this verb.
 */
function blameSemanticLine(
  semantic: BlameSemantic | undefined,
  browser: "chrome" | "firefox" | undefined,
  chromeSampled: boolean,
): string | null {
  if (semantic === "flush-site") {
    if (browser === "firefox")
      return (
        "forced rows: source = the geometry read that forced the flush, named from the sampled " +
        "DOM-accessor stacks (with the property). Same read-site semantic as Chrome; it is a " +
        "sampled estimate, so cheap reads can be missed and the line can lag one statement."
      );
    // Chrome --breakdown samples the read from the CPU profile's per-sample executing line; --deep
    // reads it exactly from Blink's `.stack`. Name which, so a sampled line is not read as exact.
    return chromeSampled
      ? "forced rows: source = the geometry read that forced the flush, sampled from the CPU profile's " +
          "per-sample executing line (--breakdown has no `.stack`). A sampled estimate, so a flush " +
          "narrower than one sampler interval can lag one statement or land on an adjacent line (marked " +
          "~low-confidence); the forced COUNT needs --deep. Comparable to firefox's sampled read at line granularity."
      : "forced rows: source = the geometry read that forced the flush, read exactly from Blink's " +
          "`.stack` (--deep). Firefox and --breakdown name the same read site (sampled), so the forced " +
          "lines are comparable at line granularity.";
  }
  if (semantic === "invalidation-site")
    return (
      "forced rows: source = the write that dirtied the DOM (older Firefox recording), not the read " +
      "that forced the flush. Newer runs and Chrome name the read instead."
    );
  return null;
}
