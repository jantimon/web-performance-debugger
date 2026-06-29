import type { Recording } from "../model/recording.js";
import { kv, num, sparkline, table } from "../output/ascii.js";

export function printSummary(rec: Recording): void {
  const summary = rec.summary;
  const meta = rec.meta;
  const title = meta.step
    ? `step ${meta.step.index} "${meta.step.label}"`
    : `${meta.mode}:${meta.target}`;
  console.log(`\n${meta.tool} — ${title}  (fn: ${meta.fn})`);
  console.log(
    `passes: ${meta.passes.join(" + ")}   driver: ${meta.driver}   lifecycle: ${meta.lifecycle.join("→") || "run"}`,
  );

  console.log("\nRendering work (counts are authoritative; durations are coarse)\n");
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
      ["wall", summary.wallMs == null ? "—" : `${num(summary.wallMs)} ms`],
    ]),
  );
  if (summary.forcedLayoutCount > 0) {
    console.log("  ⚠ layout thrashing — run `query blame --forced` to see the source lines");
  }

  // Detect a run that recorded no layout/paint/style/event activity at all.
  const didWork =
    summary.layoutCount + summary.paintCount + summary.styleCount + summary.totalEvents;
  if (didWork === 0) {
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

  console.log(
    `\nscripting ms: ${num(summary.scriptingMs)}   events in window: ${summary.totalEvents}`,
  );
  if (meta.notes.length) {
    console.log("\nnotes:");
    for (const note of meta.notes) console.log(`  • ${note}`);
  }
}
