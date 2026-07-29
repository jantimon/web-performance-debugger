import type { CpuModel, FrameSideTrack, Span, SpanKind } from "../model/recording.js";
import type { CpuOverview, FrameQueryResult } from "../model/query.js";
import type { FrameFloorMatch } from "../model/frame-floor.js";
import { num, table, middleEllipsis, LABEL_COL_MAX } from "../output/ascii.js";
import { bold, cyan, dim, red, yellow } from "../output/color.js";
import { structuredFormat, emit, type StructuredOutOpts } from "../output/format.js";
import { spanAggregation } from "../model/spans.js";
import { recordingRuntime } from "../model/meta.js";
import { resolveVerbTarget, routingNote } from "./group.js";

/**
 * The `(first|sum of N iterations)` / `(median of N samples)` suffix a bar prints, so a reader knows a
 * run bar is a TOTAL, a step bar is one iteration, and a repeated-measure bar is the median of its
 * occurrences. A merged measure (`samples > 1`) names its occurrence count regardless of the
 * iteration count; otherwise the suffix is empty at N<=1 (nothing to disambiguate) or when the caller
 * passes no iteration count (the single profile-only `printCpuBreakdown` bar, called without one).
 */
function aggregationSuffix(kind: SpanKind, iterations?: number, samples?: number): string {
  const aggregation = spanAggregation(kind, samples);
  if (aggregation === "median") return `, median of ${samples} samples`;
  if (iterations == null || iterations <= 1) return "";
  return `, ${aggregation} of ${iterations} iterations`;
}

// Warm "heat" for a self-time share: the bigger the cost, the louder the color.
const heat = (pct: number, text: string): string =>
  pct >= 25 ? red(text) : pct >= 10 ? yellow(text) : text;

// A slice's share of the bar wall, as a "12.3%" label. Callers guard wallMs > 0.
const slicePct = (ms: number, wallMs: number): string => `${num((ms / wallMs) * 100, 1)}%`;

/**
 * A subtle tag on an origin-bucket package cell for a CROSS-SITE origin (a different registrable
 * domain than the measured page). It is `site relation`, a URL-mechanical fact, NEVER an ownership or
 * "third-party" claim: a cross-site CDN can be first-party-owned. same-origin/same-site stay unmarked
 * to keep the table quiet; only cross-site (the row a reader most wants flagged) carries the tag.
 */
const siteRelationTag = (entry: { siteRelation?: string }): string =>
  entry.siteRelation === "cross-site" ? ` ${dim("cross-site")}` : "";

/**
 * The "what the js slice includes" footer, engine-conditioned AND bar-conditioned, because the two
 * chrome bars measure js differently:
 *
 *   - The CPU-model bar (printCpuBreakdown) is sampler self-time. The V8 sampler walks the JS stack,
 *     so the synchronous engine work JS triggered (a forced layout) is billed to the forcing JS
 *     frame: js is NOT pure JS. That is the `bars: "cpu-model"` footer.
 *   - The reconciling tiled bar (printSpanBreakdowns) is disjoint trace self-time. A Layout/
 *     UpdateLayoutTree event tiles into the style/layout slices, so the js slice is trace scripting
 *     self-time WITHOUT the nested flush: a forced layout bills to style/layout, not js. That is the
 *     `bars: "reconciling"` footer, structurally the firefox note but for chrome.
 *
 * Firefox has only the reconciling-shaped bar (sampled from Layout-category frames), so it reads the
 * same on both call sites: a forced layout bills to style/layout and js can read near 0 on a JS-driven
 * flush (docs/dev/engine-mapping.md). Node has no DOM, so its js really is pure JS: no footer.
 */
