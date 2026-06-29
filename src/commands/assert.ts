import { promises as fs } from "node:fs";
import path from "node:path";
import { deserialize } from "../output/format.js";
import { num, table } from "../output/ascii.js";
import { resolveTarget } from "./resolve.js";
import type { Recording, RecordingSummary, StepIndex } from "../model/recording.js";

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
  forcedLayoutCount: number;
  layoutCount: number;
  paintCount: number;
  layoutInvalidations: number;
  styleInvalidations: number;
  longTaskCount: number;
  inpMs: number | null;
  wallMs: number | null;
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

/** Gate a recording or step-index against thresholds; sets exit code 1 on violation. */
export async function assertCmd(file: string, thresholds: Thresholds): Promise<void> {
  const abs = await resolveTarget(file, "auto");
  const obj = deserialize(await fs.readFile(abs, "utf8"), path.extname(abs).toLowerCase()) as any;

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
  if (!active.length)
    throw new Error("No thresholds given. Try --max-forced 0 --max-layouts 50 etc.");

  const violations: string[] = [];
  const rows: (string | number)[][] = [];
  for (const target of targets) {
    for (const check of active) {
      const val = target.m[check.key];
      const max = thresholds[check.opt]!;
      if (val == null) {
        // A gate you asked for but can't evaluate must FAIL, not silently pass; e.g.
        // --max-inp on an in-page run that captured no interaction. Skipping it green
        // is a CI gate that doesn't gate.
        violations.push(
          `${target.label}: ${check.label} was not measured; cannot satisfy max ${max}`,
        );
        rows.push([target.label, check.label, "n/a", max, "FAIL"]);
        continue;
      }
      const ok = val <= max;
      if (!ok) violations.push(`${target.label}: ${check.label} ${num(val)} > ${max}`);
      rows.push([target.label, check.label, num(val), max, ok ? "ok" : "FAIL"]);
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
