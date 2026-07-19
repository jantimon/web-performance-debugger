import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BlameSemantic,
  CpuBreakdown,
  CpuModel,
  EventKind,
  NormalizedEvent,
  Recording,
  Span,
  SpanKind,
} from "../model/recording.js";
import type { BlameEntry, SpanAnatomy, SpanForced, SpanHotFunctions } from "../model/query.js";
import { buildSpans, recordingLane } from "../model/spans.js";
import { isFirefoxDeep, isGeckoRung } from "../model/rung.js";
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
import { resolveTarget } from "./resolve.js";
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
 * firefox. On every other rung it is empty by design, so `query events`/`get`/`blame` say "not
 * captured at this rung" rather than reporting an empty result as if the page did nothing. A --deep
 * run that genuinely observed nothing still has the log (it just came back empty), so the rung, not
 * the array length, is the test.
 */
function requireEventLog(rec: Recording, file: string): void {
  if (rec.meta.passes.includes("deep") || isGeckoRung(rec.meta.passes)) return;
  throw new Error(
    `${file}: the event log was not captured at this rung (${rec.meta.passes.join("+")}). Events, ` +
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
}

/**
 * Split a `kind:label` qualifier (`run:`, `step:`, `measure:`) off a span argument, or null for a
 * bare label. Only the three span kinds qualify; a label that itself begins `foo:` is not one and
 * stays a bare label. Span identity is kind+label, so this is how a caller disambiguates a bare label
 * that collides across kinds.
 */
function parseKindLabel(raw: string): { kind: SpanKind; label: string } | null {
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const prefix = raw.slice(0, colon);
  if (prefix === "run" || prefix === "step" || prefix === "measure")
    return { kind: prefix, label: raw.slice(colon + 1) };
  return null;
}

/**
 * The trace-clock window of one span, recovered from the stored event log so forced read-sites can be
 * scoped to the span. The run window is `rec.window`; a step's edges are its `wpd:step:N:start|end`
 * marks; a user measure's are its first in-window `performance.measure` begin/end. Falls back to the
 * run window when the span's own marks are not in this log (a rung with no event log never reaches
 * here). endTs null leaves the window open-ended, which the start-onward `forcedLayouts` handles.
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
 * the rung built one, else rung-honest null), the wall/aggregation/samples/spread, the Measured
 * counts, INP/interaction when the span had one, the forced-layout read-sites + dirtied-by writes +
 * thrash rollup an event-log rung (chrome --deep, firefox) captured, and the hot functions within the
 * span's window (run span only; per-step/measure windowing is not reconstructable at read time).
 */
export async function querySpan(file: string, label: string, query: SpanQuery): Promise<void> {
  const abs = await resolveTarget(file, "recording");
  const rec = await load(abs);

  const qualifier = parseKindLabel(label);
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
  const anatomy = buildSpanAnatomy(rec, abs, span, model, query.top ?? DEFAULT_SPAN_HOT);

  const fmt = structuredFormat(query);
  if (fmt) return emit(anatomy, fmt);
  printSpanAnatomy(anatomy, span, model);
}

/** Load the sibling CPU model if one exists; a missing/absent model is not an error for the anatomy. */
async function tryLoadCpuModel(recordingPath: string): Promise<CpuModel | undefined> {
  try {
    return await loadCpuModel(recordingPath);
  } catch {
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
): SpanAnatomy {
  const iterations = rec.meta.iterations ?? 1;
  const target = recordingLane(rec.meta);

  // Unified slices: prefer the stored bar; a run span with no stored bar falls back to the sibling
  // CpuModel run bar (the same source rule as `query spans`). null when this rung built no bar.
  const spansResult = buildSpans(rec.spans, model?.breakdown, target, iterations);
  const entry = spansResult?.spans.find(
    (candidate) => candidate.label === span.label && candidate.kind === span.kind,
  );

  // Forced read-sites, thrash, and the firefox write report come from the deep event log, scoped to
  // this span's window. Absent on every rung that captured no log (the empty array is that lane's
  // "not captured", so the rung gates it, not the array length).
  const hasEventLog = rec.meta.passes.includes("deep") || isGeckoRung(rec.meta.passes);
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

  // Hot functions within the span window. The resolved CpuModel IS the run window, so a run span
  // reports its hot list exactly; per-step/measure windowing would need raw per-sample timestamps the
  // model does not retain, so those spans report null rather than an approximation.
  let hot: SpanHotFunctions | null = null;
  if (span.kind === "run" && model)
    hot = {
      scope: "run-window",
      scriptingMs: model.scriptingMs,
      sampleCount: model.sampleCount,
      functions: model.functions.slice(0, topN),
    };

  const hints: string[] = [];
  if (hasEventLog) {
    hints.push(`Forced-layout source lines: wpd query blame "${recordingPath}" --forced`);
    hints.push(`Drill an event by id: wpd query get "${recordingPath}" <id>`);
  }
  if (model && span.kind !== "run")
    hints.push(`Run-window hot functions: wpd query cpu "${recordingPath}"`);
  hints.push(`All spans at a glance: wpd query spans "${recordingPath}"`);

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
    ...(forced ? { forced } : {}),
    ...(thrash ? { thrash } : {}),
    ...(firefoxDirtied ? { firefoxDirtiedBy: firefoxDirtied } : {}),
    hot,
    hints,
  };
}

/** Human report for `query span`: the bar, wall/counts/interaction, forced attribution, hot list. */
function printSpanAnatomy(anatomy: SpanAnatomy, span: Span, model: CpuModel | undefined): void {
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

  // The reconciling bar, when the rung built one. A stored bar prints the seven-slice per-span table;
  // a run span with only the sibling CpuModel bar prints that (four/six slices, honestly labelled).
  if (span.breakdown) printSpanBreakdowns([span], anatomy.iterations);
  else if (span.kind === "run" && model?.breakdown) printCpuBreakdown(model, anatomy.iterations);
  else console.log(dim("\n(no reconciling bar at this rung; record with --breakdown for one)"));

  console.log("\nRendering counts (Measured: — = not measured on this rung, never 0)\n");
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
    console.log(
      `\nHot functions in this span ${dim(`(${anatomy.hot.scope}, ${num(anatomy.hot.scriptingMs, 1)} ms JS self, ${anatomy.hot.sampleCount} samples)`)}. Drill with ${cyan("`query frame <id>`")}:\n`,
    );
    console.log(
      table(
        ["id", "self ms", "self %", "package", "function (source)"],
        anatomy.hot.functions.map((fn) => [
          dim(String(fn.id)),
          num(fn.selfMs, 1),
          `${num(fn.selfPct, 1)}%`,
          cyan(fn.package),
          `${fn.fn}${fn.file ? ` ${dim(`(${shortSource(fn.file, fn.source)})`)}` : ""}`,
        ]),
      ),
    );
  } else if (span.kind !== "run") {
    console.log(
      dim(
        "\nHot functions: not available for a step/measure span (per-span CPU windowing is not reconstructed post-hoc). Use `query cpu` for the run-window hot list.",
      ),
    );
  }

  if (anatomy.hints.length) {
    console.log("");
    for (const hint of anatomy.hints) console.log(dim(`  • ${hint}`));
  }
}