function jsSliceFooter(
  engine: "chrome" | "firefox" | "node",
  bars: "cpu-model" | "reconciling",
): string | null {
  if (engine === "node") return null;
  if (engine === "firefox")
    return "on firefox the js slice is sampled JS only; synchronous engine work JS triggered (e.g. a forced layout) bills to the style/layout slices, not js, so a JS-driven forced layout can read js near 0.";
  if (bars === "reconciling")
    return "on this reconciling bar the js slice is trace scripting self-time; synchronous engine work JS triggered (e.g. a forced layout) tiles into the style/layout slices, not js.";
  return "js includes synchronous engine work JS triggered (e.g. forced layout bills to the forcing frame); it is not pure JS.";
}

/**
 * Firefox bars come off the Gecko sampler, clamped to a ~1ms interval (GECKO_MIN_INTERVAL_MS), so a 0
 * or 1 ms slice is a sample count, not a precise duration. Disclosed so per-package ties and binary
 * 0/1 ms slices are not read as exact.
 */
const FIREFOX_QUANTIZATION_NOTE =
  "firefox slices quantize to the ~1 ms Gecko sampler interval; read a 0 or 1 ms slice as at-or-below sampler resolution, not precise.";

const HEAD = (labels: string[]): string[] => labels.map((label) => bold(label));
import {
  packageRollup,
  fileRollup,
  loadCpuModel,
  shortSource,
  tailPath,
} from "../profile/cpuprofile.js";

/** Compact by-package headline, printed right after `record`. */
export function printCpuHeadline(model: CpuModel): void {
  const byPackage = packageRollup(model);
  console.log(
    `\nCPU profile: ${bold(`${num(model.jsSelfMs, 1)} ms`)} JS self-time, sampled · ${dim(`${model.sampleCount} samples`)} (run ${cyan("'query cpu latest'")} to drill):\n`,
  );
  console.log(
    table(
      HEAD(["package", "self ms", "self %", "fns"]),
      byPackage
        .slice(0, 8)
        .map((entry) => [
          entry.key + siteRelationTag(entry),
          num(entry.selfMs, 1),
          heat(entry.selfPct, `${num(entry.selfPct, 1)}%`),
          dim(String(entry.functions)),
        ]),
    ),
  );
}

/**
 * The reconciling `js · browser · gc · idle` bar, printed after the CPU headline. The slices tile
 * the sampled window exactly (js + browser + gc + idle == wallMs), so the row percentages sum to
 * 100. No-op when the model carries no breakdown (a Firefox dump without the threadCPUDelta CPU
 * signal, or an older model).
 */
export function printCpuBreakdown(model: CpuModel, iterations?: number): void {
  const breakdown = model.breakdown;
  if (!breakdown) return;
  const { wallMs, slices } = breakdown;
  // An empty profile (no sampled window) has nothing to tile; skip rather than print an
  // all-placeholder ("—") table that says nothing.
  if (wallMs <= 0) return;
  const isNode = recordingRuntime(model.meta) === "node";
  // On the node lane the non-JS engine slice is V8 runtime/native, not a browser; label it honestly.
  const browserLabel = isNode ? "native" : "browser";

  // Top packages of the js slice, as a compact "react-dom 401.2 · app 190.3" annotation.
  const topPackages = Object.entries(slices.js.byPackage)
    .sort((left, right) => right[1] - left[1])
    .slice(0, BREAKDOWN_TOP_PACKAGES)
    .map(([owner, ms]) => `${owner} ${num(ms, 1)}`)
    .join(" · ");

  // A CpuModel-synthesized bar is always the run span, so its aggregation is `sum`.
  console.log(
    `\nCPU time breakdown ${dim(`(sampled window, ${num(wallMs, 1)} ms${aggregationSuffix("run", iterations)})`)}\n`,
  );
  // Fixed order: real work first (js, then style/layout when the lane splits them), idle last.
  // style/layout are present only on the Firefox lane (from the per-sample Layout-category frame).
  const rows: [string, number, string][] = [["js", slices.js.ms, topPackages]];
  if (slices.style) rows.push(["style", slices.style.ms, ""]);
  if (slices.layout) rows.push(["layout", slices.layout.ms, ""]);
  rows.push(["gc", slices.gc.ms, ""]);
  rows.push([browserLabel, slices.browser.ms, dim("(engine work, unsplit)")]);
  rows.push(["idle", slices.idle.ms, dim("(waiting, not work)")]);
  console.log(
    table(
      HEAD(["slice", "ms", "%", ""]),
      rows.map(([label, ms, note]) => [
        label,
        num(ms, 1),
        heat((ms / wallMs) * 100, slicePct(ms, wallMs)),
        note,
      ]),
    ),
  );
  // The js-slice footer is engine-conditioned: on firefox the forced-layout cost lands in
  // style/layout, not js (see jsSliceFooter), and the gecko bar quantizes to the ~1ms sampler.
  const engine = isNode ? "node" : model.meta.browser === "firefox" ? "firefox" : "chrome";
  const footer = jsSliceFooter(engine, "cpu-model");
  if (footer) console.log(dim(footer));
  if (engine === "firefox") console.log(dim(FIREFOX_QUANTIZATION_NOTE));
}

