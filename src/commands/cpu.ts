import type { CpuModel, FrameSideTrack, SpanBreakdown } from "../model/recording.js";
import type { CpuOverview, FrameQueryResult } from "../model/query.js";
import { num, table } from "../output/ascii.js";
import { bold, cyan, dim, red, yellow } from "../output/color.js";
import { serialize, isFormat, type Format } from "../output/format.js";

// Warm "heat" for a self-time share: the bigger the cost, the louder the color.
const heat = (pct: number, text: string): string =>
  pct >= 25 ? red(text) : pct >= 10 ? yellow(text) : text;

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
    `\nCPU profile: ${bold(`${num(model.scriptingMs, 1)} ms`)} JS self-time, sampled · ${dim(`${model.sampleCount} samples`)} (run ${cyan("'query cpu latest'")} to drill):\n`,
  );
  console.log(
    table(
      HEAD(["package", "self ms", "self %", "fns"]),
      byPackage
        .slice(0, 8)
        .map((entry) => [
          entry.key,
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
export function printCpuBreakdown(model: CpuModel): void {
  const breakdown = model.breakdown;
  if (!breakdown) return;
  const { wallMs, slices } = breakdown;
  // An empty profile (no sampled window) has nothing to tile; skip rather than print an
  // all-placeholder ("—") table that says nothing.
  if (wallMs <= 0) return;
  const isNode = model.meta.runtime === "node";
  // On the node lane the non-JS engine slice is V8 runtime/native, not a browser; label it honestly.
  const browserLabel = isNode ? "native" : "browser";
  // wallMs > 0 is guaranteed by the early return above.
  const pct = (ms: number): string => `${num((ms / wallMs) * 100, 1)}%`;

  // Top packages of the js slice, as a compact "react-dom 401.2 · app 190.3" annotation.
  const topPackages = Object.entries(slices.js.byPackage)
    .sort((left, right) => right[1] - left[1])
    .slice(0, BREAKDOWN_TOP_PACKAGES)
    .map(([owner, ms]) => `${owner} ${num(ms, 1)}`)
    .join(" · ");

  console.log(`\nCPU time breakdown ${dim(`(sampled window, ${num(wallMs, 1)} ms)`)}\n`);
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
        heat((ms / wallMs) * 100, pct(ms)),
        note,
      ]),
    ),
  );
  // Browser lanes fold synchronous engine work (a forced layout) into the forcing JS frame, so the
  // js slice is not pure JS. --target node has no DOM, so its js slice really is pure JS.
  if (!isNode)
    console.log(
      dim(
        "js includes synchronous engine work JS triggered (e.g. forced layout bills to the forcing frame); it is not pure JS.",
      ),
    );
}

/**
 * The reconciling seven-slice bar per span (--breakdown mode): `js · style · layout · paint · gc ·
 * other · idle`, tiling each span's window exactly (Σ slices + idle == wallMs). `other` stays
 * visible and `idle` is annotated; the js slice carries a compact by-package annotation. In
 * --breakdown mode this replaces the single js/browser/gc/idle profile bar (printCpuBreakdown).
 */
