// The `query spans` output adapter: fold the two stored breakdown shapes (chrome's seven-slice
// `SpanBreakdown` and the four/six-slice `CpuModel.breakdown`) into ONE unified per-span shape, so a
// cross-engine consumer joins on `label` without special-casing the engine. This is an OUTPUT
// adapter only: it never mutates or re-stores a recording, so old artifacts keep loading and yield
// spans from whatever they hold.

import type { Breakdown, CpuBreakdown, RecordingMeta, SpanBreakdown } from "./recording.js";
import type { SpanEntry, SpansResult, UnifiedSlices } from "./query.js";

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

function entryFromBreakdown(span: SpanBreakdown): SpanEntry {
  return {
    label: span.label,
    kind: span.kind,
    wallMs: span.breakdown.wallMs,
    slices: slicesFromBreakdown(span.breakdown),
    ...(span.frames ? { frames: span.frames } : {}),
    ...(span.breakdown.residualMs != null ? { residualMs: span.breakdown.residualMs } : {}),
  };
}

function runEntryFromCpuBreakdown(cpu: CpuBreakdown): SpanEntry {
  return {
    label: "run",
    kind: "run",
    wallMs: cpu.wallMs,
    slices: slicesFromCpuBreakdown(cpu),
    ...(cpu.residualMs != null ? { residualMs: cpu.residualMs } : {}),
  };
}

/**
 * Build the unified `query spans` result. Prefers the recording's stored per-span bars
 * (`recording.breakdowns`); falls back to synthesizing a single `run` span from a
 * `CpuModel.breakdown` so the verb never comes back empty when any bar exists. Returns null when the
 * recording holds neither (an old recording, or `--target node` with `--no-cpu-profile`), which the
 * caller turns into a non-zero error.
 */
export function buildSpans(
  breakdowns: SpanBreakdown[] | undefined,
  cpuBreakdown: CpuBreakdown | undefined,
  target: string,
): SpansResult | null {
  if (breakdowns?.length)
    return { target, source: "breakdowns", spans: breakdowns.map(entryFromBreakdown) };
  if (cpuBreakdown)
    return { target, source: "cpu-model", spans: [runEntryFromCpuBreakdown(cpuBreakdown)] };
  return null;
}
