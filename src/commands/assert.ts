import { promises as fs } from "node:fs";
import path from "node:path";
import { deserialize } from "../output/format.js";
import { assertRecordingArtifact } from "../model/artifact.js";
import { num, table } from "../output/ascii.js";
import { resolveConsumption } from "./resolve.js";
import { loadGroup, memberLabel, memberRecordingPath } from "./group.js";
import { pickMember, type MemberAxis } from "../model/group.js";
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
  /** Every gated metric is Measured (model/measured.ts): null when the capture mode did not observe it
   * (the default mode captures no counts; --breakdown drops forced; a bench run captures no interaction),
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

/** Which member axis measures a given count/timing threshold, for a run-group's cross-member routing:
 * forced -> the deep member, the exact counts -> the counts member (deep preferred), INP/wall -> any
 * driver member (every member shares the group's lane). */
const CHECK_AXIS: Record<keyof Thresholds, MemberAxis> = {
  forced: "forced",
  layouts: "counts",
  paints: "counts",
  layoutInvalidations: "counts",
  styleInvalidations: "counts",
  longTasks: "counts",
  inp: "inp",
  wall: "inp",
};

/**
 * Gate a recording, a step-index, or a run-group against thresholds; sets exit code 1 on violation.
 * Count/timing thresholds gate the run (or each step); `sliceBudgets` (`--max-slice`) gate the target
 * span's per-slice ms -- the run span by default, `label` picks another by label. A run-group routes
 * each threshold to the member that measured its axis (assertGroup).
 */
export async function assertCmd(
  file: string,
  thresholds: Thresholds,
  sliceBudgets: SliceBudgets = {},
  label?: string,
): Promise<void> {
  // A run-group routes each threshold to the member that measured its axis; a plain recording gates
  // itself. The n/a-FAIL rule extends: no member measures the axis -> a loud FAIL, never a silent pass.
  const consumption = await resolveConsumption(file);
  if (consumption.kind === "group")
    return assertGroup(consumption.path, thresholds, sliceBudgets, label);
  const abs = consumption.path;
  const obj = deserialize(await fs.readFile(abs, "utf8"), path.extname(abs).toLowerCase()) as any;
  assertRecordingArtifact(obj, abs);

  // A stepped (driver) recording gates PER STEP, from its step spans: each step has its own wall,
  // INP and windowed counts, which is the per-interaction granularity a CI gate wants. A bench/node
  // run gates its run summary. A step whose wall could not be priced (navigated in a no-trace capture mode)
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

/**
 * Gate a run-group: route each count/timing threshold to the member that measured its axis (forced ->
 * the deep member, exact counts -> the counts member, INP/wall -> a driver member) and the slice
 * budgets to the bar member. A member column names which member answered. When NO member measures an
 * axis, the row is a loud n/a FAIL, never a silent pass -- the Measured contract, extended to a group.
 * Run-level (summary) gating; the group's members share one workload, so a per-member summary is the
 * comparable unit.
 */
async function assertGroup(
  manifestPath: string,
  thresholds: Thresholds,
  sliceBudgets: SliceBudgets,
  label?: string,
): Promise<void> {
  const group = await loadGroup(manifestPath);
  const active = CHECKS.filter((check) => thresholds[check.opt] != null);
  const sliceBudgetKeys = Object.keys(sliceBudgets);
  if (!active.length && !sliceBudgetKeys.length)
    throw new Error(
      "No thresholds given. Try --max-forced 0 --max-layouts 50 --max-slice js=5 etc.",
    );

  const violations: string[] = [];
  const rows: (string | number)[][] = [];
  // Read a member's summary at most once, so a group with several count thresholds does not re-parse it.
  const summaryCache = new Map<string, RecordingSummary>();
  const summaryOf = async (recordingPath: string): Promise<RecordingSummary> => {
    let summary = summaryCache.get(recordingPath);
    if (!summary) {
      const rec = deserialize(
        await fs.readFile(recordingPath, "utf8"),
        path.extname(recordingPath).toLowerCase(),
      ) as Recording;
      assertRecordingArtifact(rec, recordingPath);
      summary = rec.summary;
      summaryCache.set(recordingPath, summary);
    }
    return summary;
  };

  for (const check of active) {
    const max = thresholds[check.opt]!;
    const member = pickMember(group, CHECK_AXIS[check.opt]);
    if (!member) {
      violations.push(
        `${check.label}: no member measures this axis (${CHECK_AXIS[check.opt]}); cannot satisfy max ${max}`,
      );
      rows.push([check.label, "(none)", "n/a", max, "FAIL"]);
      continue;
    }
    const summary = await summaryOf(memberRecordingPath(manifestPath, member));
    const gate = gateMeasured(fromSummary(summary)[check.key], max);
    if (!gate.measured) {
      violations.push(
        `${check.label} (${memberLabel(member)}): not measured; cannot satisfy max ${max}`,
      );
      rows.push([check.label, memberLabel(member), "n/a", max, "FAIL"]);
      continue;
    }
    if (!gate.ok)
      violations.push(`${check.label} (${memberLabel(member)}): ${num(gate.value)} > ${max}`);
    rows.push([check.label, memberLabel(member), num(gate.value), max, gate.ok ? "ok" : "FAIL"]);
  }

  if (sliceBudgetKeys.length) {
    const targetLabel = label ?? "run";
    const barMember = pickMember(group, "slice-bar");
    if (!barMember) {
      for (const [slice, max] of Object.entries(sliceBudgets)) {
        violations.push(
          `${targetLabel}: --max-slice ${slice}=${max}: no member of this group built a reconciling bar`,
        );
        rows.push([`slice ${slice}`, "(none)", "n/a", max, "FAIL"]);
      }
    } else {
      const spans = await loadSpanEntries(memberRecordingPath(manifestPath, barMember));
      for (const gate of gateSliceBudgets(spans, sliceBudgets, targetLabel)) {
        rows.push([
          `slice ${gate.slice}`,
          memberLabel(barMember),
          gate.measured ? num(gate.value!) : "n/a",
          gate.max,
          gate.ok ? "ok" : "FAIL",
        ]);
        if (!gate.measured)
          violations.push(
            `${gate.target} (${memberLabel(barMember)}): --max-slice ${gate.slice}=${gate.max}: ${gate.reason}`,
          );
        else if (!gate.ok)
          violations.push(
            `${gate.target} (${memberLabel(barMember)}): ${gate.slice} slice ${num(gate.value!)} ms > ${gate.max}`,
          );
      }
    }
  }

  console.log(
    `run-group '${group.meta.name}' (each threshold routed to the member that measures it)\n`,
  );
  console.log(table(["metric", "member", "value", "max", ""], rows));
  // Group-level disclosures (count disagreement across members, partial formation): a CI reader must
  // see them, since a routed threshold gates ONE member's number while the members may have disagreed.
  for (const note of group.notes) console.log(`\n${note}`);
  if (violations.length) {
    console.log(`\n✗ ${violations.length} assertion(s) failed:`);
    for (const violation of violations) console.log(`  ✗ ${violation}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ all assertions passed");
  }
}
