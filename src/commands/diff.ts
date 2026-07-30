import { promises as fs } from "node:fs";
import path from "node:path";
import {
  deserialize,
  serialize,
  structuredFormat,
  type StructuredOutOpts,
} from "../output/format.js";
import { assertRecordingArtifact } from "../model/artifact.js";
import { num, table } from "../output/ascii.js";
import { resolveTarget, resolveConsumption } from "./resolve.js";
import { loadGroup, loadMemberRecording, memberLabel, memberRecordingPath } from "./group.js";
import { formatMeasured, type Measured } from "../model/measured.js";
import { diffSpanSlices, type SpanSliceDiff } from "../model/spans.js";
import { comparabilityMismatches } from "../model/compat.js";
import { countIntegrityRefusal } from "../model/count-integrity.js";
import { loadSpanEntries } from "./spanSource.js";
import { runSpan } from "../model/span.js";
import type { GroupMember } from "../model/group.js";
import type { Recording } from "../model/recording.js";
import type {
  DiffMetricKey,
  DiffMetricRow,
  DiffView,
  GroupDiffMember,
  GroupDiffView,
  SpanEntry,
} from "../model/query.js";

interface DiffCmdOpts extends StructuredOutOpts {
  failOnRegression?: boolean;
}

// `gated` metrics participate in --fail-on-regression; `advisory` ones are printed but never
// fail the build. A metric gates only if it is REPRODUCIBLE on unchanged code, which is not the
// same as being a count:
//
//   - layout/style come from CDP counters, forced layout from trace stacks, and paint from
//     main-thread `Paint` events. Where a count comes from is not the test; reproducibility is, and all four are
//     [measured] bit-identical across repeated runs of the same flow (layout 41, style 42, forced
//     80 on 5 runs; paint exactly N+1 for N dirtied regions on 40). Those gate. Do not widen paint
//     to raster/compositor events: their counts track the scheduler rather than the page and would
//     cost this gate its meaning (docs/dev/rendering-counts.md).
//   - wall/INP/scripting ride performance.now() (Chrome-clamped, run-to-run jitter), so gating on
//     a +0.1 ms blip would contradict the tool's own trust tiers.
//
// Advisory metrics still show in the table as a directional signal. (For a real JS-cost gate use
// `cpu-diff`, which has a sampling-noise floor.)
//
// The off-thread frame side track (SpanBreakdown.frames) is intentionally NOT a metric here: its
// counts are scheduler noise (see docs/dev/rendering-counts.md), so it is display-only and would
// manufacture regressions. This diff reads only the run-span counts + meta headline, where the side
// track does not live, so no frame delta can be produced.

/** The run-level metrics diff compares, read from the run span (counts/wall/INP) and meta (jsSelfMs) --
 * the schema-5 count/timing store. Every not-measured field is a Measured null, so a metric absent on
 * one side prints n/a and never fabricates a delta. */
function diffMetrics(rec: Recording): Record<DiffMetricKey, Measured<number>> {
  const run = runSpan(rec);
  const counts = run?.counts;
  return {
    layoutCount: counts?.layoutCount ?? null,
    styleCount: counts?.styleCount ?? null,
    paintCount: counts?.paintCount ?? null,
    forcedLayoutCount: counts?.forcedLayoutCount ?? null,
    layoutInvalidations: counts?.layoutInvalidations ?? null,
    styleInvalidations: counts?.styleInvalidations ?? null,
    longTaskCount: counts?.longTaskCount ?? null,
    inpMs: run?.inpMs ?? null,
    wallMs: run?.wallMs ?? null,
    jsSelfMs: rec.meta.jsSelfMs ?? null,
  };
}

const METRICS: {
  label: string;
  key: DiffMetricKey;
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
  { label: "JS self ms", key: "jsSelfMs", higherIsWorse: true, gated: false },
];

async function loadRecording(file: string): Promise<Recording> {
  const abs = await resolveTarget(file, "recording");
  const rec = deserialize(
    await fs.readFile(abs, "utf8"),
    path.extname(abs).toLowerCase(),
  ) as Recording;
  assertRecordingArtifact(rec, abs);
  return rec;
}

/**
 * Print the per-span slice-delta section: matched spans (by label) with their per-slice ms deltas,
 * plus the labels present on one side only. ADVISORY, directional ms (trace wall-tier on --breakdown bars, the profiler's clock on CPU-only
 * bars): these never gate the build,
 * so they are shown for signal but do not join `regressions`. A slice not measured on one side
 * prints `—` rather than inventing a delta.
 */
