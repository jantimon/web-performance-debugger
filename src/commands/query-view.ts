import type {
  CpuModel,
  EngineSoftNav,
  FlushScope,
  LayoutShift,
  LayoutShiftRect,
  NavigationKind,
  RecordingMeta,
  SoftNavRoute,
  Span,
  SpanAddons,
  SpanScope,
  StepLcp,
} from "../model/recording.js";
import { classifySoftNavAgreement } from "../model/soft-nav.js";
import type {
  GroupSpanStitch,
  SpanAnatomy,
  SpanCountsEntry,
  SpanOverviewAddons,
  UnifiedSlices,
} from "../model/query.js";
import type { SpanCountsOverview } from "../model/spans.js";
import { isGeckoCaptureMode } from "../model/capture-mode.js";
import { looksLikePreAppShell } from "../model/boot-shell.js";
import { formatMeasured, type Measured } from "../model/measured.js";
import { bold, cyan, dim } from "../output/color.js";
import {
  idleShareSuffix,
  LABEL_COL_MAX,
  middleEllipsis,
  num,
  SOURCE_COL_MAX,
  spanWallProvenance,
  table,
} from "../output/ascii.js";
import { printCpuBreakdown, printSpanBreakdowns } from "./cpu.js";
import { shortSource } from "../profile/cpuprofile.js";
import { MIN_POOLED_HOT_SAMPLES } from "../profile/span-hot.js";
import { hintTarget } from "./resolve.js";
// Format selection lives with the verb routing in query.ts; the bar-less overview printer needs it
// to honor --json/--format, so it is imported back (query.ts imports the printers from here).
import type { SpansQuery } from "./query.js";
import { emit, structuredFormat } from "../output/format.js";

/** How many forced read-sites / thrash writes the human anatomy prints before eliding the rest. */
const ANATOMY_FORCED_CAP = 12;

/** A compact navigation marker for a step row in a `query spans` table, "" for none/absent (the
 * common static step, which earns no marker). */
function navMarker(navigation: NavigationKind | undefined): string {
  return navigation && navigation !== "none" ? dim(` [nav: ${navigation}]`) : "";
}

/**
 * The step's navigation line for `query span`: the url+timeOrigin classification with its before ->
 * after URLs, then (where present) Chrome's own soft-navigation verdict beside it. The two are
 * independent facts; where they disagree the note states both and picks no winner (model/soft-nav.ts).
 */
function printStepNavigation(
  navigation: NavigationKind | undefined,
  beforeUrl: string | undefined,
  afterUrl: string | undefined,
  engineSoftNav: EngineSoftNav | undefined,
): void {
  if (!navigation) return;
  if (navigation === "none") {
    console.log(
      `\nNavigation: ${bold("none")}${beforeUrl ? dim(` (stayed on ${beforeUrl})`) : ""}`,
    );
  } else {
    console.log(
      `\nNavigation: ${bold(navigation)} ${dim(`(${beforeUrl ?? "?"} -> ${afterUrl ?? "?"})`)}`,
    );
  }
  const verdict = classifySoftNavAgreement(navigation, engineSoftNav);
  if (verdict.note) console.log(dim(`  engine soft-nav: ${verdict.note}`));
}

/** The boot-LCP block for `query span` (wall-tier directional, frozen at the first trusted input). */
function printStepLcp(lcp: StepLcp): void {
  if (lcp.suppressed) {
    console.log(
      `\nLCP (boot): ${dim("suppressed -- implausible startTime (the headless clock anomaly; navigation-and-lcp.md)")}`,
    );
    return;
  }
  const identity = `${lcp.tag ?? "(element)"}${lcp.id ? `#${lcp.id}` : ""}${lcp.url ? ` ${lcp.url}` : ""}`;
  console.log(
    `\nLCP (boot, wall-tier directional; frozen at first interaction): ${bold(identity)}`,
  );
  const parts: string[] = [];
  if (lcp.size != null) parts.push(`size ${lcp.size}`);
  if (lcp.renderTimeMs != null) parts.push(`render ${num(lcp.renderTimeMs, 1)} ms`);
  // loadTime is the timing left when renderTime is unavailable (cross-origin without Timing-Allow-Origin).
  else if (lcp.loadTimeMs != null)
    parts.push(
      `load ${num(lcp.loadTimeMs, 1)} ms (no render time: cross-origin, no Timing-Allow-Origin)`,
    );
  if (lcp.startTimeMs != null) parts.push(`start ${num(lcp.startTimeMs, 1)} ms`);
  if (parts.length) console.log(dim(`  ${parts.join(" · ")}`));
  // Per-iteration spread: a boot LCP swings run-to-run (field-measured 536ms vs 3644ms on one site),
  // so the single render time above is one sample and the spread is what says whether to trust it. A
  // miss (an iteration that fired no usable entry) stays null in the series, counted here, never 0.
  if (lcp.perIteration && lcp.perIteration.length > 1) {
    const misses = lcp.perIteration.filter((value) => value == null).length;
    const missNote = misses ? `; ${misses} iteration(s) fired no entry` : "";
    if (lcp.stats)
      console.log(
        dim(
          `  render across ${lcp.stats.samples} iteration(s): min ${num(lcp.stats.minMs, 1)} · ` +
            `median ${num(lcp.stats.medianMs, 1)} · max ${num(lcp.stats.maxMs, 1)} ms${missNote}`,
        ),
      );
    else if (missNote) console.log(dim(`  render${missNote}`));
  }
  if (lcp.className) console.log(dim(`  class ${lcp.className}`));
}

