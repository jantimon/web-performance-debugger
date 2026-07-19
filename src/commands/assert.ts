import { promises as fs } from "node:fs";
import path from "node:path";
import { deserialize } from "../output/format.js";
import { num, table } from "../output/ascii.js";
import { resolveTarget } from "./resolve.js";
import { gateMeasured, type Measured } from "../model/measured.js";
import { gateSliceBudgets, type SliceBudgets } from "../model/spans.js";
import { loadSpanEntries } from "./spanSource.js";
import type { Recording, RecordingSummary, StepIndex } from "../model/recording.js";

// Every threshold gates a `summary` field. The off-thread frame side track
// (SpanBreakdown.frames) is deliberately absent: its counts are scheduler noise (see
// docs/dev/rendering-counts.md), so it is DISPLAY-ONLY and must never gate. It also lives on the
// breakdowns, not the summary this file reads, so a frame threshold cannot be added by accident.
export interface Thresholds {
  forced?: number;
  layouts?: number;
  paints?: number;
  layoutInvalidations?: number;
  styleInvalidations?: number;
  longTasks?: number;
  inp?: number;
  wall?: number;
}

interface Metrics {
  /** Measured (model/measured.ts): null when the run did not measure forced layout (--breakdown),
   * which a gate on it turns into a loud FAIL. Same for inpMs/wallMs on lanes that never observed them. */
  forcedLayoutCount: Measured<number>;
  layoutCount: number;
  paintCount: number;
  layoutInvalidations: number;
  styleInvalidations: number;
  longTaskCount: number;
  inpMs: Measured<number>;
  wallMs: Measured<number>;
}

const CHECKS: { label: string; key: keyof Metrics; opt: keyof Thresholds }[] = [
  { label: "forced layout/style", key: "forcedLayoutCount", opt: "forced" },
  { label: "layouts", key: "layoutCount", opt: "layouts" },
  { label: "paints", key: "paintCount", opt: "paints" },
  { label: "layout invalidations", key: "layoutInvalidations", opt: "layoutInvalidations" },
  { label: "style invalidations", key: "styleInvalidations", opt: "styleInvalidations" },
  { label: "long tasks", key: "longTaskCount", opt: "longTasks" },
  { label: "INP ms", key: "inpMs", opt: "inp" },
  { label: "wall ms", key: "wallMs", opt: "wall" },
];

function fromSummary(summary: RecordingSummary): Metrics {
  return {
    forcedLayoutCount: summary.forcedLayoutCount,
    layoutCount: summary.layoutCount,
    paintCount: summary.paintCount,
    layoutInvalidations: summary.layoutInvalidations,
    styleInvalidations: summary.styleInvalidations,
    longTaskCount: summary.longTaskCount,
    inpMs: summary.inpMs,
    wallMs: summary.wallMs,
  };
}

/**
 * Gate a recording or step-index against thresholds; sets exit code 1 on violation. Count/timing
 * thresholds gate the run (or each step); `sliceBudgets` (`--max-slice`) gate the target span's
 * per-slice ms -- the run span by default, `label` picks another by label.
 */
export async function assertCmd(
  file: string,
  thresholds: Thresholds,
  sliceBudgets: SliceBudgets = {},
  label?: string,
): Promise<void> {
  const abs = await resolveTarget(file, "auto");
  const obj = deserialize(await fs.readFile(abs, "utf8"), path.extname(abs).toLowerCase()) as any;

  // A run-level driver recording has no wall by design, so `--max-wall` against it can only fail.
  // "was not measured" would be true but useless: the wall exists, one per step, in the sidecar.
  // Name the file rather than let a reader conclude the tool lost the number. A per-step recording
  // is excluded because it HAS a wall (its median), so it never reaches the null branch anyway.
  const wallIsPerStep =
    obj?.meta?.driver === true && obj?.meta?.step == null && !Array.isArray(obj.steps);

  const targets: { label: string; m: Metrics }[] = [];
  if (Array.isArray(obj.steps) && typeof obj.recording === "string") {
    const idx = obj as StepIndex;
    for (const step of idx.steps) {
      targets.push({
        label: `step ${step.index} "${step.label}"`,
        m: {
          forcedLayoutCount: step.headline.forcedLayoutCount,
          layoutCount: step.headline.layoutCount,
          paintCount: step.headline.paintCount,
          layoutInvalidations: step.headline.layoutInvalidations,
          styleInvalidations: step.headline.styleInvalidations,
          longTaskCount: step.headline.longTaskCount,
          inpMs: step.inpMs,
          wallMs: step.wallMs,
        },
      });
    }
  } else {
    targets.push({ label: "run", m: fromSummary((obj as Recording).summary) });
  }

  const active = CHECKS.filter((check) => thresholds[check.opt] != null);
  const sliceBudgetKeys = Object.keys(sliceBudgets);
  if (!active.length && !sliceBudgetKeys.length)
    throw new Error(
      "No thresholds given. Try --max-forced 0 --max-layouts 50 --max-slice js=5 etc.",
    );

  const violations: string[] = [];
  const rows: (string | number)[][] = [];
  for (const target of targets) {
    for (const check of active) {
      const max = thresholds[check.opt]!;
      const gate = gateMeasured(target.m[check.key], max);
      if (!gate.measured) {
        // A gate you asked for but can't evaluate must FAIL, not silently pass; e.g.
        // --max-inp on an in-page run that captured no interaction. Skipping it green
        // is a CI gate that doesn't gate.
        violations.push(
          wallIsPerStep && check.opt === "wall"
            ? `${target.label}: a driver run has no run-level wall (it would be prepare + every ` +
                `step + settle, mostly driver overhead). Each step has its own: assert the step ` +
                `index beside this file (<name>.index.json, or 'latest') to gate --max-wall per step.`
            : `${target.label}: ${check.label} was not measured; cannot satisfy max ${max}`,
        );
        rows.push([target.label, check.label, "n/a", max, "FAIL"]);
        continue;
      }
      if (!gate.ok) violations.push(`${target.label}: ${check.label} ${num(gate.value)} > ${max}`);
      rows.push([target.label, check.label, num(gate.value), max, gate.ok ? "ok" : "FAIL"]);
    }
  }

  // Slice budgets gate the target span's per-slice ms, a different axis from the count/timing
  // targets above: they read the recording's breakdown bar (`query spans` shape), not the summary.
  if (sliceBudgetKeys.length) {
    const spans = await loadSpanEntries(file);
    const targetLabel = label ?? "run";
    for (const gate of gateSliceBudgets(spans, sliceBudgets, targetLabel)) {
      rows.push([
        gate.target,
        gate.slice,
        gate.measured ? num(gate.value!) : "n/a",
        gate.max,
        gate.ok ? "ok" : "FAIL",
      ]);
      if (!gate.measured)
        violations.push(`${gate.target}: ${gate.reason}; cannot satisfy max ${gate.max}`);
      else if (!gate.ok)
        violations.push(`${gate.target}: ${gate.slice} slice ${num(gate.value!)} ms > ${gate.max}`);
    }
  }

  console.log(table(["target", "metric", "value", "max", ""], rows));
  if (violations.length) {
    console.log(`\n✗ ${violations.length} assertion(s) failed:`);
    for (const violation of violations) console.log(`  ✗ ${violation}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ all assertions passed");
  }
}