/**
 * The reconciling seven-slice bar per span (--breakdown mode): `js · style · layout · paint · gc ·
 * other · idle`, tiling each span's window exactly (Σ slices + idle == wallMs). `other` stays
 * visible and `idle` is annotated; the js slice carries a compact by-package annotation. In
 * --breakdown mode this replaces the single js/browser/gc/idle profile bar (printCpuBreakdown).
 */
export function printSpanBreakdowns(
  spans: Span[],
  iterations?: number,
  browser?: "chrome" | "firefox",
  showFrames = false,
  frameFloors?: Map<string, FrameFloorMatch>,
): void {
  const bars = spans.filter((span) => span.breakdown);
  if (!bars.length) return;
  console.log(`\nCPU time breakdown ${dim("(per span: Σ slices + idle = wall)")}`);
  for (const span of bars) {
    const { wallMs, slices, residualMs } = span.breakdown!;
    // A step's bar tiles iteration 0 ONLY, so this window is NOT the step's headline wall (the median
    // of its samples, printed separately). Name it the iteration-0 window so the two are not conflated
    // when an outlier iteration 0 makes them diverge.
    const windowLabel = span.kind === "step" ? "iteration-0 window " : "";
    const nav = span.navigation && span.navigation !== "none" ? `, nav: ${span.navigation}` : "";
    // A wall pinned to the frame-cadence floor hides sub-frame work (frame-floor.md). Tag it here so
    // the overview shows the floor the `query span` detail spells out, without crowding the table.
    const floor = frameFloors?.get(`${span.kind}:${span.label}`);
    const floorTag = floor
      ? floor.multiple === 1
        ? ", on frame floor"
        : `, on ${floor.multiple}x frame floor`
      : "";
    const label = `${middleEllipsis(span.label, LABEL_COL_MAX)} ${dim(`(${span.kind}, ${windowLabel}${num(wallMs, 1)} ms${aggregationSuffix(span.kind, iterations, span.samples)}${nav}${floorTag})`)}`;
    console.log(`\n${bold(label)}`);
    if (wallMs <= 0) {
      console.log(dim("  (empty window; nothing to tile)"));
      continue;
    }
    // A merged measure bar is a real picked sample; disclose the spread it stands in for.
    if (span.samples != null && span.wallMinMs != null && span.wallMaxMs != null)
      console.log(
        dim(
          `  wall spread ${num(span.wallMinMs, 1)}..${num(span.wallMaxMs, 1)} ms across ${span.samples} samples`,
        ),
      );
    const topPackages = Object.entries(slices.js.byPackage)
      .sort((left, right) => right[1] - left[1])
      .slice(0, BREAKDOWN_TOP_PACKAGES)
      .map(([owner, ms]) => `${owner} ${num(ms, 1)}`)
      .join(" · ");
    // Fixed order: real work first, idle last, so the eye lands on the cost. paint is `Measured`:
    // null on firefox (off-main-thread), where the row prints "—", never a fake 0.
    const rows: [string, number | null, string][] = [
      ["js", slices.js.ms, topPackages],
      ["style", slices.style.ms, ""],
      ["layout", slices.layout.ms, ""],
      [
        "paint",
        slices.paint?.ms ?? null,
        slices.paint ? "" : dim("(off-main-thread; not measured)"),
      ],
      ["gc", slices.gc.ms, ""],
      ["other", slices.other.ms, dim("(task remainder + unclassified)")],
      ["idle", slices.idle.ms, dim("(waiting, not work)")],
    ];
    console.log(
      table(
        HEAD(["slice", "ms", "%", ""]),
        rows.map(([name, ms, note]) => [
          name,
          ms == null ? "—" : num(ms, 1),
          ms == null ? "—" : heat((ms / wallMs) * 100, slicePct(ms, wallMs)),
          note,
        ]),
      ),
    );
    if (residualMs != null)
      console.log(dim(`  residual ${num(residualMs, 3)} ms (tiling did not fully close)`));
    if (span.frames) printFrameSideTrack(span.frames, showFrames);
  }
  // Engine-conditioned footer for the RECONCILING tiled bar: on both engines a forced layout bills to
  // the style/layout slices, not js (the tiling bills each Layout/UpdateLayoutTree event there), so
  // this is the "reconciling" footer, never the CPU-model bar's forcing-frame fold. Firefox slices
  // also quantize to the ~1ms Gecko sampler.
  const engine = browser === "firefox" ? "firefox" : "chrome";
  console.log(dim(`\n${jsSliceFooter(engine, "reconciling")}`));
  if (engine === "firefox") console.log(dim(FIREFOX_QUANTIZATION_NOTE));
}