function printSliceDiff(diff: SpanSliceDiff): void {
  console.log("\nper-span slice deltas (advisory, directional ms):");
  for (const span of diff.spans) {
    const rows = span.slices
      .filter((slice) => slice.base != null || slice.current != null)
      .map((slice) => [
        slice.slice,
        formatMeasured(slice.base, (value) => num(value), "n/a"),
        formatMeasured(slice.current, (value) => num(value), "n/a"),
        slice.delta == null
          ? "—"
          : `${slice.delta >= 0 ? "+" : ""}${num(slice.delta)} ${
              slice.delta > 0 ? "▲" : slice.delta < 0 ? "▼" : "="
            }`,
      ]);
    console.log(`\nspan "${span.label}":`);
    console.log(table(["slice", "baseline", "current", "delta"], rows));
  }
  if (diff.unmatchedBaseline.length)
    console.log(`\nspans only in baseline (not compared): ${diff.unmatchedBaseline.join(", ")}`);
  if (diff.unmatchedCurrent.length)
    console.log(`spans only in current (not compared): ${diff.unmatchedCurrent.join(", ")}`);
}

/**
 * Compute the field-by-field diff of two loaded recordings into a `DiffView`: the run-level metric
 * rows, the advisory per-span slice deltas, the capture-axis mismatches, and the gated regressions.
 * Pure -- no printing, no process.exitCode. `gateRefusal` is set (only under `--fail-on-regression`)
 * when the gate cannot be evaluated: an incompatible blocking axis, or known-incomplete counts on
 * either side. `failed` is the process verdict (exit 1): a refusal or a real gated regression, only
 * ever under the gate.
 */
function buildDiffView(
  baseline: string,
  current: string,
  baselineRec: Recording,
  currentRec: Recording,
  baselineSpans: SpanEntry[] | null,
  currentSpans: SpanEntry[] | null,
  failOnRegression: boolean,
): DiffView {
  const baselineMetrics = diffMetrics(baselineRec);
  const currentMetrics = diffMetrics(currentRec);

  // Comparability: name every capture axis that differs, so a reader never reads a config-driven
  // delta as a code change. Directional by default; a --fail-on-regression gate REFUSES across an
  // incompatible browser/runtime/capture-mode, where an exact-count "regression" would be an artifact
  // of the config, not the code.
  const mismatches = comparabilityMismatches(baselineRec.meta, currentRec.meta);

  // Refusal (only under the gate): a blocking axis first, then known-incomplete counts. A blocking
  // mismatch would make a count delta an artifact of the config; a cross-process split or dropped
  // trace events would make it an artifact of the missing work. Either way, refuse rather than
  // fabricate a verdict -- the same honest refusal assert makes.
  let gateRefusal: string | undefined;
  if (failOnRegression) {
    const blocking = mismatches.filter((mismatch) => mismatch.blocksGating);
    if (blocking.length) {
      const axes = blocking.map((mismatch) => mismatch.axis).join(", ");
      gateRefusal =
        `Refusing to gate (--fail-on-regression) across an incompatible capture (${axes} differ): ` +
        `a count delta would reflect the capture change, not a code regression. Re-record both sides ` +
        `on the same lane and capture mode to gate.`;
    } else {
      const integrityIssues = [
        ["baseline", countIntegrityRefusal(baselineRec.meta)],
        ["current", countIntegrityRefusal(currentRec.meta)],
      ].filter((entry): entry is [string, string] => entry[1] != null);
      if (integrityIssues.length)
        gateRefusal =
          `Refusing to gate (--fail-on-regression) on known-incomplete counts:\n` +
          integrityIssues.map(([side, reason]) => `    ${side}: ${reason}`).join("\n");
    }
  }

  const metrics: DiffMetricRow[] = [];
  const regressions: string[] = [];
  for (const metric of METRICS) {
    const baseValue = baselineMetrics[metric.key];
    const currentValue = currentMetrics[metric.key];
    // Don't conflate "not measured" (null) with 0; a null on either side means no delta (never a
    // fabricated 0 -> 45 regression or 300 -> 0 improvement).
    const delta = baseValue == null || currentValue == null ? null : currentValue - baseValue;
    // Only exact CDP counts gate the build; wall/INP/scripting are directional, not numbers to fail
    // CI on (see METRICS note).
    const regression = metric.gated && metric.higherIsWorse && delta != null && delta > 0;
    metrics.push({
      key: metric.key,
      label: metric.label,
      gated: metric.gated,
      base: baseValue,
      current: currentValue,
      delta,
      regression,
    });
    if (regression)
      regressions.push(
        `${metric.label}: ${num(baseValue!)} → ${num(currentValue!)} (+${num(delta!)})`,
      );
  }

  const sliceDeltas = diffSpanSlices(baselineSpans, currentSpans);
  const failed = failOnRegression && (gateRefusal != null || regressions.length > 0);
  return {
    baseline,
    current,
    comparability: mismatches,
    metrics,
    sliceDeltas,
    regressions,
    gateRefusal,
    failOnRegression,
    failed,
  };
}

