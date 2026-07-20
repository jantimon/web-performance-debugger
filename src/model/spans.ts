// The `query spans` output adapter: fold the two stored breakdown shapes (chrome's seven-slice
// `SpanBreakdown` and the four/six-slice `CpuModel.breakdown`) into ONE unified per-span shape, so a
// cross-engine consumer joins on `label` without special-casing the engine. This is an OUTPUT
// adapter only: it never mutates or re-stores a recording, so old artifacts keep loading and yield
// spans from whatever they hold.

import type {
  Breakdown,
  CpuBreakdown,
  RecordingMeta,
  Span,
  SpanAggregation,
  SpanKind,
} from "./recording.js";
import type { SpanEntry, SpansResult, UnifiedSlices } from "./query.js";
import { gateMeasured, type Measured } from "./measured.js";

/**
 * How a span combines the recording's timed iterations. `run` is a TOTAL across every iteration (its
 * window spans the whole loop; the CpuModel-synthesized run brackets the whole timed loop), so
 * `"sum"`. `step` is windowed to the FIRST timed iteration (`MergedStep` start/end come from
 * iteration 0, so counts never scale with `--iterations`), so `"first"`. A `measure` label that
 * recurred (`samples > 1`) reports the lower-median-by-wall occurrence, so `"median"`; a single
 * occurrence stays `"first"`. At `iterations === 1` the labels coincide, but the per-kind label stays
 * the truthful description of what the numbers are. Single source of truth for the adapter and the
 * human printers.
 */
export function spanAggregation(kind: SpanKind, samples?: number): SpanAggregation {
  if (kind === "run") return "sum";
  if (kind === "measure" && samples != null && samples > 1) return "median";
  return "first";
}

/**
 * Split a `kind:label` qualifier (`run:`, `step:`, `measure:`) off a span selector, or null for a
 * bare label. Only the three span kinds qualify; a label that itself begins `foo:` is not one and
 * stays a bare label. Span identity is kind+label, so this is how a caller disambiguates a bare label
 * that collides across kinds (e.g. a user `performance.measure` literally named "run").
 */
export function parseSpanKindLabel(raw: string): { kind: SpanKind; label: string } | null {
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const prefix = raw.slice(0, colon);
  if (prefix === "run" || prefix === "step" || prefix === "measure")
    return { kind: prefix, label: raw.slice(colon + 1) };
  return null;
}

/**
 * Resolve a span selector -- a `kind:label` qualifier or a bare label -- to ONE span, honoring span
 * identity = kind+label. A bare label matching more than one kind throws, listing the qualified
 * forms, rather than silently joining whichever comes first (the collision a user measure named "run"
 * would otherwise cause with the run span). Returns null when nothing matches.
 */
export function resolveSpanSelector(spans: SpanEntry[], selector: string): SpanEntry | null {
  const qualifier = parseSpanKindLabel(selector);
  const wantedLabel = qualifier?.label ?? selector;
  const wantedKind = qualifier?.kind;
  const matches = spans.filter(
    (span) => span.label === wantedLabel && (wantedKind == null || span.kind === wantedKind),
  );
  if (matches.length > 1) {
    const forms = matches.map((span) => `${span.kind}:${span.label}`).join(", ");
    throw new Error(
      `'${selector}' matches ${matches.length} spans of different kinds: ${forms}. Re-run with the ` +
        `qualified form, e.g. ${matches[0].kind}:${wantedLabel}.`,
    );
  }
  return matches[0] ?? null;
}

/**
 * The engine lane a recording was produced on -- the `--target` axis, "chrome" | "firefox" |
 * "node". Derived from `meta.browser`/`meta.runtime`, NOT from `meta.target` (which holds the
 * recorded module/url/html path, a different thing). Absent browser/runtime => the chrome default,
 * so old recordings resolve correctly.
 */
export function recordingLane(meta: Pick<RecordingMeta, "browser" | "runtime">): string {
  if (meta.runtime === "node") return "node";
  if (meta.browser === "firefox") return "firefox";
  return "chrome";
}

/** Superset slices from a stored seven-slice `Breakdown` (chrome, or firefox measure spans). On
 * firefox `paint` is not-measured (off-main-thread) and stays null; read slices through `sliceMs`,
 * never bare `.ms`. */