/**
 * One compact off-thread frame line under a span's bar: the verdict tally, plus a one-line count of
 * any dropped/smoothness-affecting frames and the slowest presented (incl. partial) frame's top
 * stages. On a real page a span spans dozens of frames, so the per-frame jank lines flood the bars;
 * they print one per frame only under `showFrames` (`--frames`). DISPLAY-ONLY: these numbers are
 * scheduler noise (see docs/dev/rendering-counts.md) and never feed a bar or a gate. The JSON output
 * keeps every per-frame record regardless.
 */
function printFrameSideTrack(frames: FrameSideTrack, showFrames: boolean): void {
  const parts = [
    `${frames.presented} presented`,
    `${frames.presentedPartial} partial`,
    `${frames.dropped} dropped`,
  ];
  if (frames.noUpdate > 0) parts.push(`${frames.noUpdate} no-update`);
  console.log(`  frames: ${parts.join(" · ")} ${dim("(off-thread; display-only, never gate)")}`);
  const jank = frames.frames.filter(
    (frame) => frame.state === "dropped" || frame.affectsSmoothness,
  );
  if (jank.length) {
    if (showFrames)
      for (const frame of jank)
        console.log(
          yellow(
            `  ⚠ frame ${frame.sequence}: ${frame.state}${frame.affectsSmoothness ? ", affects smoothness" : ""} (${num(frame.durMs, 1)} ms)`,
          ),
        );
    else
      console.log(
        yellow(
          `  ⚠ ${jank.length} frame(s) dropped or affecting smoothness ${dim("(--frames to list each)")}`,
        ),
      );
  }
  if (frames.worstStages?.length) {
    const stages = frames.worstStages
      .map((stage) => `${stage.name} ${num(stage.ms, 1)}`)
      .join(" · ");
    console.log(dim(`  slowest presented (incl. partial) frame stages: ${stages}`));
  }
}

interface OutOpts extends StructuredOutOpts {
  top?: number;
  by?: string;
}

const DEFAULT_TOP = 25;

/** How many packages the breakdown's js-slice annotation names before eliding the rest. */
const BREAKDOWN_TOP_PACKAGES = 4;

const GROUPINGS = new Set(["package", "file", "function"]);