/** Render a `DiffView` as the human report: the comparability warning, then either the gate refusal
 * or the metric table + advisory slice deltas + regression verdict. */
function renderDiffHuman(view: DiffView): void {
  if (view.comparability.length) {
    console.log("\n⚠ WARNING: baseline and current were captured differently:");
    for (const mismatch of view.comparability)
      console.log(`    ${mismatch.axis}: ${mismatch.base} → ${mismatch.current}`);
    console.log(
      "  Their counts/durations may not describe the same thing; treat this diff as directional.",
    );
  }
  // A refused gate stops before the table: the whole point is to not show a delta the config, not
  // the code, produced.
  if (view.gateRefusal) {
    console.log(`\n${view.gateRefusal}`);
    return;
  }

  const rows: (string | number)[][] = view.metrics.map((metric) => {
    if (metric.base == null || metric.current == null)
      return [
        metric.label,
        formatMeasured(metric.base, (value) => num(value), "n/a"),
        formatMeasured(metric.current, (value) => num(value), "n/a"),
        "—",
      ];
    const delta = metric.delta!;
    const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "=";
    return [
      metric.gated ? metric.label : `${metric.label} (advisory)`,
      num(metric.base),
      num(metric.current),
      `${delta >= 0 ? "+" : ""}${num(delta)} ${arrow}`,
    ];
  });

  console.log(`baseline: ${view.baseline}\ncurrent:  ${view.current}\n`);
  console.log(table(["metric", "baseline", "current", "delta"], rows));

  // Additive per-span slice section: shown only when either recording carries a breakdown bar.
  // Advisory, so it never touches `regressions` or the exit code.
  const sliceDiff = view.sliceDeltas;
  if (
    sliceDiff.spans.length ||
    sliceDiff.unmatchedBaseline.length ||
    sliceDiff.unmatchedCurrent.length
  )
    printSliceDiff(sliceDiff);

  if (view.regressions.length) {
    console.log(`\n${view.regressions.length} regression(s):`);
    for (const regression of view.regressions) console.log(`  ▲ ${regression}`);
  } else {
    // Scoped to what actually gates: the advisory rows (wall/INP) and the slice deltas above are
    // directional and never counted here, so claiming "no regressions" outright would overclaim.
    console.log(
      "\nNo exact-count regressions in the gated set. Directional deltas (wall, INP, slices) above are advisory.",
    );
  }
}

/** Compare two recordings OR two run-groups field-by-field; optionally fail on regression. A group
 * pairs its members by (mode, variant) and diffs each pair; a group vs a plain recording is refused
 * (one shape at a time). `--format json|toon` serializes the same data the human report shows. */
export async function diffCmd(baseline: string, current: string, opts: DiffCmdOpts): Promise<void> {
  const [baselineConsumption, currentConsumption] = await Promise.all([
    resolveConsumption(baseline),
    resolveConsumption(current),
  ]);
  const eitherGroup = baselineConsumption.kind === "group" || currentConsumption.kind === "group";
  if (eitherGroup) {
    if (baselineConsumption.kind !== "group" || currentConsumption.kind !== "group")
      throw new Error(
        "diff compares two run-groups or two recordings, not one of each. Pass two group manifests, " +
          "or two member recordings.",
      );
    return diffGroups(baselineConsumption.path, currentConsumption.path, opts);
  }
  return diffRecordings(baseline, current, opts);
}

/** Load two recordings + their spans and build the `DiffView`. Shared by the plain-recording path and
 * each run-group member pair. */
async function pairDiffView(
  baseline: string,
  current: string,
  failOnRegression: boolean,
): Promise<DiffView> {
  const [baselineRec, currentRec, baselineSpans, currentSpans] = await Promise.all([
    loadRecording(baseline),
    loadRecording(current),
    loadSpanEntries(baseline),
    loadSpanEntries(current),
  ]);
  return buildDiffView(
    baseline,
    current,
    baselineRec,
    currentRec,
    baselineSpans,
    currentSpans,
    failOnRegression,
  );
}

/** Compare two recordings field-by-field; optionally fail the process on regression. */
async function diffRecordings(baseline: string, current: string, opts: DiffCmdOpts): Promise<void> {
  const view = await pairDiffView(baseline, current, !!opts.failOnRegression);
  const fmt = structuredFormat(opts);
  if (fmt) console.log(serialize(view, fmt));
  else renderDiffHuman(view);
  if (view.failed) process.exitCode = 1;
}

