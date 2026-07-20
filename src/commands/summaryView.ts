import type { Recording } from "../model/recording.js";
import { formatMeasured, type Measured } from "../model/measured.js";
import { isFirefoxDeep, isGeckoCaptureMode } from "../model/capture-mode.js";
import { kv, num, sparkline, table } from "../output/ascii.js";
import { bold, dim } from "../output/color.js";
import { analyzeThrash, renderThrashStep, THRASH_HEADLINE_MIN } from "../trace/thrash.js";
import { firefoxDirtiedBy } from "../trace/firefox-dirtied.js";

/**
 * Where the count column came from, which differs by capture mode/lane and must not be asserted blindly.
 *
 * Provenance is not what makes a count trustworthy; reproducibility is (see diff.ts). Chrome counts
 * come from the trace, main-thread windowed, and are exact (bit-identical across repeated runs) --
 * but only a --breakdown/--deep capture has a trace; the default mode has none, so its counts read
 * as not-measured (—). Firefox counts Gecko Reflow/Styles markers instead: real, but batched by a
 * different engine, so calling them "authoritative" invites diffing them against Chrome's as though
 * the two counted the same thing.
 */
export function countProvenance(rec: Recording): string {
  if (isGeckoCaptureMode(rec.meta.passes)) {
    return "counts come from Gecko markers — approximate, not comparable to Chrome; durations are coarse";
  }
  // The default/precise-wall mode captures no trace, so it counts nothing: a — is not-measured, not 0.
  if (rec.summary.layoutCount == null) {
    return "counts NOT measured in this capture mode (no trace): shown as —, never 0. Add --breakdown or --deep; see notes";
  }
  // --deep has exact counts but suppresses its (.stack-distorted) durations; --breakdown has both.
  if (rec.summary.layoutMs == null) {
    return "counts from the trace (main-thread windowed) are exact; slice durations are suppressed in this capture mode (—) — run --breakdown for the reconciling bar";
  }
  return "counts from the trace (main-thread windowed) are exact; durations are wall-tier";
}

/**
 * The wall row, or nothing. `summary.wallMs` carries a different statistic per artifact, so the
 * label names which one rather than letting "wall" stand for all three:
 *
 *   - run-level driver recording: no wall exists (see runWallMs in record.ts). No row at all: a "—"
 *     would advertise a number as missing when it does not exist, and send a reader off to look for
 *     a flag that would bring it back.
 *   - per-step recording: the MEDIAN of that step's samples (mergeSteps), on the clock the capture mode
 *     priced it with (Span.wallClock). The honest per-interaction wall, so it must print -- note it inherits
 *     meta.driver from the parent run, which is why the check above is not on driver alone.
 *   - bench / node: the SUM of the timed iterations.
 */
function wallRow(rec: Recording): [string, string][] {
  const { summary, meta } = rec;
  if (meta.driver && !meta.step) return [];
  if (summary.wallMs == null) return [];
  const samples = summary.perIteration.length;
  const label = meta.step
    ? samples > 1
      ? `wall (median of ${samples} samples)`
      : "wall (single sample)"
    : samples > 1
      ? `wall (sum of ${samples} timed iterations)`
      : "wall";
  return [[label, `${num(summary.wallMs)} ms`]];
}

/**
 * The Chrome `--deep` forced-layout section: the dual annotation (forced-by read + dirtied-by
 * write) and the thrash-interleave detector, led by identities since a --deep recording
 * suppresses slice ms. Prints nothing when no forced flush was observed. Chrome --deep only -- the
 * caller gates on the capture mode, so Firefox (no invalidation records) never reaches here and reads
 * "not available" (no thrash section at all), never a fabricated 0.
 */
function printForcedAttribution(rec: Recording): void {
  // The full event log, NOT a window-filtered slice: the enclosing RunTask can begin a hair before
  // the run:start mark, and analyzeThrash needs it to walk the interleave. It windows internally,
  // reporting only in-window flushes.
  const { report } = analyzeThrash(rec.events, rec.window.startTs);
  if (report.count === 0) {
    // The capture mode measured forced flushes but none re-dirtied since the last flush: no thrashing.
    if (rec.summary.forcedLayoutCount != null && rec.summary.forcedLayoutCount > 0)
      console.log(
        `\nForced layout/style: ${rec.summary.forcedLayoutCount} flush(es), none thrashing (no write re-dirtied a cleaned read). ${dim("query blame --forced for the read + dirtied-by lines")}`,
      );
    return;
  }
  const headline =
    report.count >= THRASH_HEADLINE_MIN
      ? `⚠ ${bold(`layout thrashed ${report.count}x during this run`)}`
      : `layout thrashed ${report.count}x during this run`;
  console.log(`\n${headline}  ${dim("(a write re-dirtied a just-read layout; forced re-flush)")}`);
  console.log(dim("  interleave (write → read), the thrashing signature:"));
  for (const step of report.steps) console.log(`    ${renderThrashStep(step)}`);
  if (report.omitted > 0) console.log(dim(`    … +${report.omitted} more thrash step(s)`));
  console.log(dim("  full read + dirtied-by lines: query blame --forced"));
}

