import type { Recording } from "../model/recording.js";
import { kv, num, sparkline, table } from "../output/ascii.js";
import { dim } from "../output/color.js";
import { capsFor } from "../browser/backend.js";

/**
 * Where the count column came from, which differs by lane and must not be asserted blindly:
 * only CDP counters are exact. Without CDP, summarize falls back to counting trace/marker
 * events, which on Firefox means Gecko Reflow/Styles markers: real, but batched by a different
 * engine, so calling them "authoritative" invites diffing them against Chrome's as though the
 * two counted the same thing. With no counting mechanism at all the column is all zeros, and
 * saying so beats letting a reader take them for a clean run.
 */
export function countProvenance(rec: Recording): string {
  if (capsFor(rec.meta.browser ?? "chrome").cdpCounts) {
    return "counts are authoritative; durations are coarse";
  }
  if (rec.meta.passes.includes("gecko")) {
    return "counts come from Gecko markers — approximate, not comparable to Chrome; durations are coarse";
  }
  return "counts NOT measured on this lane and shown as 0; see notes";
}

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

  console.log(`\nRendering work (${countProvenance(rec)})\n`);
  console.log(
    table(
      ["metric", "count", "ms"],
      [
        ["layout", summary.layoutCount, num(summary.layoutMs)],
        ["style recalc", summary.styleCount, num(summary.styleMs)],
        ["paint", summary.paintCount, num(summary.paintMs)],
        ["composite", summary.compositeCount, num(summary.compositeMs)],
      ],
    ),
  );

  console.log("\nInvalidations\n");
  console.log(
    kv([
      ["layout", summary.layoutInvalidations],
      ["paint", summary.paintInvalidations],
      ["style/selector", summary.styleInvalidations],
    ]),
  );

  console.log("\nHotspots\n");
  console.log(
    kv([
      ["forced layout/style", `${summary.forcedLayoutCount}  (${num(summary.forcedLayoutMs)} ms)`],
      ["long tasks ≥50ms", `${summary.longTaskCount}  (longest ${num(summary.longestTaskMs)} ms)`],
      ["INP (worst interaction)", summary.inpMs == null ? "—" : `${num(summary.inpMs)} ms`],
      // The whole wpd:run window (navigation + prepare + every step + settle), NOT one
      // interaction. Per-interaction wall is the perStep table below / `query index`.
      ["wall (whole run window)", summary.wallMs == null ? "—" : `${num(summary.wallMs)} ms`],
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
        ["processing", `${num(processingMs, 2)} ms   ${dim("(your event handlers)")}`],
        [
          "presentation delay",
          `${num(presentationDelayMs, 2)} ms   ${dim("(rendering the result)")}`,
        ],
      ]),
    );
  }
  if (summary.forcedLayoutCount > 0) {
    console.log("  ⚠ layout thrashing — run `query blame --forced` to see the source lines");
  }

  // Detect a run that recorded no layout/paint/style/event activity at all. On Firefox without a
  // Gecko pass, rendering is simply not collected (not a sign of a broken run), so skip the hint.
  const didWork =
    summary.layoutCount + summary.paintCount + summary.styleCount + summary.totalEvents;
  const firefoxNoDetail = meta.browser === "firefox" && !meta.passes.includes("gecko");
  if (didWork === 0 && !firefoxNoDetail) {
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
  // Optional chaining: recordings written before perStep existed have no such field.
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
    `\nscripting ms: ${num(summary.scriptingMs)}   events in window: ${summary.totalEvents}`,
  );
  if (meta.notes.length) {
    console.log("\nnotes:");
    for (const note of meta.notes) console.log(`  • ${note}`);
  }
}
