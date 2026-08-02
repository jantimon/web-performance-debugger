import { promises as fs } from "node:fs";
import path from "node:path";
import { deserialize, emit, structuredFormat, type StructuredOutOpts } from "../output/format.js";
import { assertRecordingArtifact } from "../model/artifact.js";
import { num, table } from "../output/ascii.js";
import type { AssertAxis, AssertThresholdRow, AssertView } from "../model/query.js";
import { resolveConsumption } from "./resolve.js";
import { loadGroup, memberLabel, memberRecordingPath } from "./group.js";
import { pickMember, type MemberAxis } from "../model/group.js";
import { gateMeasured, type Measured } from "../model/measured.js";
import { countIntegrityRefusal } from "../model/count-integrity.js";
import { gateSliceBudgets, type SliceBudgets, type SliceGateResult } from "../model/spans.js";
import { loadAllocModel } from "../profile/allocprofile.js";
import { loadSpanEntries } from "./spanSource.js";
import { isSteppedRecording, stepEntry, stepSpans } from "../model/step-view.js";
import { runSpan } from "../model/span.js";
import type { Recording, StepIndexEntry } from "../model/recording.js";

/**
 * Every threshold gates a run-span count/timing field (the schema-5 count store). The off-thread
 * frame side track (SpanBreakdown.frames) is deliberately absent: its counts are scheduler noise (see
 * docs/dev/rendering-counts.md), so it is DISPLAY-ONLY and must never gate. It also lives on the
 * breakdown, not the run-span counts this file reads, so a frame threshold cannot be added by accident
 */
export interface Thresholds {
  forced?: number;
  layouts?: number;
  paints?: number;
  layoutInvalidations?: number;
  styleInvalidations?: number;
  longTasks?: number;
  inp?: number;
  wall?: number;
  /** --max-alloc-mb: the total sampled allocated MB (an --alloc recording's sidecar model, NOT a
   * run-span count), gated on its own `alloc` axis. n/a-FAIL when the recording carries no alloc model */
  allocMb?: number;
}

interface Metrics {
  /** Every gated metric is Measured (model/measured.ts): null when the capture mode did not observe it
   * (the default mode captures no counts; --breakdown drops forced; a bench run captures no interaction),
   * which `gateMeasured` turns into a loud FAIL -- a gate you asked for but cannot evaluate has not passed */
  forcedLayoutCount: Measured<number>;
  layoutCount: Measured<number>;
  paintCount: Measured<number>;
  layoutInvalidations: Measured<number>;
  styleInvalidations: Measured<number>;
  longTaskCount: Measured<number>;
  inpMs: Measured<number>;
  wallMs: Measured<number>;
}

/** The count/timing threshold keys, i.e. every threshold EXCEPT the sidecar `allocMb` (which is gated
 * off the alloc model, not a run-span field, so it never rides the CHECKS/CHECK_AXIS machinery) */
type CheckOpt = Exclude<keyof Thresholds, "allocMb">;

const CHECKS: { label: string; key: keyof Metrics; opt: CheckOpt }[] = [
  { label: "forced layout/style", key: "forcedLayoutCount", opt: "forced" },
  { label: "layouts", key: "layoutCount", opt: "layouts" },
  { label: "paints", key: "paintCount", opt: "paints" },
  { label: "layout invalidations", key: "layoutInvalidations", opt: "layoutInvalidations" },
  { label: "style invalidations", key: "styleInvalidations", opt: "styleInvalidations" },
  { label: "long tasks", key: "longTaskCount", opt: "longTasks" },
  { label: "INP ms", key: "inpMs", opt: "inp" },
  { label: "wall ms", key: "wallMs", opt: "wall" },
];

/** Run-level metrics from the run span (schema-5 count/timing store); every not-measured field is a
 * Measured null, the same n/a-FAIL the summary path produced. Null run span (an empty artifact) makes
 * every axis n/a */