function slicesFromBreakdown(breakdown: Breakdown): UnifiedSlices {
  const { js, style, layout, paint, gc, other, idle } = breakdown.slices;
  return { js, style, layout, paint, gc, other, idle };
}

/** Superset slices from a `CpuModel.breakdown`. `style`/`layout` are present only on the firefox
 * six-slice bar (null on the node four-slice), `paint` is not a concept this bar carries (always
 * null), and `browser` is the unified `other`. Not-measured is an explicit null, never a fake 0. */
function slicesFromCpuBreakdown(cpu: CpuBreakdown): UnifiedSlices {
  return {
    js: cpu.slices.js,
    style: cpu.slices.style ?? null,
    layout: cpu.slices.layout ?? null,
    paint: null,
    gc: cpu.slices.gc,
    other: cpu.slices.browser,
    idle: cpu.slices.idle,
  };
}

/** A stored span that carries a reconciling bar (its `breakdown` is present). */
type BarSpan = Span & { breakdown: NonNullable<Span["breakdown"]> };

function entryFromSpan(span: BarSpan, iterations: number): SpanEntry {
  return {
    label: span.label,
    kind: span.kind,
    wallMs: span.breakdown.wallMs,
    // Derived from kind + occurrence count, identical to the `aggregation` buildRecordingSpans stored;
    // deriving here keeps a hand-built bar (no stored aggregation) legible too.
    aggregation: spanAggregation(span.kind, span.samples),
    iterations,
    slices: slicesFromBreakdown(span.breakdown),
    ...(span.frames ? { frames: span.frames } : {}),
    ...(span.breakdown.residualMs != null ? { residualMs: span.breakdown.residualMs } : {}),
    // Disclosure of a merged `measure` bar; absent (single occurrence) leaves an old-shape entry.
    ...(span.samples != null ? { samples: span.samples } : {}),
    ...(span.wallMinMs != null ? { wallMinMs: span.wallMinMs } : {}),
    ...(span.wallMaxMs != null ? { wallMaxMs: span.wallMaxMs } : {}),
  };
}

function runEntryFromCpuBreakdown(cpu: CpuBreakdown, iterations: number): SpanEntry {
  return {
    label: "run",
    kind: "run",
    wallMs: cpu.wallMs,
    aggregation: spanAggregation("run"),
    iterations,
    slices: slicesFromCpuBreakdown(cpu),
    ...(cpu.residualMs != null ? { residualMs: cpu.residualMs } : {}),
  };
}

/**
 * Build the unified `query spans` result. Prefers the recording's spans that carry a reconciling bar
 * (`span.breakdown`); falls back to synthesizing a single `run` span from a
 * `CpuModel.breakdown` so the verb never comes back empty when any bar exists. Returns null when the
 * recording holds neither (an old recording, or a sampler-off capture mode like --deep/--precise-wall),
 * which the caller turns into a non-zero error. `iterations` (the recording's `meta.iterations`) is stamped on
 * every entry alongside its `aggregation`, so a consumer can read what a span's numbers represent.
 */
export function buildSpans(
  spans: Span[] | undefined,
  cpuBreakdown: CpuBreakdown | undefined,
  target: string,
  iterations = 1,
): SpansResult | null {
  // Only spans the capture mode built a reconciling bar for carry slices; a step/run in the default or
  // --deep capture mode has counts but no bar, so it is not a `query spans` entry (the CpuModel run bar is the
  // fallback below). buildRecordingSpans always emits at least the run span, so `spans.length` alone
  // is not the test -- a bar must be present.
  const barSpans = (spans ?? []).filter((span): span is BarSpan => span.breakdown != null);
  if (barSpans.length)
    return {
      target,
      source: "breakdowns",
      spans: barSpans.map((span) => entryFromSpan(span, iterations)),
    };
  if (cpuBreakdown)
    return {
      target,
      source: "cpu-model",
      spans: [runEntryFromCpuBreakdown(cpuBreakdown, iterations)],
    };
  return null;
}

// --- query spans: filtering the overview ---

/**
 * How `query spans` narrows a flooded overview. A production tag manager can emit hundreds of tiny
 * `performance.measure` spans that bury the run/steps/app measures; these two knobs cut the noise.
 * Both are optional and combine with AND. Read-only: filtering never mutates or re-stores a recording.
 */
