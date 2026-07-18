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