/** A source's rect move as `[x,y w×h] -> [x,y w×h]`, rounded to whole px (page coordinates). */
function describeRectMove(previousRect: LayoutShiftRect, currentRect: LayoutShiftRect): string {
  const rect = (box: LayoutShiftRect) =>
    `[${num(box.x, 0)},${num(box.y, 0)} ${num(box.width, 0)}x${num(box.height, 0)}]`;
  return `${rect(previousRect)} -> ${rect(currentRect)}`;
}

/** The CLS block for `query span`: the session-window-max score and the top shifting elements. */
function printLayoutShift(layoutShift: LayoutShift): void {
  console.log(
    `\nCLS (boot, spec session-window max; wall-tier directional): ${bold(num(layoutShift.cls, 4))}`,
  );
  console.log(
    dim(
      `  ${layoutShift.shiftCount} shift(s) in the winning window; ${layoutShift.windowCount} session window(s)`,
    ),
  );
  if (layoutShift.sources.length) {
    console.log(
      dim("  shifted most (score is an area-weighted share of the window, not a spec quantity):"),
    );
    for (const source of layoutShift.sources) {
      const move =
        source.previousRect && source.currentRect
          ? `  ${describeRectMove(source.previousRect, source.currentRect)}`
          : "";
      console.log(dim(`    ${source.node}  score ${num(source.score, 4)}${move}`));
    }
  }
}

/**
 * The route-transition block for `query span`: a soft-navigating step's LCP-equivalent, CLS, and worst
 * post-route interaction, all on the ROUTE clock (anchored to the soft nav's startTime), clearly labelled
 * as the route's own numbers and kept distinct from the boot LCP/CLS above. Chrome 151+ only.
 */
function printSoftNavRoute(softNav: SoftNavRoute): void {
  const extra = softNav.additionalSoftNavs
    ? dim(` (+${softNav.additionalSoftNavs} more soft nav(s) this step, first shown)`)
    : "";
  console.log(
    `\nRoute transition (${bold(softNav.navigationType || "soft nav")}, nav ${softNav.navigationId}` +
      `${softNav.url ? ` -> ${softNav.url}` : ""}; on the route clock)${extra}`,
  );
  if (softNav.routeLcp) {
    const lcp = softNav.routeLcp;
    const identity = `${lcp.tag ?? "(element)"}${lcp.url ? ` ${lcp.url}` : ""}`;
    const parts: string[] = [];
    if (lcp.routeMs != null) parts.push(`${num(lcp.routeMs, 1)} ms into the route`);
    if (lcp.size != null) parts.push(`size ${lcp.size}`);
    console.log(
      `  route LCP (interaction-contentful-paint; wall-tier directional): ${bold(identity)}` +
        (parts.length ? dim(` (${parts.join(" · ")})`) : ""),
    );
  }
  if (softNav.routeCls) {
    console.log(
      `  route CLS (spec session-window max; wall-tier directional): ${bold(num(softNav.routeCls.cls, 4))}` +
        dim(
          ` (${softNav.routeCls.shiftCount} shift(s), ${softNav.routeCls.windowCount} window(s))`,
        ),
    );
    for (const source of softNav.routeCls.sources)
      console.log(dim(`    ${source.node}  score ${num(source.score, 4)}`));
  }
  if (softNav.routeInpMs != null) {
    const split = softNav.routeInteraction
      ? dim(
          `  (input ${num(softNav.routeInteraction.inputDelayMs, 1)} · ` +
            `processing ${num(softNav.routeInteraction.processingMs, 1)} · ` +
            `presentation ${num(softNav.routeInteraction.presentationDelayMs, 1)} ms)`,
        )
      : "";
    console.log(
      `  worst post-route interaction (INP): ${bold(`${num(softNav.routeInpMs, 1)} ms`)}${split}`,
    );
  }
  console.log(
    dim(
      "  the triggering interaction carries the pre-nav id, so it stays in the step's INP above, not here",
    ),
  );
}

/**
 * Rejoin a structured read-site (`source` + optional `line`/`column`) into the `file:line:col` cell
 * the forced table shows. The inverse of `splitReadSite`; an absent line/column simply drops off, and a
 * column without a line is dropped (it can only follow a line).
 */
function readSiteCell(entry: { source: string; line?: number; column?: number }): string {
  const line = entry.line != null ? `:${entry.line}` : "";
  const column = entry.line != null && entry.column != null ? `:${entry.column}` : "";
  return `${entry.source}${line}${column}`;
}

/**
 * A compact dim suffix naming a forced flush's scope for a blame/forced row's source cell: layout
 * objects relaid out over the document total, elements recalculated, and a contained flush's root.
 * "" when the row carries no scope (the sampled --breakdown/firefox lanes). Chrome --deep only.
 */
export function flushScopeSuffix(scope: FlushScope | undefined): string {
  if (!scope) return "";
  const parts: string[] = [];
  if (scope.layoutObjects)
    parts.push(`${scope.layoutObjects.dirty}/${scope.layoutObjects.total} layout objects`);
  if (scope.elementsStyled != null) parts.push(`${scope.elementsStyled} styled`);
  if (scope.containedRoot) parts.push(`contained ${scope.containedRoot}`);
  return parts.length ? ` ${dim(`[${parts.join(" · ")}]`)}` : "";
}

