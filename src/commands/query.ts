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
  SpanHot,
} from "../model/recording.js";
import { matchedFrameFloorMs } from "../model/frame-floor.js";
import type { BlameEntry, SpanAnatomy, SpanForced, SpanHotFunctions } from "../model/query.js";
import { MIN_POOLED_HOT_SAMPLES } from "../profile/span-hot.js";
import {
  buildSpans,
  recordingLane,
  parseSpanKindLabel,
  filterSpanEntries,
  spanPassesFilter,
} from "../model/spans.js";
import { isFirefoxDeep, isGeckoCaptureMode } from "../model/capture-mode.js";
import { bold, cyan, dim } from "../output/color.js";
import { num, table } from "../output/ascii.js";
import { analyzeThrash } from "../trace/thrash.js";
import { firefoxDirtiedBy } from "../trace/firefox-dirtied.js";
import { forcedLayouts } from "../trace/analysis.js";
import { findSteps } from "../trace/parse.js";
import { deserialize, serialize, isFormat, type Format } from "../output/format.js";
import { assertRecordingArtifact } from "../model/artifact.js";
import { printSpanBreakdowns, printCpuBreakdown } from "./cpu.js";
import { loadCpuModel, shortSource } from "../profile/cpuprofile.js";
import { resolveTarget, hintTarget } from "./resolve.js";
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
  if (rec.meta.passes.includes("deep") || isGeckoCaptureMode(rec.meta.passes)) return;
  throw new Error(
    `${file}: the event log was not captured in this capture mode (${rec.meta.passes.join("+")}). Events, ` +
      `forced-layout blame, and invalidation records are stored only under --deep (chrome) or ` +
      `--target firefox. Re-record with --deep.`,
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
  const abs = await resolveTarget(file, "recording");
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
  const hasEventLog = rec.meta.passes.includes("deep") || isGeckoCaptureMode(rec.meta.passes);
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
      scriptingMs: model.scriptingMs,
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
    `\nspan ${bold(anatomy.label)} ${dim(`(${anatomy.kind} · ${anatomy.target} · ${anatomy.aggregation} of ${anatomy.iterations} iteration(s))`)}`,
  );
  const wall = anatomy.wallMs == null ? "—" : `${num(anatomy.wallMs)} ms`;
  const spread =
    anatomy.samples != null && anatomy.wallMinMs != null && anatomy.wallMaxMs != null
      ? dim(
          ` · ${anatomy.samples} samples, wall ${num(anatomy.wallMinMs, 1)}..${num(anatomy.wallMaxMs, 1)} ms`,
        )
      : "";
  console.log(`wall: ${bold(wall)}${spread}`);
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
        shown.map((entry) => [entry.count, num(entry.durMs, 2), entry.at]),
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
  const abs = await resolveTarget(file, "recording");
  const rec = await load(abs);
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
  if (!result)
    throw new Error(
      `${file} carries no per-span breakdown. Record with \`--breakdown\` (chrome), \`--target ` +
        `firefox\`, or \`--target node\` to produce span bars; the default/--deep/--precise-wall ` +
        `capture modes and older recordings have none.`,
    );

  const label = query.label;
  // --label is an exact targeted selector; --min-wall/--filter cut the flood. Apply the selector
  // first, then the flood filter, so `hidden` counts only what the filter removed, never the
  // targeting. spanPassesFilter is shared with the human bar table below so both hide the same spans.
  const spanFilter = { minWallMs: query.minWall, labelIncludes: query.filter };
  const selected = label ? result.spans.filter((span) => span.label === label) : result.spans;
  const { spans, hidden } = filterSpanEntries(selected, spanFilter);

  const fmt = structuredFormat(query);
  // Disclose the filter and how many spans it hid in the structured output too, never a silent cut.
  if (fmt) return emit({ ...result, spans, hidden, filter: spanFilter }, fmt);

  // Human output reuses the existing bar renderers. The stored-bars path prints the seven-slice
  // per-span table; the synthesized run bar prints the CpuModel bar, which already labels
  // style/layout and browser/native honestly for its lane.
  if (result.source === "breakdowns") {
    const barSpans = rec.spans.filter((span) => span.breakdown);
    const selectedBars = label ? barSpans.filter((span) => span.label === label) : barSpans;
    const bars = selectedBars.filter((span) =>
      spanPassesFilter(span.label, span.breakdown!.wallMs, spanFilter),
    );
    if (!bars.length) {
      if (label) return void console.log(`No span labelled '${label}' in ${file}.`);
      return void console.log(
        `No spans matched the filter in ${file} (${hidden} hidden by --min-wall/--filter).`,
      );
    }
    printSpanBreakdowns(bars, iterations, rec.meta.browser, query.frames ?? false);
    printSpanFilterNote(hidden);
  } else if (label && label !== "run") {
    return void console.log(
      `No span labelled '${label}' in ${file} (this lane carries only the 'run' bar).`,
    );
  } else if (!spans.length) {
    // The single run bar this lane carries was hidden by --min-wall/--filter.
    return void console.log(
      `No spans matched the filter in ${file} (${hidden} hidden by --min-wall/--filter).`,
    );
  } else {
    printCpuBreakdown(model!, iterations);
    printSpanFilterNote(hidden);
  }
  // Point drill-down at one span's full anatomy (bar + counts + forced/dirtied + hot functions) and
  // at the event log, where one exists. The hint target is `latest` when this IS the latest recording,
  // else a cwd-relative path, so a pasted command carries no absolute home/scratch path.
  const hintPath = await hintTarget(abs);
  console.log(
    dim(
      `\n  • One span's anatomy (counts, forced, hot functions): wpd query span ${hintPath} <label>`,
    ),
  );
  if (rec.meta.passes.includes("deep") || isGeckoCaptureMode(rec.meta.passes))
    console.log(
      dim(`  • The classified event log: wpd query events ${hintPath} (drill: query get)`),
    );
}