/**
 * The Firefox `--deep` dirtied-by section: Gecko's native cause-stack write identity, led by the
 * never-fake-parity disclaimer. Unlike Chrome's forced-attribution section there is no thrash detector
 * and no forced-by read side here -- Gecko records only the FIRST invalidation since the last flush,
 * so the write set is partial and the read stays the sampled read-site blame. Prints nothing when no
 * forced flush carried a resolvable cause. Firefox --deep only (the caller gates on the capture mode).
 */
function printFirefoxDirtiedBy(rec: Recording): void {
  const report = firefoxDirtiedBy(rec.events, rec.window.startTs);
  if (rec.summary.forcedLayoutCount != null && rec.summary.forcedLayoutCount > 0 && !report) {
    // Forced flushes were counted but none carried a JS cause stack to name a write.
    console.log(
      `\nForced layout/style: ${rec.summary.forcedLayoutCount} flush(es); no JS cause stack named a write. ${dim("read side: query blame --forced")}`,
    );
    return;
  }
  if (!report) return;
  const total = report.writes.reduce((sum, write) => sum + write.count, 0);
  console.log(`\ndirtied-by (first invalidation only) ${dim(`— ${total} forced flush(es)`)}`);
  const forcedTotal = rec.summary.forcedLayoutCount;
  if (forcedTotal != null && forcedTotal > total)
    console.log(
      dim(
        `  ${forcedTotal - total} further forced flush(es) carried no resolvable write and are not listed.`,
      ),
    );
  console.log(
    dim(
      "  the write Gecko blames for each forced flush. Gecko records only the FIRST invalidation since",
    ),
  );
  console.log(dim("  the last flush, so this is not Chrome's full write set."));
  console.log(
    dim(
      "  forced-by: n/a (firefox --deep) — the read that forced each flush is the sampled read-site blame: query blame --forced",
    ),
  );
  const shown = report.writes.slice(0, DIRTIED_BY_REPORT_CAP);
  for (const write of shown)
    console.log(`    ${write.at}  ${dim(`(${write.kinds.join(",")} ×${write.count})`)}`);
  const omitted = report.writes.length - shown.length;
  if (omitted > 0)
    console.log(dim(`    … +${omitted} more write(s) — query blame --dirtied for the full list`));
}

/** How many dirtied-by writes the record report names before collapsing the rest (query blame --dirtied has all). */
const DIRTIED_BY_REPORT_CAP = 8;

