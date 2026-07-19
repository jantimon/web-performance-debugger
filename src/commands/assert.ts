import { promises as fs } from "node:fs";
import path from "node:path";
import { deserialize } from "../output/format.js";
import { assertRecordingArtifact } from "../model/artifact.js";
import { num, table } from "../output/ascii.js";
import { resolveTarget } from "./resolve.js";
import { gateMeasured, type Measured } from "../model/measured.js";
import { gateSliceBudgets, type SliceBudgets } from "../model/spans.js";
import { loadSpanEntries } from "./spanSource.js";
import { isSteppedRecording, stepEntry, stepSpans } from "../model/step-view.js";
import type { Recording, RecordingSummary, StepIndexEntry } from "../model/recording.js";

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
  /** Every gated metric is Measured (model/measured.ts): null when the rung did not observe it (the
   * default rung captures no counts; --breakdown drops forced; a bench run captures no interaction),
   * which `gateMeasured` turns into a loud FAIL -- a gate you asked for but cannot evaluate has not passed. */
  forcedLayoutCount: Measured<number>;
  layoutCount: Measured<number>;
  paintCount: Measured<number>;
  layoutInvalidations: Measured<number>;
  styleInvalidations: Measured<number>;
  longTaskCount: Measured<number>;
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

function fromStep(step: StepIndexEntry): Metrics {
  return {
    forcedLayoutCount: step.headline.forcedLayoutCount,
    layoutCount: step.headline.layoutCount,
    paintCount: step.headline.paintCount,
    layoutInvalidations: step.headline.layoutInvalidations,
    styleInvalidations: step.headline.styleInvalidations,
    longTaskCount: step.headline.longTaskCount,
    inpMs: step.inpMs,
    wallMs: step.wallMs,
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
  assertRecordingArtifact(obj, abs);

  // A stepped (driver) recording gates PER STEP, from its step spans: each step has its own wall,
  // INP and windowed counts, which is the per-interaction granularity a CI gate wants. A bench/node
  // run gates its run summary. A step whose wall could not be priced (navigated on a no-trace rung)
  // is Measured null, so `--max-wall` there is a loud FAIL, not a silent pass.
  const rec = obj as Recording;
  const stepped = isSteppedRecording(rec);
  const targets: { label: string; m: Metrics }[] = [];
  if (stepped) {
    for (const step of stepSpans(rec)) {
      const entry = stepEntry(step);
      targets.push({ label: `step ${entry.index} "${entry.label}"`, m: fromStep(entry) });
    }
  } else {
    targets.push({ label: "run", m: fromSummary(rec.summary) });
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
          `${target.label}: ${check.label} was not measured; cannot satisfy max ${max}`,
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
    // The slice data lives on the recording's spans (the run bar by default; `label` picks another).
    const spans = await loadSpanEntries(abs);
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
        violations.push(`${gate.target}: --max-slice ${gate.slice}=${gate.max}: ${gate.reason}`);
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