/** Overview: where self time goes, by package/file and by function. Bounded in size. */
export async function queryCpu(file: string, opts: OutOpts): Promise<void> {
  const by = opts.by ?? "package";
  if (!GROUPINGS.has(by)) throw new Error(`--by must be one of: package, file, function`);
  // A run-group routes to its CPU-bearing member (breakdown preferred); a plain recording is itself.
  const routed = await resolveVerbTarget(file, "cpu", "CPU sampling");
  const model = await loadCpuModel(routed.target);
  const routeLine = routingNote(routed, "CPU sampling");
  if (routeLine && !structuredFormat(opts)) console.log(dim(routeLine));
  const topN = opts.top != null ? opts.top : DEFAULT_TOP;
  const byPackage = packageRollup(model);
  const byFile = fileRollup(model);
  const hot = model.functions.slice(0, topN);
  const droppedFrames = model.functions.slice(topN);
  const dropped = {
    frames: droppedFrames.length,
    selfMs: droppedFrames.reduce((sum, fn) => sum + fn.selfMs, 0),
  };

  const fmt = structuredFormat(opts);
  if (fmt) {
    const hints = [
      "Drill one function by id: wpd query frame latest <id>",
      "Group differently: wpd query cpu latest --by file",
      "Compare two runs: wpd cpu-diff <baseline.cpu.json> <current.cpu.json>",
    ];
    // On firefox the run bar lives here on CpuModel.breakdown (a different shape than chrome's
    // SpanBreakdown), and `query cpu` cannot isolate a performance.measure span. Point the consumer
    // at the unified per-span surface, which reports the same shape as chrome and honors --label.
    if (model.meta.browser === "firefox")
      hints.unshift(
        "Per-span bars (run + your performance.measure spans), unified with chrome: wpd query spans latest",
      );
    const overview: CpuOverview = {
      profile: model.profile,
      jsSelfMs: model.jsSelfMs,
      activeMs: model.activeMs,
      totalMs: model.totalMs,
      sampleCount: model.sampleCount,
      sampleIntervalUs: model.sampleIntervalUs,
      system: model.system,
      breakdown: model.breakdown,
      byPackage,
      byFile,
      hot,
      dropped,
      hints,
    };
    return emit(overview, fmt);
  }

  const iterations = model.meta.iterations;
  const windowNote =
    iterations > 1
      ? `sampled, summed over the whole window across ${iterations} iterations (divide by ${iterations} for a per-iteration figure)`
      : "sampled, summed over the whole window";
  // Host-CPU speed scalar in the header: self-time ms are host-relative, so this is the fact a reader
  // needs to know two runs' numbers are on the same speed scale (and the cpu-diff gate axis).
  const hostCpu = model.meta.hostCpuIndex != null ? ` · host-cpu ${model.meta.hostCpuIndex}` : "";
  console.log(
    `CPU sampling: ${bold(`${num(model.jsSelfMs, 1)} ms`)} JS self-time ${dim(`(${windowNote}) · of ${num(model.activeMs, 1)} ms non-idle sampled · ${model.sampleCount} samples @ ${model.sampleIntervalUs}us · idle ${num(model.system.idleMs, 1)} ms · gc ${num(model.system.gcMs, 1)} ms${hostCpu}`)}`,
  );
  if (model.breakdown)
    console.log(
      dim(
        "  (the headline is JS self-time only; the non-idle sampled total also carries gc and browser/engine work, which the bar below splits out of the js slice.)",
      ),
    );
  printCpuBreakdown(model);
  // Firefox surfaces its run bar here, but per-span (performance.measure) bars and the chrome-shaped
  // slice set live on `query spans`; point there so a consumer does not read this as the only surface.
  if (model.meta.browser === "firefox")
    console.log(dim("per-span bars (run + your performance.measure spans): query spans"));
  if (by !== "function") {
    const grouping = by === "file" ? byFile : byPackage;
    console.log(`\nBy ${by} (self time):\n`);
    console.log(
      table(
        HEAD([by, "self ms", "self %", "fns"]),
        grouping
          .slice(0, 15)
          .map((entry) => [
            by === "file" ? tailPath(entry.key, 3) : entry.key + siteRelationTag(entry),
            num(entry.selfMs, 1),
            heat(entry.selfPct, `${num(entry.selfPct, 1)}%`),
            dim(String(entry.functions)),
          ]),
      ),
    );
    // Explain the cross-site tag once, and draw the honesty boundary loudly: it is a URL-mechanical
    // relation, never an ownership or third-party claim (a cross-site CDN can be first-party-owned).
    if (by === "package" && byPackage.some((entry) => entry.siteRelation === "cross-site"))
      console.log(
        dim(
          "  cross-site = a different registrable domain than the measured page (a URL fact via the public-suffix list), NOT an ownership or third-party claim: a cross-site CDN can be first-party-owned (e.g. a brand's own asset CDN).",
        ),
      );
  }
  console.log(`\nHot functions (by self time). Drill with ${cyan("`query frame <id>`")}:\n`);
  console.log(
    table(
      HEAD(["id", "self ms", "self %", "total ms", "package", "function (source)"]),
      hot.map((fn) => [
        dim(String(fn.id)),
        num(fn.selfMs, 1),
        heat(fn.selfPct, `${num(fn.selfPct, 1)}%`),
        num(fn.totalMs, 1),
        cyan(fn.package),
        `${fn.fn}${fn.file ? ` ${dim(`(${shortSource(fn.file, fn.source)})`)}` : ""}`,
      ]),
    ),
  );
  if (dropped.frames)
    console.log(
      dim(
        `\n${dropped.frames} more function(s) below the top ${topN}, totaling ${num(dropped.selfMs, 1)} ms self.`,
      ),
    );
}