/** A member's pairing key across two groups: capture mode + variant (span identity's group analogue). */
function memberPairKey(member: GroupMember): string {
  return `${member.mode}::${member.variant ?? ""}`;
}

/**
 * Diff two run-groups: fan out over members paired by (mode, variant), diffing each matched pair with
 * the SAME per-recording diff (comparabilityMismatches and the gates unchanged). Members present on
 * only one side are reported, not compared. A GROUP-LEVEL refusal fires only when the two groups
 * measured different workloads: pairing per-mode captures of two different programs is meaningless, so
 * `--fail-on-regression` refuses the whole diff there rather than per pair.
 */
async function diffGroups(
  baselineManifest: string,
  currentManifest: string,
  opts: DiffCmdOpts,
): Promise<void> {
  const fmt = structuredFormat(opts);
  const failOnRegression = !!opts.failOnRegression;
  const [baselineGroup, currentGroup] = await Promise.all([
    loadGroup(baselineManifest),
    loadGroup(currentManifest),
  ]);
  if (!fmt)
    console.log(
      `diff run-group '${baselineGroup.meta.name}' -> '${currentGroup.meta.name}' (members paired by capture mode + variant)`,
    );

  // Group-level workload refusal: read each group's first member's meta and reuse the comparability
  // gate's workload axis. Different workloads make every per-pair count delta a program difference, not
  // a code change, so refuse the whole diff rather than fabricate per-pair regressions.
  const [baselineRef, currentRef] = await Promise.all([
    loadMemberRecording(baselineManifest, baselineGroup.members[0]),
    loadMemberRecording(currentManifest, currentGroup.members[0]),
  ]);
  const workloadRefusal = comparabilityMismatches(baselineRef.meta, currentRef.meta).find(
    (mismatch) => mismatch.axis === "workload" && mismatch.blocksGating,
  );
  if (workloadRefusal) {
    const refusal =
      `Refusing to diff these run-groups: they measured different workloads ` +
      `(${workloadRefusal.base} vs ${workloadRefusal.current}). A per-mode diff would subtract two ` +
      `programs, not a code change.`;
    if (fmt) {
      const view: GroupDiffView = {
        baseline: baselineGroup.meta.name,
        current: currentGroup.meta.name,
        refusal,
        members: [],
        failOnRegression,
        failed: true,
      };
      console.log(serialize(view, fmt));
    } else {
      console.log(`\n${refusal}`);
    }
    process.exitCode = 1;
    return;
  }

  const currentByKey = new Map(
    currentGroup.members.map((member) => [memberPairKey(member), member]),
  );
  const baselineKeys = new Set(baselineGroup.members.map(memberPairKey));
  const members: GroupDiffMember[] = [];
  let comparedAny = false;
  let anyFailed = false;
  for (const baselineMember of baselineGroup.members) {
    const currentMember = currentByKey.get(memberPairKey(baselineMember));
    if (!currentMember) {
      if (!fmt)
        console.log(`\nmember '${memberLabel(baselineMember)}' only in baseline (not compared).`);
      members.push({ member: memberLabel(baselineMember), onlyIn: "baseline" });
      continue;
    }
    comparedAny = true;
    const view = await pairDiffView(
      memberRecordingPath(baselineManifest, baselineMember),
      memberRecordingPath(currentManifest, currentMember),
      failOnRegression,
    );
    if (view.failed) anyFailed = true;
    if (!fmt) {
      console.log(`\n=== member ${memberLabel(baselineMember)} ===`);
      renderDiffHuman(view);
    }
    members.push({ member: memberLabel(baselineMember), diff: view });
  }
  for (const currentMember of currentGroup.members)
    if (!baselineKeys.has(memberPairKey(currentMember))) {
      if (!fmt)
        console.log(`\nmember '${memberLabel(currentMember)}' only in current (not compared).`);
      members.push({ member: memberLabel(currentMember), onlyIn: "current" });
    }
  if (!comparedAny && !fmt)
    console.log(
      "\nNo members matched by capture mode + variant; nothing was compared. Record the groups with the same members.",
    );
  // A gate you asked for but could not evaluate must fail loudly, never pass silently on an empty diff.
  const failed = anyFailed || (!comparedAny && failOnRegression);
  if (fmt) {
    const view: GroupDiffView = {
      baseline: baselineGroup.meta.name,
      current: currentGroup.meta.name,
      members,
      failOnRegression,
      failed,
    };
    console.log(serialize(view, fmt));
  }
  if (failed) process.exitCode = 1;
}
