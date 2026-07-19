// The `query spans` output adapter: fold the two stored breakdown shapes (chrome's seven-slice
// `SpanBreakdown` and the four/six-slice `CpuModel.breakdown`) into ONE unified per-span shape, so a
// cross-engine consumer joins on `label` without special-casing the engine. This is an OUTPUT
// adapter only: it never mutates or re-stores a recording, so old artifacts keep loading and yield
// spans from whatever they hold.

import type {
  Breakdown,
  CpuBreakdown,
  RecordingMeta,
  SpanBreakdown,
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
export function spanAggregation(kind: SpanKind, samples?: number): "first" | "sum" | "median" {
  if (kind === "run") return "sum";
  if (kind === "measure" && samples != null && samples > 1) return "median";
  return "first";
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

/** Superset slices from a stored seven-slice `Breakdown` (chrome, or firefox measure spans). Every
 * slice is measured there, so none are null. */
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

function entryFromBreakdown(span: SpanBreakdown, iterations: number): SpanEntry {
  return {
    label: span.label,
    kind: span.kind,
    wallMs: span.breakdown.wallMs,
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
 * Build the unified `query spans` result. Prefers the recording's stored per-span bars
 * (`recording.breakdowns`); falls back to synthesizing a single `run` span from a
 * `CpuModel.breakdown` so the verb never comes back empty when any bar exists. Returns null when the
 * recording holds neither (an old recording, or `--target node` with `--no-cpu-profile`), which the
 * caller turns into a non-zero error. `iterations` (the recording's `meta.iterations`) is stamped on
 * every entry alongside its `aggregation`, so a consumer can read what a span's numbers represent.
 */
export function buildSpans(
  breakdowns: SpanBreakdown[] | undefined,
  cpuBreakdown: CpuBreakdown | undefined,
  target: string,
  iterations = 1,
): SpansResult | null {
  if (breakdowns?.length)
    return {
      target,
      source: "breakdowns",
      spans: breakdowns.map((span) => entryFromBreakdown(span, iterations)),
    };
  if (cpuBreakdown)
    return {
      target,
      source: "cpu-model",
      spans: [runEntryFromCpuBreakdown(cpuBreakdown, iterations)],
    };
  return null;
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
  const span = spans?.find((candidate) => candidate.label === label) ?? null;
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
  const currentByLabel = new Map(current.map((span) => [span.label, span]));
  const baseLabels = new Set(base.map((span) => span.label));
  const spans: SpanSliceDiff["spans"] = [];
  for (const baseSpan of base) {
    const currentSpan = currentByLabel.get(baseSpan.label);
    if (!currentSpan) continue;
    const slices: SliceDelta[] = SLICE_NAMES.map((slice) => {
      const baseValue = sliceMs(baseSpan.slices, slice);
      const currentValue = sliceMs(currentSpan.slices, slice);
      const delta = baseValue != null && currentValue != null ? currentValue - baseValue : null;
      return { slice, base: baseValue, current: currentValue, delta };
    });
    spans.push({ label: baseSpan.label, slices });
  }
  return {
    spans,
    unmatchedBaseline: base
      .filter((span) => !currentByLabel.has(span.label))
      .map((span) => span.label),
    unmatchedCurrent: current
      .filter((span) => !baseLabels.has(span.label))
      .map((span) => span.label),
  };
}