/**
 * The per-span scope block for `query span`: the layout/style scope distribution beside the counts.
 * A count-tier fact (how much relaid out / recalculated), a DISTRIBUTION not a sum, and never a proxy
 * for the ms. Prints nothing when the capture stored no scope. Firefox carries the style row only.
 */
function printSpanScope(scope: SpanScope): void {
  const rows: string[] = [];
  if (scope.layoutObjects)
    rows.push(
      `  layout objects    p50 ${num(scope.layoutObjects.p50, 0)} · max ${scope.layoutObjects.max}  ` +
        dim(`(over ${scope.layoutObjects.flushes} flush(es); render-tree objects, not DOM nodes)`),
    );
  if (scope.elementsStyled)
    rows.push(
      `  elements styled   p50 ${num(scope.elementsStyled.p50, 0)} · max ${scope.elementsStyled.max}  ` +
        dim(`(over ${scope.elementsStyled.flushes} flush(es))`),
    );
  if (scope.contained)
    rows.push(
      `  contained flushes ${scope.contained.flushes}  ` +
        dim(
          `(subtree-scoped${scope.contained.sampleRoot ? `, e.g. ${scope.contained.sampleRoot}` : ""})`,
        ),
    );
  if (!rows.length) return;
  console.log(
    "\nScope (what relaid out; distribution across the window's flushes, never a sum; beside the ms, not a proxy for it)\n",
  );
  for (const row of rows) console.log(row);
}