export interface SpansQuery extends OutOpts {
  /** exact span label to keep (case-sensitive, like a performance.measure name) */
  label?: string;
}

/**
 * `query spans`: ONE unified per-span breakdown across chrome/firefox/node -- the run window, each
 * driver step, and every user `performance.measure`, each in the same slice shape. Sources the
 * recording's stored per-span bars when present, else synthesizes the `run` span from
 * `CpuModel.breakdown`, so a recording carrying any bar is never empty. `--label` filters by exact
 * label.
 */
export async function querySpans(file: string, query: SpansQuery): Promise<void> {
  const abs = await resolveTarget(file, "recording");
  const rec = await load(abs);
  // Prefer the recording's spans that carry a bar; reach for the sibling CPU model only when none do
  // (firefox/node without measures, or a rung-1 chrome run), where the run bar lives on
  // CpuModel.breakdown instead of on the stored spans.
  const hasBar = rec.spans?.some((span) => span.breakdown);
  let model: CpuModel | undefined;
  let cpuBreakdown: CpuBreakdown | undefined;
  if (!hasBar) {
    try {
      model = await loadCpuModel(abs);
      cpuBreakdown = model.breakdown;
    } catch {
      // No sibling CPU model: buildSpans returns null below and we report the empty case.
    }
  }
  const iterations = rec.meta.iterations ?? 1;
  const result = buildSpans(rec.spans, cpuBreakdown, recordingLane(rec.meta), iterations);
  if (!result)
    throw new Error(
      `${file} carries no per-span breakdown. Record with \`--breakdown\` (chrome), \`--target ` +
        `firefox\`, or \`--target node\` to produce span bars; the default/--deep/--precise-wall ` +
        `rungs and older recordings have none.`,
    );

  const label = query.label;
  const spans = label ? result.spans.filter((span) => span.label === label) : result.spans;

  const fmt = structuredFormat(query);
  if (fmt) return emit({ ...result, spans }, fmt);

  // Human output reuses the existing bar renderers. The stored-bars path prints the seven-slice
  // per-span table; the synthesized run bar prints the CpuModel bar, which already labels
  // style/layout and browser/native honestly for its lane.
  if (result.source === "breakdowns") {
    const barSpans = rec.spans.filter((span) => span.breakdown);
    const bars = label ? barSpans.filter((span) => span.label === label) : barSpans;
    if (!bars.length) return void console.log(`No span labelled '${label}' in ${file}.`);
    printSpanBreakdowns(bars, iterations);
  } else if (label && label !== "run") {
    return void console.log(
      `No span labelled '${label}' in ${file} (this lane carries only the 'run' bar).`,
    );
  } else {
    printCpuBreakdown(model!, iterations);
  }
  // Point drill-down at one span's full anatomy (bar + counts + forced/dirtied + hot functions) and
  // at the event log, where one exists.
  console.log(
    dim(
      `\n  • One span's anatomy (counts, forced, hot functions): wpd query span "${abs}" <label>`,
    ),
  );
  if (rec.meta.passes.includes("deep") || isGeckoRung(rec.meta.passes))
    console.log(dim(`  • The classified event log: wpd query events "${abs}" (drill: query get)`));
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
  // exists to prevent (Chrome's invalidation stacks name the WRITE: docs/dev/engine-mapping.md).
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
  return "this run captured no blame: the default and --precise-wall rungs run no trace, and --target node has no DOM; record with --deep (chrome) or --target firefox";
}

/**
 * One line saying what the `source` column of the FORCED rows points at. Without it the table
 * invites the one comparison it cannot support: the same probe blamed in both engines shares zero
 * lines, because each engine answers a different question (see BlameSemantic). Human output only --
 * structured consumers read `meta.blameSemantic` off the recording or digest, which is durable and
 * does not depend on having run this verb.
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
