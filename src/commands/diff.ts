import { promises as fs } from "node:fs";
import path from "node:path";
import { deserialize } from "../output/format.js";
import { assertRecordingArtifact } from "../model/artifact.js";
import { num, table } from "../output/ascii.js";
import { resolveTarget, resolveConsumption } from "./resolve.js";
import { loadGroup, loadMemberRecording, memberLabel, memberRecordingPath } from "./group.js";
import { formatMeasured, type Measured } from "../model/measured.js";
import { diffSpanSlices, type SpanSliceDiff } from "../model/spans.js";
import { comparabilityMismatches } from "../model/compat.js";
import { countIntegrityRefusal } from "../model/count-integrity.js";
import { loadSpanEntries } from "./spanSource.js";
import type { GroupMember } from "../model/group.js";
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
//
// The off-thread frame side track (SpanBreakdown.frames) is intentionally NOT a metric here: its
// counts are scheduler noise (see docs/dev/rendering-counts.md), so it is display-only and would
// manufacture regressions. This diff reads only `summary`, where the side track does not live, so
// no frame delta can be produced.
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

/** Compare two recordings OR two run-groups field-by-field; optionally fail on regression. A group
 * pairs its members by (mode, variant) and diffs each pair; a group vs a plain recording is refused
 * (one shape at a time). */
export async function diffCmd(
  baseline: string,
  current: string,
  opts: { failOnRegression?: boolean },
): Promise<void> {
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

/** Compare two recordings field-by-field; optionally fail the process on regression. */
async function diffRecordings(
  baseline: string,
  current: string,
  opts: { failOnRegression?: boolean },
): Promise<void> {
  const [baselineRec, currentRec, baselineSpans, currentSpans] = await Promise.all([
    loadRecording(baseline),
    loadRecording(current),
    loadSpanEntries(baseline),
    loadSpanEntries(current),
  ]);
  const baselineSummary = baselineRec.summary;
  const currentSummary = currentRec.summary;

  // Comparability: name every capture axis that differs, so a reader never reads a config-driven
  // delta as a code change. Warn (not refuse) by default so cross-config exploration stays possible;
  // but a --fail-on-regression gate REFUSES across an incompatible browser/runtime/capture-mode, where
  // an exact-count "regression" would be an artifact of the config, not the code.
  const mismatches = comparabilityMismatches(baselineRec.meta, currentRec.meta);
  if (mismatches.length) {
    console.log("\n⚠ WARNING: baseline and current were captured differently:");
    for (const mismatch of mismatches)
      console.log(`    ${mismatch.axis}: ${mismatch.base} → ${mismatch.current}`);
    console.log(
      "  Their counts/durations may not describe the same thing; treat this diff as directional.",
    );
  }
  if (opts.failOnRegression && mismatches.some((mismatch) => mismatch.blocksGating)) {
    const blocking = mismatches
      .filter((mismatch) => mismatch.blocksGating)
      .map((mismatch) => mismatch.axis)
      .join(", ");
    console.log(
      `\nRefusing to gate (--fail-on-regression) across an incompatible capture (${blocking} differ): ` +
        `a count delta would reflect the capture change, not a code regression. Re-record both sides ` +
        `on the same lane and capture mode to gate.`,
    );
    process.exitCode = 1;
    return;
  }

  // One (or both) sides has known-incomplete counts (a cross-process split, or dropped trace events):
  // the gated count deltas would compare an undercount, so a "regression" or "improvement" could be an
  // artifact of the missing work. Refuse to gate rather than fabricate a verdict -- the same honest
  // refusal assert makes, and the same shape as the comparability refusal above.
  if (opts.failOnRegression) {
    const integrityIssues = [
      ["baseline", countIntegrityRefusal(baselineRec.meta)],
      ["current", countIntegrityRefusal(currentRec.meta)],
    ].filter((entry): entry is [string, string] => entry[1] != null);
    if (integrityIssues.length) {
      console.log(
        `\nRefusing to gate (--fail-on-regression) on known-incomplete counts:\n` +
          integrityIssues.map(([side, reason]) => `    ${side}: ${reason}`).join("\n"),
      );
      process.exitCode = 1;
      return;
    }
  }

  const rows: (string | number)[][] = [];
  const regressions: string[] = [];
  for (const metric of METRICS) {
    const baseValue = baselineSummary[metric.key] as Measured<number>;
    const currentValue = currentSummary[metric.key] as Measured<number>;
    // Don't conflate "not measured" (null) with 0; that invents fake regressions
    // (0 → 45) and fake improvements (300 → 0) when a metric is absent on one side.
    if (baseValue == null || currentValue == null) {
      rows.push([
        metric.label,
        formatMeasured(baseValue, (value) => num(value), "n/a"),
        formatMeasured(currentValue, (value) => num(value), "n/a"),
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

  // Additive per-span slice section: shown only when either recording carries a breakdown bar.
  // Advisory, so it never touches `regressions` or the exit code.
  const sliceDiff = diffSpanSlices(baselineSpans, currentSpans);
  if (
    sliceDiff.spans.length ||
    sliceDiff.unmatchedBaseline.length ||
    sliceDiff.unmatchedCurrent.length
  )
    printSliceDiff(sliceDiff);

  if (regressions.length) {
    console.log(`\n${regressions.length} regression(s):`);
    for (const regression of regressions) console.log(`  ▲ ${regression}`);
    if (opts.failOnRegression) process.exitCode = 1;
  } else {
    // Scoped to what actually gates: the advisory rows (wall/INP) and the slice deltas above are
    // directional and never counted here, so claiming "no regressions" outright would overclaim.
    console.log(
      "\nNo exact-count regressions in the gated set. Directional deltas (wall, INP, slices) above are advisory.",
    );
  }
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
  opts: { failOnRegression?: boolean },
): Promise<void> {
  const [baselineGroup, currentGroup] = await Promise.all([
    loadGroup(baselineManifest),
    loadGroup(currentManifest),
  ]);
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
    console.log(
      `\nRefusing to diff these run-groups: they measured different workloads ` +
        `(${workloadRefusal.base} vs ${workloadRefusal.current}). A per-mode diff would subtract two ` +
        `programs, not a code change.`,
    );
    process.exitCode = 1;
    return;
  }

  const currentByKey = new Map(
    currentGroup.members.map((member) => [memberPairKey(member), member]),
  );
  const baselineKeys = new Set(baselineGroup.members.map(memberPairKey));
  let comparedAny = false;
  for (const baselineMember of baselineGroup.members) {
    const currentMember = currentByKey.get(memberPairKey(baselineMember));
    if (!currentMember) {
      console.log(`\nmember '${memberLabel(baselineMember)}' only in baseline (not compared).`);
      continue;
    }
    comparedAny = true;
    console.log(`\n=== member ${memberLabel(baselineMember)} ===`);
    // The per-pair diff sets process.exitCode on a gated regression; that verdict rides through.
    await diffRecordings(
      memberRecordingPath(baselineManifest, baselineMember),
      memberRecordingPath(currentManifest, currentMember),
      opts,
    );
  }
  for (const currentMember of currentGroup.members)
    if (!baselineKeys.has(memberPairKey(currentMember)))
      console.log(`\nmember '${memberLabel(currentMember)}' only in current (not compared).`);
  if (!comparedAny) {
    console.log(
      "\nNo members matched by capture mode + variant; nothing was compared. Record the groups with the same members.",
    );
    // A gate you asked for but could not evaluate must fail loudly, never pass silently on an empty diff.
    if (opts.failOnRegression) process.exitCode = 1;
  }
}