export async function queryGet(file: string, id: number, opts: OutOpts): Promise<void> {
  const rec = await load(file);
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
  const rec = await load(file);
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
        event.at ?? "",
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
  const rec = await load(file);
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
    };
    group.count++;
    if (event.forced) group.forced++;
    group.durMs += usToMs(event.dur);
    group.kinds.add(event.kind);
    // The forcing DOM property (Firefox read-site blame), stashed on the sampled event's args.
    const property = (event.args as { data?: { property?: string } } | undefined)?.data?.property;
    if (typeof property === "string") group.properties.add(property);
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
    console.log(
      query.forced
        ? "No forced (synchronous) layout/style — no layout thrashing. 🎉"
        : `No source-attributed events (${whatCapturesStacks(rec.meta.blameSemantic)}).`,
    );
    return;
  }
  // The source cell carries the forcing DOM property when the lane names it (Firefox read-site).
  const sourceCell = (row: { at: string; properties: Set<string> }): string =>
    row.properties.size ? `${row.at} (${[...row.properties].join(", ")})` : row.at;
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
    const semantic = blameSemanticLine(rec.meta.blameSemantic, rec.meta.browser);
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
    return "the run captures the geometry read that forced the flush (Chrome via the trace's `.stack`, Firefox via the sampled DOM-accessor stacks)";
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
): string | null {
  if (semantic === "flush-site")
    return browser === "firefox"
      ? "forced rows: source = the geometry read that forced the flush, named from the sampled " +
          "DOM-accessor stacks (with the property). Same read-site semantic as Chrome; it is a " +
          "sampled estimate, so cheap reads can be missed and the line can lag one statement."
      : "forced rows: source = the geometry read that forced the flush. Firefox now names the same " +
          "read site (sampled), so the two engines' forced lines are comparable at line granularity.";
  if (semantic === "invalidation-site")
    return (
      "forced rows: source = the write that dirtied the DOM (older Firefox recording), not the read " +
      "that forced the flush. Newer runs and Chrome name the read instead."
    );
  return null;
}