export interface SpanFilterOptions {
  /** hide spans whose wall is below this many ms (the sub-N-ms tracking noise) */
  minWallMs?: number;
  /** keep only spans whose label contains this text (case-insensitive substring) */
  labelIncludes?: string;
}

/** The kept spans plus how many the filter removed. `hidden` is always disclosed, never a silent cut. */
export interface FilteredSpans {
  spans: SpanEntry[];
  hidden: number;
}

/**
 * Whether one span survives the filter. Shared by the unified `query spans` view and its human bar
 * table so both hide exactly the same spans. An empty/absent `labelIncludes` matches everything; a
 * span whose wall equals `minWallMs` is kept (the threshold is a floor, not a strict cut).
 */
export function spanPassesFilter(
  label: string,
  wallMs: number,
  filter: SpanFilterOptions,
): boolean {
  const needle = filter.labelIncludes?.toLowerCase();
  if (needle && !label.toLowerCase().includes(needle)) return false;
  if (filter.minWallMs != null && wallMs < filter.minWallMs) return false;
  return true;
}

/** Apply `spanPassesFilter` across the unified entries, returning the survivors and the hidden count. */
export function filterSpanEntries(spans: SpanEntry[], filter: SpanFilterOptions): FilteredSpans {
  const kept = spans.filter((span) => spanPassesFilter(span.label, span.wallMs, filter));
  return { spans: kept, hidden: spans.length - kept.length };
}

// --- Slice reading: the vocabulary and ms accessor `assert --max-slice` and `diff` share ---

/**
 * The seven unified slice names, in the reconciling bar's order (js first, idle last). This is the
 * valid vocabulary for `--max-slice <name>=<ms>` and the axis `diff` walks per matched span, so a
 * slice budget and a slice delta read the SAME shape `query spans` reports.
 */
export const SLICE_NAMES = ["js", "style", "layout", "paint", "gc", "other", "idle"] as const;
export type SliceName = (typeof SLICE_NAMES)[number];

export function isSliceName(name: string): name is SliceName {
  return (SLICE_NAMES as readonly string[]).includes(name);
}

/**
 * The ms of one unified slice, honoring the Measured contract (model/measured.ts): a slice the lane
 * did not observe is `null` (never a fabricated 0), so a gate treats it as not-measured and a diff
 * refuses to invent a delta. A measured 0 stays 0, distinct from not-measured.
 */
export function sliceMs(slices: UnifiedSlices, slice: SliceName): Measured<number> {
  const value = slices[slice];
  return value == null ? null : value.ms;
}

// --- assert: per-slice budgets ---

/** A slice->ms budget map parsed from repeated `--max-slice`. ms is wall-tier (~1%), directional. */
export type SliceBudgets = Partial<Record<SliceName, number>>;

/**
 * Parse repeated `--max-slice <name>=<ms>` entries into a budget map. Throws on a malformed entry or
 * an unknown slice name (the CLI surfaces it as a usage error listing the valid names). ms may be
 * fractional: a slice budget is a wall-tier directional gate, not a count.
 */
export function parseSliceBudgets(entries: string[]): SliceBudgets {
  const budgets: SliceBudgets = {};
  for (const entry of entries) {
    const equals = entry.indexOf("=");
    if (equals <= 0)
      throw new Error(`--max-slice expects <name>=<ms> (e.g. js=5), got '${entry}'.`);
    const name = entry.slice(0, equals).trim();
    const rawMs = entry.slice(equals + 1).trim();
    if (!isSliceName(name))
      throw new Error(`Unknown slice '${name}'. Valid slices: ${SLICE_NAMES.join(", ")}.`);
    if (!/^\d+(\.\d+)?$/.test(rawMs))
      throw new Error(`--max-slice ${name}= expects a non-negative number of ms, got '${rawMs}'.`);
    budgets[name] = parseFloat(rawMs);
  }
  return budgets;
}

/** One budget's verdict against the target span. `measured: false` is a loud FAIL, never a pass. */
export interface SliceGateResult {
  target: string;
  slice: SliceName;
  max: number;
  measured: boolean;
  value: number | null;
  ok: boolean;
  /** why the gate could not be evaluated (span missing, or slice not measured); set when !measured */
  reason?: string;
}