export function printSpanBreakdowns(breakdowns: SpanBreakdown[]): void {
  if (!breakdowns.length) return;
  console.log(`\nCPU time breakdown ${dim("(per span: Σ slices + idle = wall)")}`);
  for (const span of breakdowns) {
    const { wallMs, slices, residualMs } = span.breakdown;
    const label = `${span.label} ${dim(`(${span.kind}, ${num(wallMs, 1)} ms)`)}`;
    console.log(`\n${bold(label)}`);
    if (wallMs <= 0) {
      console.log(dim("  (empty window; nothing to tile)"));
      continue;
    }
    const pct = (ms: number): string => `${num((ms / wallMs) * 100, 1)}%`;
    const topPackages = Object.entries(slices.js.byPackage)
      .sort((left, right) => right[1] - left[1])
      .slice(0, BREAKDOWN_TOP_PACKAGES)
      .map(([owner, ms]) => `${owner} ${num(ms, 1)}`)
      .join(" · ");
    // Fixed order: real work first, idle last, so the eye lands on the cost.
    const rows: [string, number, string][] = [
      ["js", slices.js.ms, topPackages],
      ["style", slices.style.ms, ""],
      ["layout", slices.layout.ms, ""],
      ["paint", slices.paint.ms, ""],
      ["gc", slices.gc.ms, ""],
      ["other", slices.other.ms, dim("(task remainder + unclassified)")],
      ["idle", slices.idle.ms, dim("(waiting, not work)")],
    ];
    console.log(
      table(
        HEAD(["slice", "ms", "%", ""]),
        rows.map(([name, ms, note]) => [
          name,
          num(ms, 1),
          heat((ms / wallMs) * 100, pct(ms)),
          note,
        ]),
      ),
    );
    if (residualMs != null)
      console.log(dim(`  residual ${num(residualMs, 3)} ms (tiling did not fully close)`));
    if (span.frames) printFrameSideTrack(span.frames);
  }
  console.log(
    dim(
      "\njs includes synchronous engine work JS triggered (e.g. forced layout bills to the forcing frame); it is not pure JS.",
    ),
  );
}

/**
 * One compact off-thread frame line under a span's bar, plus a line naming any dropped or
 * smoothness-affecting frame and the slowest presented (incl. partial) frame's top stages.
 * DISPLAY-ONLY: these numbers are scheduler noise (see docs/dev/rendering-counts.md) and never feed a
 * bar or a gate.
 */
function printFrameSideTrack(frames: FrameSideTrack): void {
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
  for (const frame of jank)
    console.log(
      yellow(
        `  ⚠ frame ${frame.sequence}: ${frame.state}${frame.affectsSmoothness ? ", affects smoothness" : ""} (${num(frame.durMs, 1)} ms)`,
      ),
    );
  if (frames.worstStages?.length) {
    const stages = frames.worstStages
      .map((stage) => `${stage.name} ${num(stage.ms, 1)}`)
      .join(" · ");
    console.log(dim(`  slowest presented (incl. partial) frame stages: ${stages}`));
  }
}

interface OutOpts {
  json?: boolean;
  format?: string;
  top?: number;
  by?: string;
}

function structuredFormat(opts: OutOpts): Format | null {
  if (opts.format) {
    if (!isFormat(opts.format)) throw new Error("--format must be json or toon");
    return opts.format;
  }
  return opts.json ? "json" : null;
}

function emit(value: unknown, fmt: Format): void {
  console.log(serialize(value, fmt));
}

const DEFAULT_TOP = 25;

/** How many packages the breakdown's js-slice annotation names before eliding the rest. */
const BREAKDOWN_TOP_PACKAGES = 4;

const GROUPINGS = new Set(["package", "file", "function"]);

/** Overview: where self time goes, by package/file and by function. Bounded in size. */
export async function queryCpu(file: string, opts: OutOpts): Promise<void> {
  const by = opts.by ?? "package";
  if (!GROUPINGS.has(by)) throw new Error(`--by must be one of: package, file, function`);
  const model = await loadCpuModel(file);
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
      scriptingMs: model.scriptingMs,
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
  console.log(
    `CPU sampling: ${bold(`${num(model.scriptingMs, 1)} ms`)} JS self-time ${dim(`(${windowNote}) · ${model.sampleCount} samples @ ${model.sampleIntervalUs}us · idle ${num(model.system.idleMs, 1)} ms · gc ${num(model.system.gcMs, 1)} ms`)}`,
  );
  if (model.breakdown)
    console.log(
      dim(
        "  (that headline is the sampled total minus idle; the bar below splits it, breaking gc and browser/engine work out of the js slice.)",
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
            by === "file" ? tailPath(entry.key, 3) : entry.key,
            num(entry.selfMs, 1),
            heat(entry.selfPct, `${num(entry.selfPct, 1)}%`),
            dim(String(entry.functions)),
          ]),
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
  const model = await loadCpuModel(file);
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