/** Human report for `query span`: the bar, wall/counts/interaction, forced attribution, hot list. */
export function printSpanAnatomy(
  anatomy: SpanAnatomy,
  span: Span,
  model: CpuModel | undefined,
  meta: RecordingMeta,
  showFrames: boolean,
): void {
  const count = (value: Measured<number>): string =>
    formatMeasured(value, (measured) => String(measured));
  // Name the framework mode only when it was turned OFF: that is why no React block appears below, even
  // on a React app. `auto` is the default and the addon block speaks for itself, so it stays unnamed.
  const frameworkTag = meta.framework === "off" ? " · framework off" : "";
  console.log(
    `\nspan ${bold(middleEllipsis(anatomy.label, LABEL_COL_MAX))} ${dim(`(${anatomy.kind} · ${anatomy.target} · ${anatomy.aggregation} of ${anatomy.iterations} iteration(s)${frameworkTag})`)}`,
  );
  const wall = anatomy.wallMs == null ? "—" : `${num(anatomy.wallMs)} ms`;
  const spread =
    anatomy.samples != null && anatomy.wallMinMs != null && anatomy.wallMaxMs != null
      ? dim(
          ` · ${anatomy.samples} samples, wall ${num(anatomy.wallMinMs, 1)}..${num(anatomy.wallMaxMs, 1)} ms`,
        )
      : "";
  // Point-of-use provenance on the wall itself, each firing only where the bare number misleads: a
  // step's wall is a MEDIAN (its header aggregation "first" describes the counts/bar window, not this
  // number), and a settle-dominated window's width reads as workload unless its idle share sits beside
  // it. The idle tag rides ONLY a span whose wall IS the tiled bar window (idleShareSuffix's contract):
  // a step's headline is the median, not that window, so its idle share stays on the bar's own idle row
  // (whose header names the iteration-0 window), never beside a median it does not describe.
  const wallTags: string[] = [];
  const stepMedian = spanWallProvenance(anatomy.kind, span.perIteration?.length ?? 0);
  if (stepMedian) wallTags.push(stepMedian);
  if (span.breakdown && anatomy.kind !== "step") {
    const idleTag = idleShareSuffix(span.breakdown.slices.idle.ms, span.breakdown.wallMs);
    if (idleTag) wallTags.push(`${idleTag} (window, not work)`);
  }
  // The built-in load flow booted but did near-zero work: it may have measured a consent/region shell
  // in place of the app (the loud meta.notes entry explains). Tag the run line so the reader sees it
  // where the numbers are, not only in the notes block.
  if (
    anatomy.kind === "run" &&
    looksLikePreAppShell({
      isBuiltinLoad: meta.workload?.lane === "builtin-load",
      jsSelfMs: meta.jsSelfMs ?? null,
      layoutCount: anatomy.counts.layoutCount,
      styleCount: anatomy.counts.styleCount,
      paintCount: anatomy.counts.paintCount,
      iterations: anatomy.iterations,
    })
  )
    wallTags.push("possible pre-app shell (near-zero work; see notes)");
  const wallTail = wallTags.length ? dim(` · ${wallTags.join(" · ")}`) : "";
  console.log(`wall: ${bold(wall)}${spread}${wallTail}`);
  // A wall pinned to a frame-cadence floor hides sub-frame work: libraries whose real re-render is
  // each under the floor all report the floor (a measure floors at one frame, a wait-dominated span at
  // a whole multiple of it, docs/dev/frame-floor.md). Surface the faster sample and the js slice
  // beside it so the floored number is not read as "no difference". The n>= gate lives in
  // buildSpanAnatomy (frameFloor is set only when the window is frame-dominated).
  if (anatomy.frameFloor) {
    const floor = anatomy.frameFloor;
    const minMs = span.stats?.minMs ?? span.wallMinMs;
    const belowFloor: string[] = [];
    if (minMs != null && anatomy.wallMs != null && minMs < anatomy.wallMs - 0.5)
      belowFloor.push(`min sample ${num(minMs, 1)} ms`);
    if (anatomy.slices?.js) belowFloor.push(`js ${num(anatomy.slices.js.ms, 1)} ms`);
    const detail = belowFloor.length ? `; sub-frame work reads on ${belowFloor.join(" / ")}` : "";
    // A work-signal floor (a driver step whose wall carries input dispatch) reads as one frame: the
    // work is sub-frame whatever the wall landed on. A wall-multiple floor names its n frames.
    const where =
      floor.basis === "work-signal" || floor.multiple === 1
        ? `the ~${num(floor.floorMs, 1)} ms frame floor`
        : `~${floor.multiple}x the ${num(floor.floorMs, 1)} ms frame floor (${num(floor.floorMs * floor.multiple, 1)} ms)`;
    console.log(dim(`  wall sits on ${where}${detail} (frame-floor.md)`));
  }

  // A driver step's navigation (what its document did) and, on a hard navigation, its boot LCP.
  printStepNavigation(
    anatomy.navigation,
    anatomy.beforeUrl,
    anatomy.afterUrl,
    anatomy.engineSoftNav,
  );
  if (anatomy.lcp) printStepLcp(anatomy.lcp);
  if (anatomy.layoutShift) printLayoutShift(anatomy.layoutShift);
  if (anatomy.softNav) printSoftNavRoute(anatomy.softNav);

  // The reconciling bar, when the capture mode built one. A stored bar prints the seven-slice per-span
  // table; a run span with only the sibling CpuModel bar prints that (four/six slices, honestly labelled).
  if (span.breakdown) printSpanBreakdowns([span], anatomy.iterations, meta.browser, showFrames);
  else if (span.kind === "run" && model?.breakdown) printCpuBreakdown(model, anatomy.iterations);
  else
    console.log(
      dim("\n(no reconciling bar in this capture mode; record with --breakdown for one)"),
    );

  console.log("\nRendering counts (Measured: — = not measured in this capture mode, never 0)\n");
  console.log(
    table(
      ["metric", "count"],
      [
        ["layout", count(anatomy.counts.layoutCount)],
        ["style recalc", count(anatomy.counts.styleCount)],
        ["paint", count(anatomy.counts.paintCount)],
        ["forced layout/style", count(anatomy.counts.forcedLayoutCount)],
        ["layout invalidations", count(anatomy.counts.layoutInvalidations)],
        ["style invalidations", count(anatomy.counts.styleInvalidations)],
        ["long tasks ≥50ms", count(anatomy.counts.longTaskCount)],
      ],
    ),
  );
  // Layout/style scope beside the counts: how much each flush relaid out / recalculated, as a
  // distribution (never a sum). Present only where the capture stored it (--breakdown / firefox style).
  if (anatomy.scope) printSpanScope(anatomy.scope);
  // Firefox forced counts come from the Reflow/Styles markers, and the read that forced each flush is
  // a sampled estimate: a cheap read can be missed, so `query blame --forced` can locate fewer sites
  // than the count (or none). Say so, so a count with no locatable site is not read as a contradiction.
  const firefoxForced = anatomy.counts.forcedLayoutCount;
  if (meta.browser === "firefox" && firefoxForced != null && firefoxForced > 0)
    console.log(
      dim(
        "\nforced layout/style is marker-derived; the read that forced each flush is a sampled estimate (query blame --forced) that can miss cheap reads, so the located sites can number fewer than the count.",
      ),
    );
  // The chrome run counts and the run bar cover different windows, on purpose, so disclose it where
  // both are on screen. Counts are start-onward from run:start with no upper bound, so a paint the
  // run commits just after run:end (the trailing frame paints on the next tick) is counted; the bar
  // above tiles [run:start, run:end] exactly, so its slice ms stop at run:end. A run count can
  // therefore exceed what its bar slice suggests. Step spans are windowed to their own marks and do
  // not have this gap. Firefox is excluded: the gecko lane windows its markers bounded on both sides
  // and reports paint as not-measured, so the start-onward claim is not true there.
  if (anatomy.kind === "run" && span.breakdown && anatomy.target !== "firefox")
    console.log(
      dim(
        "\ncounts are windowed start-onward from run:start (through the settle drain), so a paint/layout the run commits just after run:end is counted; the bar above tiles [run:start, run:end] only, so a count can exceed its slice ms.",
      ),
    );
  // A measure span carries a reconciling bar (real style/layout/paint slice ms) but no counts: counts
  // window to the run/steps, never to an arbitrary user-measure window. Without this the bar's slice
  // ms beside an all-"—" counts table read as a contradiction. Gated on the rendering slices actually
  // summing above 0, so an all-idle bar (no style/layout/paint to reconcile against) prints no note
  // rather than claiming ms it did not measure. Say it, rather than fabricate counts.
  const renderingSliceMs = span.breakdown
    ? span.breakdown.slices.style.ms +
      span.breakdown.slices.layout.ms +
      (span.breakdown.slices.paint?.ms ?? 0)
    : 0;
  if (
    anatomy.kind === "measure" &&
    span.breakdown &&
    anatomy.target !== "firefox" &&
    anatomy.counts.layoutCount == null &&
    renderingSliceMs > 0
  )
    console.log(
      dim(
        "\ncounts are not windowed to a performance.measure span (they scope to the run/steps), so they read — here even though the bar above measured real style/layout/paint ms in this window.",
      ),
    );

  if (anatomy.inpMs != null || anatomy.interaction) {
    const inp = anatomy.inpMs == null ? "—" : `${num(anatomy.inpMs)} ms`;
    console.log(`\nINP (worst interaction): ${bold(inp)}`);
    if (anatomy.interaction) {
      const { inputDelayMs, processingMs, presentationDelayMs } = anatomy.interaction;
      console.log(
        dim(
          `  input delay ${num(inputDelayMs, 2)} ms · processing ${num(processingMs, 2)} ms · presentation ${num(presentationDelayMs, 2)} ms`,
        ),
      );
    }
    // A floored INP is the frame boundary, not the interaction's own cost; point at the sub-frame
    // signal (the processing split above, the js slice) so it is not read as "every tech is equal".
    if (anatomy.inpFrameFloor) {
      const { floorMs, multiple } = anatomy.inpFrameFloor;
      const signal = anatomy.interaction
        ? "the processing split above"
        : anatomy.slices?.js
          ? `js ${num(anatomy.slices.js.ms, 1)} ms`
          : null;
      const detail = signal ? `; the sub-frame cost is ${signal}` : "";
      const where =
        multiple === 1
          ? `the ~${num(floorMs, 1)} ms one-frame floor`
          : `~${multiple}x the ${num(floorMs, 1)} ms frame floor (${num(floorMs * multiple, 1)} ms)`;
      console.log(dim(`  INP sits on ${where}${detail}`));
    }
  }

  if (anatomy.loaf?.frames.length) {
    const loaf = anatomy.loaf;
    console.log(
      `\nLong animation frames: ${bold(String(loaf.observedFrames))} ${dim(
        `(${num(loaf.totalDurationMs, 1)} ms total, ${num(loaf.totalBlockingMs, 1)} ms blocking over the 50ms budget)`,
      )}`,
    );
    console.log(dim("  scripts the browser blamed (source url is the served script, not a line):"));
    for (const frame of loaf.frames) {
      console.log(`  frame ${num(frame.durationMs, 1)} ms:`);
      for (const script of frame.scripts) {
        const forced =
          script.forcedStyleLayoutMs > 0
            ? dim(` · ${num(script.forcedStyleLayoutMs, 1)} ms forced style/layout`)
            : "";
        const name = script.sourceFunctionName ? ` ${script.sourceFunctionName}` : "";
        console.log(
          `    ${num(script.durationMs, 1)} ms  ${script.invoker}${name} ${dim(`(${script.invokerType})`)}`,
        );
        console.log(`      ${dim(script.sourceURL || "(no source url)")}${forced}`);
      }
      if (!frame.scripts.length) console.log(dim("    (no script attribution)"));
    }
  }

  if (anatomy.forced?.length) {
    console.log("\nForced layout/style by source (read that forced the flush):\n");
    const shown = anatomy.forced.slice(0, ANATOMY_FORCED_CAP);
    console.log(
      table(
        ["id", "count", "ms", "source"],
        shown.map((entry) => [
          entry.eventId == null ? dim("—") : dim(String(entry.eventId)),
          entry.count,
          num(entry.durMs, 2),
          middleEllipsis(readSiteCell(entry), SOURCE_COL_MAX) + flushScopeSuffix(entry.scope),
        ]),
      ),
    );
    const withWrites = shown.filter((entry) => entry.dirtiedBy?.length);
    if (withWrites.length) {
      console.log(dim("\n  dirtied-by (the write that forced each read):"));
      for (const entry of withWrites) {
        console.log(`  ${readSiteCell(entry)}`);
        for (const write of entry.dirtiedBy!)
          console.log(
            `    ${dim("↳ dirtied by")} ${write.at}${write.reason ? dim(` (${write.reason})`) : ""}`,
          );
      }
    }
    if (anatomy.forced.length > shown.length)
      console.log(dim(`  … +${anatomy.forced.length - shown.length} more source(s)`));
  }

  if (anatomy.thrash && anatomy.thrash.count > 0)
    console.log(
      `\n⚠ layout thrashed ${bold(`${anatomy.thrash.count}x`)} during the run ${dim("(query blame --forced for the full interleave)")}`,
    );

  if (anatomy.firefoxDirtiedBy) {
    console.log(
      "\ndirtied-by (first invalidation only) — the write Gecko blames for each forced flush:",
    );
    console.log(
      dim(
        "  not Chrome's full write set. Read side: query blame --forced; full report: query blame --dirtied.",
      ),
    );
    for (const write of anatomy.firefoxDirtiedBy.writes.slice(0, ANATOMY_FORCED_CAP))
      console.log(`    ${write.at}  ${dim(`(${write.kinds.join(",")} ×${write.count})`)}`);
  }

  if (anatomy.hot) {
    const hot = anatomy.hot;
    const where =
      hot.scope === "measure-pooled"
        ? `across ${hot.occurrences} occurrence(s)`
        : hot.scope === "step-window"
          ? "in the iteration-0 window"
          : "in the run window";
    if (hot.suppressed) {
      // pooledSamples 0 must NOT say "raise --iterations": more iterations of an un-sampled window
      // stay un-sampled. Split by why the pool is empty (see hotSuppressionReason).
      const message =
        hot.suppressionReason === "not-covered"
          ? `\nHot functions: none — the reconciling bar attributes ${num(anatomy.slices?.js.ms ?? 0, 1)} ms of JS ${where}, but the CPU sampler recorded no samples in it. The V8 profiler resets on each cross-document navigation, so a window that ran before the run's last navigation is not sampled; raising --iterations cannot recover it.`
          : hot.suppressionReason === "no-js"
            ? `\nHot functions: none — this window ran no measurable JS ${where}.`
            : `\nHot functions: suppressed — only ${hot.pooledSamples} pooled JS sample(s) ${where} (below the ${MIN_POOLED_HOT_SAMPLES}-sample floor). Raise --iterations for a stable ranking.`;
      console.log(dim(message));
    } else if (!hot.functions?.length) {
      console.log(
        dim(
          `\nHot functions: ${hot.pooledSamples} pooled JS sample(s) ${where}, none above the per-function floor.`,
        ),
      );
    } else {
      console.log(
        `\nHot functions in this span ${dim(`(${hot.scope}, ${where}, ${num(hot.scriptingMs, 1)} ms JS self over ${hot.pooledSamples} sample(s))`)}. self % is the share of the span's pooled JS samples. Drill with ${cyan("`query frame <id>`")}:\n`,
      );
      console.log(
        table(
          ["id", "self ms", "self %", "package", "function (source)"],
          hot.functions.map((fn) => [
            dim(String(fn.id)),
            num(fn.selfMs, 1),
            `${num(fn.selfPct, 1)}%`,
            cyan(fn.package),
            `${fn.fn}${fn.file ? ` ${dim(`(${shortSource(fn.file, fn.source)})`)}` : ""}`,
          ]),
        ),
      );
    }
  } else if (span.kind !== "run") {
    const pointer = model ? " Use `query cpu` for the run-window hot list." : "";
    // Firefox drives steps through the one gecko pass, which windows hot samples for measures
    // only; pointing at --breakdown there would name a flag the lane refuses.
    const remedy =
      anatomy.target === "firefox"
        ? "step spans carry no hot list on firefox; wrap the work in a performance.measure"
        : "record with --breakdown for per-span hot functions";
    console.log(dim(`\nHot functions: not available in this capture mode (${remedy}).${pointer}`));
  }

  printSpanAddons(anatomy.addons);

  if (anatomy.hints.length) {
    console.log("");
    for (const hint of anatomy.hints) console.log(dim(`  • ${hint}`));
  }
}