export function printSummary(rec: Recording): void {
  const summary = rec.summary;
  const meta = rec.meta;
  const title = meta.step
    ? `step ${meta.step.index} "${meta.step.label}"`
    : `${meta.mode}:${meta.target}`;
  console.log(`\n${meta.tool} — ${title}  (fn: ${meta.fn})`);
  console.log(
    `browser: ${meta.browser ?? "chrome"}   passes: ${meta.passes.join(" + ")}   driver: ${meta.driver}   lifecycle: ${meta.lifecycle.join("→") || "run"}`,
  );

  // A Measured count/ms renders as its number, or "—" when the capture mode did not measure it (never 0).
  const count = (value: Measured<number>): string =>
    formatMeasured(value, (measured) => String(measured));
  const ms = (value: Measured<number>): string =>
    formatMeasured(value, (measured) => num(measured));

  console.log(`\nRendering work (${countProvenance(rec)})\n`);
  console.log(
    table(
      ["metric", "count", "ms"],
      [
        ["layout", count(summary.layoutCount), ms(summary.layoutMs)],
        ["style recalc", count(summary.styleCount), ms(summary.styleMs)],
        ["paint", count(summary.paintCount), ms(summary.paintMs)],
      ],
    ),
  );

  console.log("\nInvalidations\n");
  console.log(
    kv([
      ["layout", count(summary.layoutInvalidations)],
      ["paint", count(summary.paintInvalidations)],
      ["style/selector", count(summary.styleInvalidations)],
    ]),
  );

  // forced is null when the run did not measure it (--breakdown drops the `.stack` category); say
  // "not measured" and point at the mode that does, never print 0 (which reads as "no thrashing").
  const forcedCell = formatMeasured(
    summary.forcedLayoutCount,
    (forced) =>
      `${forced}  (${formatMeasured(summary.forcedLayoutMs, (value) => num(value), "— ms not measured")})`,
    dim("not measured (run --deep for forced-layout blame)"),
  );
  const longTaskCell = formatMeasured(
    summary.longTaskCount,
    (tasks) =>
      `${tasks}  (longest ${formatMeasured(summary.longestTaskMs, (value) => num(value), "—")} ms)`,
    "—",
  );
  console.log("\nHotspots\n");
  console.log(
    kv([
      ["forced layout/style", forcedCell],
      ["long tasks ≥50ms", longTaskCell],
      ["INP (worst interaction)", summary.inpMs == null ? "—" : `${num(summary.inpMs)} ms`],
      ...wallRow(rec),
    ]),
  );
  // Where that INP went. This is the part of a driver report that describes the PAGE: a step's
  // wall carries the driver's own overhead (see StepTiming / docs/dev/driver-timing.md), while
  // these come from the in-page Event Timing observer and answer the standard triage.
  if (summary.interaction) {
    const { inputDelayMs, processingMs, presentationDelayMs } = summary.interaction;
    console.log("\nWhere that interaction's time went (in-page, Core Web Vitals split)\n");
    console.log(
      kv([
        ["input delay", `${num(inputDelayMs, 2)} ms   ${dim("(main thread busy at input)")}`],
        [
          "processing",
          `${num(processingMs, 2)} ms   ${dim("(handlers, first start to last end)")}`,
        ],
        [
          "presentation delay",
          `${num(presentationDelayMs, 2)} ms   ${dim("(rendering the result)")}`,
        ],
      ]),
    );
  }
  // The identity-led forced-layout section. Chrome --deep: the write side (dirtied-by) is available
  // AND the interleave detector runs, so lead with both. Firefox --deep: Gecko's cause-stack write
  // identity, first-invalidation-only, no thrash detector (its partial write set cannot feed one).
  // Every other lane that measured forced counts (firefox default) can only point at read-site blame.
  if (isFirefoxDeep(meta.passes)) {
    printFirefoxDirtiedBy(rec);
  } else if (meta.passes.includes("deep")) {
    printForcedAttribution(rec);
  } else if (summary.forcedLayoutCount != null && summary.forcedLayoutCount > 0) {
    // The remaining lane with a forced count is firefox non-deep (chrome default/--breakdown report
    // null). Its count is marker-derived and the read site is sampled, so it can locate fewer sites
    // than the count; do not repeat Chrome's "thrashing" framing over a single batched Gecko flush.
    if (meta.browser === "firefox")
      console.log(
        dim(
          "  forced layout/style is marker-derived; the read that forced it is a sampled estimate (query blame --forced) that can miss cheap reads.",
        ),
      );
    else console.log("  ⚠ layout thrashing — run `query blame --forced` to see the source lines");
  }

  // Detect a run that recorded no layout/paint/style/event activity at all. A null count (the capture
  // mode did not measure it) is treated as 0 here -- it contributes no evidence of work either way, and
  // totalEvents still fires the hint on a genuinely empty trace. On Firefox without a Gecko pass, or
  // the default mode (no trace), rendering is simply not collected, so skip the hint.
  const didWork =
    (summary.layoutCount ?? 0) +
    (summary.paintCount ?? 0) +
    (summary.styleCount ?? 0) +
    summary.totalEvents;
  const firefoxNoDetail = meta.browser === "firefox" && !isGeckoCaptureMode(meta.passes);
  const noTrace = meta.browser !== "firefox" && summary.layoutCount == null;
  if (didWork === 0 && !firefoxNoDetail && !noTrace) {
    console.log(
      "  ⚠ no rendering work recorded — did your run/step actually do anything (selector correct)?",
    );
  }

  if (summary.stats && summary.perIteration.length > 1) {
    console.log("\nPer-iteration wall time (coarse — Chrome clamps the clock)\n");
    console.log(
      kv([
        ["samples", summary.stats.samples],
        ["min ms", num(summary.stats.minMs, 3)],
        ["median ms", num(summary.stats.medianMs, 3)],
        ["mean ms", num(summary.stats.meanMs, 3)],
        ["max ms", num(summary.stats.maxMs, 3)],
      ]),
    );
    console.log(`trend  ${sparkline(summary.perIteration)}`);
  }

  // Steps are heterogeneous, so this is a labelled list, not one stats block or a sparkline:
  // there is no trend across "mount" and "inp". Each step aggregates only against itself.
  // Optional chaining: an older recording may not carry perStep at all.
  if (summary.perStep?.length) {
    const repeated = summary.perStep.some((step) => step.perIteration.length > 1);
    if (repeated) {
      console.log(
        "\nPer-step wall time (median of --iterations samples; performance.now is coarse)\n",
      );
      console.log(
        table(
          ["step", "median ms", "min", "max", "samples"],
          summary.perStep.map((step) => [
            step.label,
            num(step.stats?.medianMs ?? step.perIteration[0], 3),
            num(step.stats?.minMs ?? step.perIteration[0], 3),
            num(step.stats?.maxMs ?? step.perIteration[0], 3),
            step.perIteration.length,
          ]),
        ),
      );
    } else {
      // Name the remedy, not just the limit: one sample of a clamped clock cannot separate a
      // regression from noise, and --iterations is the whole answer to that.
      console.log("\nPer-step wall time (single sample per step; --iterations N for a median)\n");
      console.log(
        table(
          ["step", "wall ms"],
          summary.perStep.map((step) => [step.label, num(step.perIteration[0], 3)]),
        ),
      );
    }
  }

  console.log(
    `\nscripting ms: ${ms(summary.scriptingMs)}   events in window: ${summary.totalEvents}`,
  );
  if (meta.notes.length) {
    console.log("\nnotes:");
    for (const note of meta.notes) console.log(`  • ${note}`);
  }
}
