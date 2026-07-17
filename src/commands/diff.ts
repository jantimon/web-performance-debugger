import { promises as fs } from "node:fs";
import path from "node:path";
import { deserialize } from "../output/format.js";
import { num, table } from "../output/ascii.js";
import { resolveTarget } from "./resolve.js";
import type { Recording, RecordingSummary } from "../model/recording.js";

// `gated` metrics participate in --fail-on-regression; `advisory` ones are printed but never
// fail the build. A metric gates only if it is REPRODUCIBLE on unchanged code, which is not the
// same as being a count:
//
//   - layout/style come from CDP counters, forced layout from trace stacks, and paint from
//     main-thread `Paint` events. Provenance is not the test; reproducibility is, and all four are
//     [measured] bit-identical across repeated runs of the same flow (layout 41, style 42, forced
//     80 on 5 runs; paint exactly N+1 for N dirtied regions on 40). Those gate. Do not widen paint
//     to raster/compositor events: their counts track the scheduler rather than the page and would
//     cost this gate its meaning (docs/dev/rendering-counts.md).
//   - wall/INP/scripting ride performance.now() (Chrome-clamped, run-to-run jitter), so gating on
//     a +0.1 ms blip would contradict the tool's own trust tiers.
//
// Advisory metrics still show in the table as a directional signal. (For a real JS-cost gate use
// `cpu-diff`, which has a sampling-noise floor.)
const METRICS: {
  label: string;
  key: keyof RecordingSummary;
  higherIsWorse: boolean;
  gated: boolean;
}[] = [
  { label: "layout", key: "layoutCount", higherIsWorse: true, gated: true },
  { label: "style", key: "styleCount", higherIsWorse: true, gated: true },
  { label: "paint", key: "paintCount", higherIsWorse: true, gated: true },
  { label: "forced layout", key: "forcedLayoutCount", higherIsWorse: true, gated: true },
  { label: "layout inval", key: "layoutInvalidations", higherIsWorse: true, gated: true },
  { label: "style inval", key: "styleInvalidations", higherIsWorse: true, gated: true },
  { label: "long tasks", key: "longTaskCount", higherIsWorse: true, gated: true },
  { label: "INP ms", key: "inpMs", higherIsWorse: true, gated: false },
  { label: "wall ms", key: "wallMs", higherIsWorse: true, gated: false },
  { label: "scripting ms", key: "scriptingMs", higherIsWorse: true, gated: false },
];

async function loadSummary(file: string): Promise<RecordingSummary> {
  const abs = await resolveTarget(file, "recording");
  const rec = deserialize(
    await fs.readFile(abs, "utf8"),
    path.extname(abs).toLowerCase(),
  ) as Recording;
  return rec.summary;
}

/** Compare two recordings field-by-field; optionally fail the process on regression. */
export async function diffCmd(
  baseline: string,
  current: string,
  opts: { failOnRegression?: boolean },
): Promise<void> {
  const [baselineSummary, currentSummary] = await Promise.all([
    loadSummary(baseline),
    loadSummary(current),
  ]);

  const rows: (string | number)[][] = [];
  const regressions: string[] = [];
  for (const metric of METRICS) {
    const baseValue = baselineSummary[metric.key] as number | null;
    const currentValue = currentSummary[metric.key] as number | null;
    // Don't conflate "not measured" (null) with 0; that invents fake regressions
    // (0 → 45) and fake improvements (300 → 0) when a metric is absent on one side.
    if (baseValue == null || currentValue == null) {
      rows.push([
        metric.label,
        baseValue == null ? "n/a" : num(baseValue),
        currentValue == null ? "n/a" : num(currentValue),
        "—",
      ]);
      continue;
    }
    const delta = currentValue - baseValue;
    const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "=";
    rows.push([
      metric.gated ? metric.label : `${metric.label} (advisory)`,
      num(baseValue),
      num(currentValue),
      `${delta >= 0 ? "+" : ""}${num(delta)} ${arrow}`,
    ]);
    // Only exact CDP counts gate the build; wall/INP/scripting are directional, not numbers
    // to fail CI on (see METRICS note).
    if (metric.gated && metric.higherIsWorse && delta > 0)
      regressions.push(
        `${metric.label}: ${num(baseValue)} → ${num(currentValue)} (+${num(delta)})`,
      );
  }

  console.log(`baseline: ${baseline}\ncurrent:  ${current}\n`);
  console.log(table(["metric", "baseline", "current", "delta"], rows));

  if (regressions.length) {
    console.log(`\n${regressions.length} regression(s):`);
    for (const regression of regressions) console.log(`  ▲ ${regression}`);
    if (opts.failOnRegression) process.exitCode = 1;
  } else {
    console.log("\nNo regressions. 🎉");
  }
}