/**
 * A compact, clearly-labeled framework-addon block, printed only when an addon attached facts for the
 * span. Factual tone: detection metadata, exact commit counts, the node-lane server-phase rollup, and
 * (dev builds, --deep) the React Performance-Track summary. No editorial. See docs/dev/react-attribution.md.
 */
function printSpanAddons(addons: SpanAddons | undefined): void {
  if (!addons) return;
  const react = addons.react;
  if (react) {
    const identity: string[] = [];
    if (react.detected) identity.push("detected");
    else identity.push("not detected");
    if (react.version) identity.push(`v${react.version}`);
    if (react.rendererPackageName) identity.push(react.rendererPackageName);
    if (react.build) identity.push(react.build);
    if (react.commitCount != null)
      identity.push(`${react.commitCount} commit${react.commitCount === 1 ? "" : "s"}`);
    console.log(`\n${bold("React")} ${dim("(addon)")}: ${identity.join(" · ")}`);
    if (react.phases) {
      const anchors = react.phases.anchors
        .map((anchor) => `${anchor.name} ${num(anchor.selfMs, 1)}`)
        .join(" · ");
      console.log(
        dim(`  server phases: ${num(react.phases.totalMs, 1)} ms react-dom self-time  ${anchors}`),
      );
    }
  }
  const dev = addons["react-dev"];
  if (dev) {
    const tracks = dev.tracks.map((bucket) => `${bucket.track} ×${bucket.count}`).join(" · ");
    console.log(
      `${bold("React tracks")} ${dim("(react-dev addon, dev build)")}: ${dev.total} entries, ${num(dev.totalMs, 1)} ms  ${dim(tracks)}`,
    );
  }
}