function fromRunSpan(rec: Recording): Metrics {
  const run = runSpan(rec);
  const counts = run?.counts;
  return {
    forcedLayoutCount: counts?.forcedLayoutCount ?? null,
    layoutCount: counts?.layoutCount ?? null,
    paintCount: counts?.paintCount ?? null,
    layoutInvalidations: counts?.layoutInvalidations ?? null,
    styleInvalidations: counts?.styleInvalidations ?? null,
    longTaskCount: counts?.longTaskCount ?? null,
    inpMs: run?.inpMs ?? null,
    wallMs: run?.wallMs ?? null,
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

/** The count and count-derived thresholds: each gates a trace-derived rendering count. Kept apart
 * from the timing thresholds (inp/wall, which ride performance.now, not the trace counts) so the
 * count-integrity refusal below fires ONLY on the counts a split/data-loss run cannot be trusted for */
const COUNT_CHECK_OPTS: ReadonlySet<CheckOpt> = new Set([
  "forced",
  "layouts",
  "paints",
  "layoutInvalidations",
  "styleInvalidations",
  "longTasks",
]);

/** The verdict for one count/timing threshold against one target: a not-gateable refusal (known
 * -incomplete counts), a not-measured n/a, or a measured ok/fail carrying its number */
type CheckOutcome =
  | { kind: "refuse"; reason: string }
  | { kind: "na" }
  | { kind: "ok"; value: number }
  | { kind: "fail"; value: number };

/** Gate one Measured value: a count on a known-incomplete recording REFUSES; else the Measured gate
 * (null => n/a, number => ok/fail). `isCount` gates the refusal to the count axis (timing is exempt) */
function evaluateCheck(
  value: Measured<number>,
  max: number,
  isCount: boolean,
  integrityRefusal: string | null,
): CheckOutcome {
  if (isCount && integrityRefusal) return { kind: "refuse", reason: integrityRefusal };
  const gate = gateMeasured(value, max);
  if (!gate.measured) return { kind: "na" };
  return gate.ok ? { kind: "ok", value: gate.value } : { kind: "fail", value: gate.value };
}

/** The value cell + verdict cell for a table row (a refusal and an n/a both render "n/a"/"FAIL") */
function outcomeCells(outcome: CheckOutcome): { value: string | number; verdict: string } {
  switch (outcome.kind) {
    case "refuse":
    case "na":
      return { value: "n/a", verdict: "FAIL" };
    case "ok":
      return { value: num(outcome.value), verdict: "ok" };
    case "fail":
      return { value: num(outcome.value), verdict: "FAIL" };
  }
}

/** The violation line for a failing/refused/na outcome, or null when it passed. `prefix` names the
 * target + metric (+ member, in a group), so a CI reader sees exactly which gate could not be met */
function outcomeViolation(outcome: CheckOutcome, prefix: string, max: number): string | null {
  switch (outcome.kind) {
    case "refuse":
      return `${prefix} not gateable: ${outcome.reason} (cannot satisfy max ${max})`;
    case "na":
      return `${prefix} was not measured; cannot satisfy max ${max}`;
    case "fail":
      return `${prefix} ${num(outcome.value)} > ${max}`;
    case "ok":
      return null;
  }
}

/** The threshold family a count/timing check gates (slice budgets are their own `slice` axis) */
function checkAxis(opt: CheckOpt): AssertAxis {
  return COUNT_CHECK_OPTS.has(opt) ? "count" : "timing";
}

/** The structured row for a count/timing outcome: the JSON mirror of `outcomeCells`/`outcomeViolation`
 * (value null on an n/a/refuse, the verdict three-way). `member` is set only for a run-group */
function outcomeRow(
  target: string,
  metric: string,
  axis: AssertAxis,
  budget: number,
  outcome: CheckOutcome,
  member?: string,
): AssertThresholdRow {
  const row: AssertThresholdRow = (() => {
    switch (outcome.kind) {
      case "ok":
        return { target, metric, axis, budget, value: outcome.value, verdict: "pass" };
      case "fail":
        return { target, metric, axis, budget, value: outcome.value, verdict: "fail" };
      case "na":
        return {
          target,
          metric,
          axis,
          budget,
          value: null,
          verdict: "n/a-fail",
          reason: "not measured",
        };
      case "refuse":
        return {
          target,
          metric,
          axis,
          budget,
          value: null,
          verdict: "n/a-fail",
          reason: outcome.reason,
        };
    }
  })();
  if (member) row.member = member;
  return row;
}

/** The structured row for a slice-budget gate (`--max-slice`): its own `slice` axis, value null when
 * the capture mode did not build a bar for the slice (a loud n/a-fail) */
function sliceRow(gate: SliceGateResult, member?: string): AssertThresholdRow {
  const row: AssertThresholdRow = gate.measured
    ? {
        target: gate.target,
        metric: gate.slice,
        axis: "slice",
        budget: gate.max,
        value: gate.value!,
        verdict: gate.ok ? "pass" : "fail",
      }
    : {
        target: gate.target,
        metric: gate.slice,
        axis: "slice",
        budget: gate.max,
        value: null,
        verdict: "n/a-fail",
        reason: gate.reason,
      };
  if (member) row.member = member;
  return row;
}

const MB = 1024 * 1024;

/** Gate the total sampled allocated MB (--max-alloc-mb) against a recording's sibling alloc model
 * (loadAllocModel). A recording with no alloc model (a chrome or node-cpu capture) is a loud n/a-fail,
 * never a silent pass -- the Measured contract, on the allocation axis. A schema mismatch still throws
 * (re-record), so only the "no alloc model" case (code ENOALLOCMODEL) becomes an n/a-fail. Returns the
 * structured row, the human table row, and the violation line (null on pass) */
async function gateAlloc(
  recordingPath: string,
  budgetMb: number,
  member?: string,
): Promise<{ row: AssertThresholdRow; humanRow: (string | number)[]; violation: string | null }> {
  const prefix = member ? `allocation MB (${member})` : "run: allocation MB";
  let totalMb: number | null = null;
  try {
    const model = await loadAllocModel(recordingPath);
    totalMb = model.totalBytes / MB;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOALLOCMODEL") throw error;
  }
  if (totalMb == null) {
    const row: AssertThresholdRow = {
      target: "run",
      metric: "allocation MB",
      axis: "alloc",
      budget: budgetMb,
      value: null,
      verdict: "n/a-fail",
      reason: "no allocation model (record with --target node --alloc)",
    };
    if (member) row.member = member;
    return {
      row,
      humanRow: ["run", "allocation MB", "n/a", budgetMb, "FAIL"],
      violation: `${prefix} was not measured (no allocation model; record with --target node --alloc); cannot satisfy max ${budgetMb}`,
    };
  }
  const ok = totalMb <= budgetMb;
  const row: AssertThresholdRow = {
    target: "run",
    metric: "allocation MB",
    axis: "alloc",
    budget: budgetMb,
    value: totalMb,
    verdict: ok ? "pass" : "fail",
  };
  if (member) row.member = member;
  return {
    row,
    humanRow: ["run", "allocation MB", num(totalMb), budgetMb, ok ? "ok" : "FAIL"],
    violation: ok ? null : `${prefix} ${num(totalMb)} > ${budgetMb}`,
  };
}

/** Emit the structured view, or print the human report; set exit 1 on any violation either way. The
 * exit code is identical across both outputs, so a JSON consumer and a table reader gate the same */
function finishAssert(
  view: AssertView,
  humanReport: () => void,
  fmt: ReturnType<typeof structuredFormat>,
): void {
  if (fmt) emit(view, fmt);
  else humanReport();
  if (!view.passed) process.exitCode = 1;
}

/** Which member axis measures a given count/timing threshold, for a run-group's cross-member routing:
 * forced -> the deep member, the exact counts -> the counts member (deep preferred), INP/wall -> any
 * driver member (every member shares the group's lane) */
const CHECK_AXIS: Record<CheckOpt, MemberAxis> = {
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
 * each threshold to the member that measured its axis (assertGroup)
 */
export async function assertCmd(
  file: string,
  thresholds: Thresholds,
  sliceBudgets: SliceBudgets = {},
  label?: string,
  opts: StructuredOutOpts = {},
): Promise<void> {
  const fmt = structuredFormat(opts);
  // A run-group routes each threshold to the member that measured its axis; a plain recording gates
  // itself. The n/a-FAIL rule extends: no member measures the axis -> a loud FAIL, never a silent pass
  const consumption = await resolveConsumption(file);
  if (consumption.kind === "group")
    return assertGroup(consumption.path, thresholds, sliceBudgets, label, fmt);
  const abs = consumption.path;
  const obj = deserialize(await fs.readFile(abs, "utf8"), path.extname(abs).toLowerCase()) as any;
  assertRecordingArtifact(obj, abs);

  // A stepped (driver) recording gates PER STEP, from its step spans: each step has its own wall,
  // INP and windowed counts, which is the per-interaction granularity a CI gate wants. A bench/node
  // run gates its run summary. A step whose wall could not be priced (navigated in a no-trace capture mode)
  // is Measured null, so `--max-wall` there is a loud FAIL, not a silent pass
  const rec = obj as Recording;
  const stepped = isSteppedRecording(rec);
  const targets: { label: string; m: Metrics }[] = [];
  if (stepped) {
    for (const step of stepSpans(rec)) {
      const entry = stepEntry(step);
      targets.push({ label: `step ${entry.index} "${entry.label}"`, m: fromStep(entry) });
    }
  } else {
    targets.push({ label: "run", m: fromRunSpan(rec) });
  }

  const active = CHECKS.filter((check) => thresholds[check.opt] != null);
  const sliceBudgetKeys = Object.keys(sliceBudgets);
  if (!active.length && !sliceBudgetKeys.length && thresholds.allocMb == null)
    throw new Error(
      "No thresholds given. Try --max-forced 0 --max-layouts 50 --max-slice js=5 --max-alloc-mb 20 etc.",
    );

  // A cross-process split or a trace-buffer overflow leaves the counts known-incomplete: the count
  // thresholds below are then not gateable (a loud refusal, never a silent pass). Timing thresholds
  // still gate. Null on a whole recording
  const integrityRefusal = countIntegrityRefusal(rec.meta);

  const violations: string[] = [];
  const rows: (string | number)[][] = [];
  const thresholdRows: AssertThresholdRow[] = [];
  for (const target of targets) {
    for (const check of active) {
      const max = thresholds[check.opt]!;
      // A gate you asked for but can't evaluate must FAIL, not silently pass: a not-measured axis
      // (--max-inp on an in-page run that captured no interaction), or a count axis on a
      // known-incomplete recording. Skipping it green is a CI gate that doesn't gate
      const outcome = evaluateCheck(
        target.m[check.key],
        max,
        COUNT_CHECK_OPTS.has(check.opt),
        integrityRefusal,
      );
      const cells = outcomeCells(outcome);
      const violation = outcomeViolation(outcome, `${target.label}: ${check.label}`, max);
      if (violation) violations.push(violation);
      rows.push([target.label, check.label, cells.value, max, cells.verdict]);
      thresholdRows.push(outcomeRow(target.label, check.label, checkAxis(check.opt), max, outcome));
    }
  }

  // Slice budgets gate the target span's per-slice ms, a different axis from the count/timing
  // targets above: they read the recording's breakdown bar (`query spans` shape), not the summary
  if (sliceBudgetKeys.length) {
    // The slice data lives on the recording's spans (the run bar by default; `label` picks another)
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
      thresholdRows.push(sliceRow(gate));
      if (!gate.measured)
        violations.push(`${gate.target}: --max-slice ${gate.slice}=${gate.max}: ${gate.reason}`);
      else if (!gate.ok)
        violations.push(`${gate.target}: ${gate.slice} slice ${num(gate.value!)} ms > ${gate.max}`);
    }
  }

  // The allocation budget gates the whole run's total sampled MB, from the sibling alloc model (not a
  // run-span field). n/a-FAIL on a recording with no alloc model, so --max-alloc-mb on the wrong
  // capture is a loud FAIL, not a silent pass
  if (thresholds.allocMb != null) {
    const gate = await gateAlloc(abs, thresholds.allocMb);
    rows.push(gate.humanRow);
    thresholdRows.push(gate.row);
    if (gate.violation) violations.push(gate.violation);
  }

  const view: AssertView = {
    target: abs,
    kind: "recording",
    thresholds: thresholdRows,
    passed: violations.length === 0,
    violations,
    notes: [],
  };
  finishAssert(
    view,
    () => {
      console.log(table(["target", "metric", "value", "max", ""], rows));
      if (violations.length) {
        console.log(`\n✗ ${violations.length} assertion(s) failed:`);
        for (const violation of violations) console.log(`  ✗ ${violation}`);
      } else {
        console.log("\n✓ all assertions passed");
      }
    },
    fmt,
  );
}

/**
 * Gate a run-group: route each count/timing threshold to the member that measured its axis (forced ->
 * the deep member, exact counts -> the counts member, INP/wall -> a driver member) and the slice
 * budgets to the bar member. A member column names which member answered. When NO member measures an
 * axis, the row is a loud n/a FAIL, never a silent pass -- the Measured contract, extended to a group.
 * Run-level (summary) gating; the group's members share one workload, so a per-member summary is the
 * comparable unit
 */
async function assertGroup(
  manifestPath: string,
  thresholds: Thresholds,
  sliceBudgets: SliceBudgets,
  label?: string,
  fmt: ReturnType<typeof structuredFormat> = null,
): Promise<void> {
  const group = await loadGroup(manifestPath);
  const active = CHECKS.filter((check) => thresholds[check.opt] != null);
  const sliceBudgetKeys = Object.keys(sliceBudgets);
  if (!active.length && !sliceBudgetKeys.length && thresholds.allocMb == null)
    throw new Error(
      "No thresholds given. Try --max-forced 0 --max-layouts 50 --max-slice js=5 --max-alloc-mb 20 etc.",
    );

  const violations: string[] = [];
  const rows: (string | number)[][] = [];
  const thresholdRows: AssertThresholdRow[] = [];
  // Read a member's recording at most once, so a group with several thresholds routed to it does not
  // re-parse it. The full recording (not just the summary): a stepped driver member gates PER STEP,
  // and meta.mainThread/dataLoss drive the count-integrity refusal
  const recCache = new Map<string, Recording>();
  const recOf = async (recordingPath: string): Promise<Recording> => {
    let rec = recCache.get(recordingPath);
    if (!rec) {
      rec = deserialize(
        await fs.readFile(recordingPath, "utf8"),
        path.extname(recordingPath).toLowerCase(),
      ) as Recording;
      assertRecordingArtifact(rec, recordingPath);
      recCache.set(recordingPath, rec);
    }
    return rec;
  };

  for (const check of active) {
    const max = thresholds[check.opt]!;
    const member = pickMember(group, CHECK_AXIS[check.opt]);
    if (!member) {
      violations.push(
        `${check.label}: no member measures this axis (${CHECK_AXIS[check.opt]}); cannot satisfy max ${max}`,
      );
      rows.push([check.label, "(none)", "n/a", max, "FAIL"]);
      thresholdRows.push({
        target: "run",
        metric: check.label,
        axis: checkAxis(check.opt),
        budget: max,
        value: null,
        verdict: "n/a-fail",
        reason: `no member measures this axis (${CHECK_AXIS[check.opt]})`,
      });
      continue;
    }
    const rec = await recOf(memberRecordingPath(manifestPath, member));
    const name = memberLabel(member);
    const isCount = COUNT_CHECK_OPTS.has(check.opt);
    const integrityRefusal = countIntegrityRefusal(rec.meta);
    // A stepped (driver) member gates PER STEP, from its step spans -- the same per-interaction
    // granularity the plain path uses -- rather than its run summary (whose driver wall is null by
    // design and whose counts total both steps). A bench/node member gates its run summary. Each row
    // still names the member in its own column
    const stepped = isSteppedRecording(rec);
    const memberTargets: { label: string; m: Metrics }[] = stepped
      ? stepSpans(rec).map((step) => {
          const entry = stepEntry(step);
          return { label: `step ${entry.index} "${entry.label}"`, m: fromStep(entry) };
        })
      : [{ label: check.label, m: fromRunSpan(rec) }];
    for (const target of memberTargets) {
      const metricCell = stepped ? `${target.label} ${check.label}` : check.label;
      const prefix = stepped
        ? `${target.label} ${check.label} (${name})`
        : `${check.label} (${name})`;
      const outcome = evaluateCheck(target.m[check.key], max, isCount, integrityRefusal);
      const cells = outcomeCells(outcome);
      const violation = outcomeViolation(outcome, prefix, max);
      if (violation) violations.push(violation);
      rows.push([metricCell, name, cells.value, max, cells.verdict]);
      thresholdRows.push(
        outcomeRow(
          stepped ? target.label : "run",
          check.label,
          checkAxis(check.opt),
          max,
          outcome,
          name,
        ),
      );
    }
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
        thresholdRows.push({
          target: targetLabel,
          metric: slice,
          axis: "slice",
          budget: max,
          value: null,
          verdict: "n/a-fail",
          reason: "no member of this group built a reconciling bar",
        });
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
        thresholdRows.push(sliceRow(gate, memberLabel(barMember)));
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

  // A run-group is a multi-capture of one browser/node workload; allocation is the node --alloc lane,
  // never a group member mode, so no member measures it. --max-alloc-mb on a group is a loud n/a-FAIL,
  // never a silent pass
  if (thresholds.allocMb != null) {
    const budget = thresholds.allocMb;
    violations.push(
      `allocation MB: no member measures this axis (allocation is the --target node --alloc lane); cannot satisfy max ${budget}`,
    );
    rows.push(["allocation MB", "(none)", "n/a", budget, "FAIL"]);
    thresholdRows.push({
      target: "run",
      metric: "allocation MB",
      axis: "alloc",
      budget,
      value: null,
      verdict: "n/a-fail",
      reason:
        "no member measures allocation (the --target node --alloc lane is not a group member)",
    });
  }

  const view: AssertView = {
    target: group.meta.name,
    kind: "group",
    thresholds: thresholdRows,
    passed: violations.length === 0,
    violations,
    notes: group.notes,
  };
  finishAssert(
    view,
    () => {
      console.log(
        `run-group '${group.meta.name}' (each threshold routed to the member that measures it)\n`,
      );
      console.log(table(["metric", "member", "value", "max", ""], rows));
      // Group-level disclosures (count disagreement across members, partial formation): a CI reader must
      // see them, since a routed threshold gates ONE member's number while the members may have disagreed
      for (const note of group.notes) console.log(`\n${note}`);
      if (violations.length) {
        console.log(`\n✗ ${violations.length} assertion(s) failed:`);
        for (const violation of violations) console.log(`  ✗ ${violation}`);
      } else {
        console.log("\n✓ all assertions passed");
      }
    },
    fmt,
  );
}