/** Drill one function by id: its source, top callers, and top callees. */
export async function queryFrame(file: string, id: number, opts: OutOpts): Promise<void> {
  const routed = await resolveVerbTarget(file, "cpu", "CPU sampling");
  const model = await loadCpuModel(routed.target);
  const routeLine = routingNote(routed, "CPU sampling");
  if (routeLine && !structuredFormat(opts)) console.log(dim(routeLine));
  const target = model.functions[id];
  if (!target)
    throw new Error(`No function with id ${id} (have 0..${model.functions.length - 1}).`);

  const callers = model.edges
    .filter((edge) => edge.callee === id)
    .map((edge) => ({ fn: model.functions[edge.caller], ms: edge.ms }))
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 12);
  const callees = model.edges
    .filter((edge) => edge.caller === id)
    .map((edge) => ({ fn: model.functions[edge.callee], ms: edge.ms }))
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 12);

  const fmt = structuredFormat(opts);
  if (fmt) {
    const result: FrameQueryResult = {
      function: target,
      callers: callers.map((entry) => ({ id: entry.fn.id, fn: entry.fn.fn, ms: entry.ms })),
      callees: callees.map((entry) => ({ id: entry.fn.id, fn: entry.fn.fn, ms: entry.ms })),
    };
    return emit(result, fmt);
  }

  console.log(
    `#${target.id} ${target.fn}${target.minified ? ` [minified: ${target.minified}]` : ""}${target.source ? ` (${target.source})` : ""}\n  package ${target.package} · self ${num(target.selfMs, 1)} ms · total ${num(target.totalMs, 1)} ms`,
  );
  console.log("\ncallers (time arriving here, by caller):\n");
  console.log(
    callers.length
      ? table(
          ["ms", "id", "function"],
          callers.map((entry) => [num(entry.ms, 1), entry.fn.id, entry.fn.fn]),
        )
      : "  (none; top-level / root)",
  );
  console.log("\ncallees (where this function's time goes):\n");
  console.log(
    callees.length
      ? table(
          ["ms", "id", "function"],
          callees.map((entry) => [num(entry.ms, 1), entry.fn.id, entry.fn.fn]),
        )
      : "  (none; leaf / self time only)",
  );
}