/** Human report for the stitch: per-member walls, then each panel tagged with its source member. */
export function printGroupSpanStitch(stitch: GroupSpanStitch): void {
  const count = (value: Measured<number>): string =>
    formatMeasured(value, (measured) => String(measured));
  console.log(
    `\nspan ${bold(middleEllipsis(stitch.label, LABEL_COL_MAX))} ${dim(`(${stitch.kind} · run-group '${stitch.group}' · ${stitch.target})`)}`,
  );
  console.log(dim(`  ${stitchFooterFromSources(stitch)}`));

  console.log("\nWall per member (never combined):\n");
  console.log(
    table(
      ["member", "wall", "agg", "iterations"],
      stitch.members.map((member) => [
        member.variant ? `${member.mode}/${member.variant}` : member.mode,
        member.wallMs == null ? "—" : `${num(member.wallMs, 1)} ms`,
        member.aggregation,
        String(member.iterations),
      ]),
    ),
  );

  if (stitch.slices) {
    console.log(`\nCPU time breakdown ${dim(`(from member '${stitch.sources.slices ?? "?"}')`)}`);
    printUnifiedSlices(stitch.slices);
  } else {
    console.log(dim("\n(no reconciling bar: no member of this group built one)"));
  }

  console.log(
    `\nRendering counts ${dim(`(from member '${stitch.sources.counts ?? "none"}'; Measured: — = not measured, never 0)`)}\n`,
  );
  console.log(
    table(
      ["metric", "count"],
      [
        ["layout", count(stitch.counts.layoutCount)],
        ["style recalc", count(stitch.counts.styleCount)],
        ["paint", count(stitch.counts.paintCount)],
        ["forced layout/style", count(stitch.counts.forcedLayoutCount)],
        ["layout invalidations", count(stitch.counts.layoutInvalidations)],
        ["style invalidations", count(stitch.counts.styleInvalidations)],
        ["long tasks ≥50ms", count(stitch.counts.longTaskCount)],
      ],
    ),
  );
  if (stitch.scope) printSpanScope(stitch.scope);

  printStepNavigation(stitch.navigation, stitch.beforeUrl, stitch.afterUrl, stitch.engineSoftNav);
  if (stitch.lcp) printStepLcp(stitch.lcp);
  if (stitch.layoutShift) printLayoutShift(stitch.layoutShift);
  if (stitch.softNav) printSoftNavRoute(stitch.softNav);

  if (stitch.inpMs != null || stitch.interaction) {
    const inp = stitch.inpMs == null ? "—" : `${num(stitch.inpMs)} ms`;
    console.log(
      `\nINP (worst interaction): ${bold(inp)} ${dim(`(from member '${stitch.sources.inp ?? "?"}')`)}`,
    );
    if (stitch.interaction) {
      const { inputDelayMs, processingMs, presentationDelayMs } = stitch.interaction;
      console.log(
        dim(
          `  input delay ${num(inputDelayMs, 2)} ms · processing ${num(processingMs, 2)} ms · presentation ${num(presentationDelayMs, 2)} ms`,
        ),
      );
    }
  }

  if (stitch.forced?.length) {
    console.log(
      `\nForced layout/style by source ${dim(`(from member '${stitch.sources.forced ?? "?"}'; the read that forced the flush)`)}\n`,
    );
    const shown = stitch.forced.slice(0, ANATOMY_FORCED_CAP);
    console.log(
      table(
        ["id", "count", "ms", "source"],
        shown.map((entry) => [
          entry.eventId == null ? dim("—") : dim(String(entry.eventId)),
          entry.count,
          num(entry.durMs, 2),
          middleEllipsis(readSiteCell(entry), SOURCE_COL_MAX) + flushScopeSuffix(entry.scope),
        ]),
      ),
    );
    if (stitch.forced.length > shown.length)
      console.log(dim(`  … +${stitch.forced.length - shown.length} more source(s)`));
  }
  if (stitch.thrash && stitch.thrash.count > 0)
    console.log(
      `\n⚠ layout thrashed ${bold(`${stitch.thrash.count}x`)} during the run ${dim("(query blame latest --forced for the full interleave)")}`,
    );

  if (stitch.hot?.functions?.length) {
    console.log(
      `\nHot functions ${dim(`(from member '${stitch.sources.hot ?? "?"}', ${num(stitch.hot.scriptingMs, 1)} ms JS self over ${stitch.hot.pooledSamples} sample(s))`)}. Drill with ${cyan("`query frame <id>`")}:\n`,
    );
    console.log(
      table(
        ["id", "self ms", "self %", "package", "function (source)"],
        stitch.hot.functions.map((fn) => [
          dim(String(fn.id)),
          num(fn.selfMs, 1),
          `${num(fn.selfPct, 1)}%`,
          cyan(fn.package),
          `${fn.fn}${fn.file ? ` ${dim(`(${shortSource(fn.file, fn.source)})`)}` : ""}`,
        ]),
      ),
    );
  }

  // Group-level disclosures (count disagreement across members, partial formation): surface them so a
  // stitched number is never read as agreed when the members did not.
  for (const note of stitch.notes) console.log(dim(`\n${note}`));

  if (stitch.hints.length) {
    console.log("");
    for (const hint of stitch.hints) console.log(dim(`  • ${hint}`));
  }
}