/**
 * Gate a target span's slice ms against per-slice budgets. The target defaults to the run span;
 * `label` picks another by label. A budget on a slice the recording did not measure -- or on a label
 * that is not present -- is a loud FAIL (Measured contract: "cannot evaluate" is not "within
 * budget"), never a silent skip. Budgets are walked in insertion order (the order they were passed).
 */
export function gateSliceBudgets(
  spans: SpanEntry[] | null,
  budgets: SliceBudgets,
  label: string,
): SliceGateResult[] {
  // Span identity is kind+label: resolve on both, so a `--label` collision (a user measure named
  // "run" alongside the run span) is a loud error listing the qualified forms, never a silent join.
  const span = spans ? resolveSpanSelector(spans, label) : null;
  const results: SliceGateResult[] = [];
  for (const [sliceKey, max] of Object.entries(budgets) as [SliceName, number][]) {
    if (!span) {
      results.push({
        target: label,
        slice: sliceKey,
        max,
        measured: false,
        value: null,
        ok: false,
        reason: spans?.length
          ? `no span labelled '${label}' in this recording`
          : "this recording carries no per-span breakdown (record with --breakdown, --target " +
            "firefox, or --target node)",
      });
      continue;
    }
    const gate = gateMeasured(sliceMs(span.slices, sliceKey), max);
    if (!gate.measured) {
      results.push({
        target: label,
        slice: sliceKey,
        max,
        measured: false,
        value: null,
        ok: false,
        reason: `${sliceKey} slice was not measured on this lane`,
      });
      continue;
    }
    results.push({
      target: label,
      slice: sliceKey,
      max,
      measured: true,
      value: gate.value,
      ok: gate.ok,
    });
  }
  return results;
}

// --- diff: per-span slice deltas ---

/** One slice's delta across two recordings. `delta` is null unless BOTH sides measured the slice. */
export interface SliceDelta {
  slice: SliceName;
  base: number | null;
  current: number | null;
  /** current - base when both sides measured the slice; null otherwise (never a fabricated regression) */
  delta: number | null;
}

/** The per-span slice-delta section of a diff: matched spans, plus the labels present on one side only. */
export interface SpanSliceDiff {
  spans: { label: string; slices: SliceDelta[] }[];
  unmatchedBaseline: string[];
  unmatchedCurrent: string[];
}

/**
 * Match spans by label across two recordings and compute per-slice ms deltas. Advisory only: slice
 * ms is wall-tier (~1%), so these are directional, never a gate. A slice not measured on one side
 * yields a null delta (never a fabricated regression, per the Measured contract). Labels present on
 * only one side are reported, not errors.
 */
export function diffSpanSlices(
  baseSpans: SpanEntry[] | null,
  currentSpans: SpanEntry[] | null,
): SpanSliceDiff {
  const base = baseSpans ?? [];
  const current = currentSpans ?? [];
  // Join on kind+label, span identity: a user `performance.measure` named "run" must not collide with
  // the run span. The displayed label is the qualified `kind:label` so a collision is visible.
  const spanKey = (span: SpanEntry): string => `${span.kind}:${span.label}`;
  const currentByKey = new Map(current.map((span) => [spanKey(span), span]));
  const baseKeys = new Set(base.map(spanKey));
  const spans: SpanSliceDiff["spans"] = [];
  for (const baseSpan of base) {
    const currentSpan = currentByKey.get(spanKey(baseSpan));
    if (!currentSpan) continue;
    const slices: SliceDelta[] = SLICE_NAMES.map((slice) => {
      const baseValue = sliceMs(baseSpan.slices, slice);
      const currentValue = sliceMs(currentSpan.slices, slice);
      const delta = baseValue != null && currentValue != null ? currentValue - baseValue : null;
      return { slice, base: baseValue, current: currentValue, delta };
    });
    spans.push({ label: spanKey(baseSpan), slices });
  }
  return {
    spans,
    unmatchedBaseline: base.filter((span) => !currentByKey.has(spanKey(span))).map(spanKey),
    unmatchedCurrent: current.filter((span) => !baseKeys.has(spanKey(span))).map(spanKey),
  };
}