/** The footer rebuilt from a stitch's `sources` for the human header (no GroupMember handles here). */
function stitchFooterFromSources(stitch: GroupSpanStitch): string {
  const bar = stitch.sources.slices ? `bar+hot from ${stitch.sources.slices}` : "no bar member";
  const counts = stitch.sources.counts ? `counts from ${stitch.sources.counts}` : null;
  const forced = stitch.sources.forced ? `forced from ${stitch.sources.forced}` : null;
  const rest = [counts, forced].filter(Boolean).join(", ") || "no counts/forced member";
  return `${bar}, ${rest}. Walls are per member, never combined.`;
}

/** Print a UnifiedSlices bar (js/style/layout/paint/gc/other/idle), Measured-honest (— for not-measured). */
function printUnifiedSlices(slices: UnifiedSlices): void {
  const rows: [string, number | null, string][] = [
    ["js", slices.js.ms, ""],
    ["style", slices.style?.ms ?? null, ""],
    ["layout", slices.layout?.ms ?? null, ""],
    ["paint", slices.paint?.ms ?? null, slices.paint ? "" : dim("(not measured)")],
    ["gc", slices.gc.ms, ""],
    ["other", slices.other.ms, dim("(task remainder + engine/unclassified)")],
    ["idle", slices.idle.ms, dim("(waiting, not work)")],
  ];
  const wall = rows.reduce((total, [, ms]) => total + (ms ?? 0), 0);
  console.log(
    table(
      ["slice", "ms", "%", ""],
      rows.map(([name, ms, note]) => [
        name,
        ms == null ? "—" : num(ms, 1),
        ms == null || wall <= 0 ? "—" : `${num((ms / wall) * 100, 1)}%`,
        note,
      ]),
    ),
  );
}

/** One dim line disclosing how many spans --min-wall/--filter hid, so a filtered view is never
 * mistaken for the whole recording. Silent when the filter hid nothing. */
export function printSpanFilterNote(hidden: number): void {
  if (hidden > 0)
    console.log(dim(`\n  ${hidden} span(s) hidden by --min-wall/--filter (drop them to see all).`));
}

/**
 * One subtle line naming the framework identity the overview detected (React version + build), so a
 * bulk `query spans` reader sees it without drilling. Silent when no row carries addon facts. The full
 * per-span facts (commit counts, server phases) live in `query span`.
 */
export function printSpansReactMarker(entries: { addons?: SpanOverviewAddons }[]): void {
  const react = entries.map((entry) => entry.addons?.react).find((fact) => fact != null);
  if (!react) return;
  const parts = [react.version ? `v${react.version}` : null, react.build].filter(Boolean);
  console.log(
    `\n${bold("React")} ${dim(`(addon): ${parts.join(" · ")} · drill with query span <label>`)}`,
  );
}

/**
 * The bar-less span rows that sit BELOW a bar in a mixed overview: driver steps a sampler-only capture
 * (default) built no per-span bar for, or a step that navigated cross-document in a
 * --breakdown recording. Listed by wall + INP rather than dropped from the overview; slices/counts are
 * not on these rows, so the table stays to what is real (wall, aggregation, INP). `hint` names WHY the
 * rows have no bar (it differs by capture mode), so a --breakdown user is not told to run --breakdown.
 */
export function printBarlessStepRows(spans: SpanCountsEntry[], hint: string): void {
  console.log(`\nspans without a bar ${dim(`(${hint})`)}\n`);
  console.log(
    table(
      ["span", "kind", "wall", "agg", "inp"],
      spans.map((span) => [
        middleEllipsis(span.label, LABEL_COL_MAX) + navMarker(span.navigation),
        span.kind,
        span.wallMs == null
          ? "—"
          : `${num(span.wallMs, 1)} ms${span.frameFloor ? dim(" (frame floor)") : ""}`,
        span.aggregation,
        span.inpMs == null ? "—" : `${num(span.inpMs, 1)} ms`,
      ]),
    ),
  );
}

/**
 * `query spans` on a bar-less recording (default/--deep): the overview it CAN render
 * honestly -- label/kind/wall/aggregation and the Measured rendering counts -- with the reconciling
 * bar shown as not-measured. --deep leads with its exact counts here; the default mode
 * carries only the wall (counts —). Never a fabricated all-zero bar.
 */
export async function printBarlessSpans(
  overview: SpanCountsOverview,
  meta: RecordingMeta,
  file: string,
  query: SpansQuery,
  abs: string,
): Promise<void> {
  const label = query.label;
  const selected = label ? overview.spans.filter((span) => span.label === label) : overview.spans;
  // A null-wall span (a navigating step on a no-trace capture mode) is honest, not sub-threshold: only a
  // MEASURED wall below --min-wall hides. --filter matches the label the usual way.
  const passes = (span: SpanCountsEntry): boolean => {
    const needle = query.filter?.toLowerCase();
    if (needle && !span.label.toLowerCase().includes(needle)) return false;
    if (query.minWall != null && span.wallMs != null && span.wallMs < query.minWall) return false;
    return true;
  };
  const spans = selected.filter(passes);
  const hidden = selected.length - spans.length;
  const spanFilter = { minWallMs: query.minWall, labelIncludes: query.filter };

  const fmt = structuredFormat(query);
  const variantField = meta.variant ? { variant: meta.variant } : {};
  if (fmt) return emit({ ...overview, ...variantField, spans, hidden, filter: spanFilter }, fmt);

  if (!spans.length) {
    if (label) return void console.log(`No span labelled '${label}' in ${file}.`);
    return void console.log(
      `No spans matched the filter in ${file} (${hidden} hidden by --min-wall/--filter).`,
    );
  }

  const count = (value: Measured<number>): string =>
    formatMeasured(value, (measured) => String(measured));
  const isDeep = meta.capture === "deep" || isGeckoCaptureMode(meta.capture);
  console.log(
    `\nspans overview ${dim(`(${overview.target}${meta.variant ? ` · variant ${meta.variant}` : ""} · no reconciling bar at this capture · counts Measured: — = not measured, never 0)`)}\n`,
  );
  console.log(
    table(
      ["span", "kind", "wall", "agg", "layout", "style", "paint", "forced", "long≥50ms"],
      spans.map((span) => [
        middleEllipsis(span.label, LABEL_COL_MAX) + navMarker(span.navigation),
        span.kind,
        span.wallMs == null
          ? "—"
          : `${num(span.wallMs, 1)} ms${span.frameFloor ? dim(" (frame floor)") : ""}`,
        span.aggregation,
        count(span.counts.layoutCount),
        count(span.counts.styleCount),
        count(span.counts.paintCount),
        count(span.counts.forcedLayoutCount),
        count(span.counts.longTaskCount),
      ]),
    ),
  );
  printSpanFilterNote(hidden);
  printSpansReactMarker(spans);
  console.log(
    dim(
      isDeep
        ? "\n  Slice ms (js/style/layout/paint) are suppressed on --deep: the .stack trace inflates them, so this capture leads with exact counts (record --breakdown for the reconciling bar)."
        : "\n  No trace at this capture, so rendering counts and a reconciling bar are not measured (—). Record --breakdown for the bar, or --deep for exact counts and forced-layout blame.",
    ),
  );

  const hintPath = await hintTarget(abs);
  console.log(
    dim(
      `\n  • One span's anatomy (counts, forced, hot functions): wpd query span ${hintPath} <label>`,
    ),
  );
  if (isDeep)
    console.log(
      dim(`  • The classified event log: wpd query events ${hintPath} (drill: query get)`),
    );
}
