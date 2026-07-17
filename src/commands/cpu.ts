import type { CpuModel } from "../model/recording.js";
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
 * 100. No-op when the model carries no breakdown (Firefox, or an older model).
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
  // Fixed order js -> gc -> browser -> idle, so the eye lands on real work first and idle last.
  const rows: [string, number, string][] = [
    ["js", slices.js.ms, topPackages],
    ["gc", slices.gc.ms, ""],
    [browserLabel, slices.browser.ms, dim("(engine work, unsplit)")],
    ["idle", slices.idle.ms, dim("(waiting, not work)")],
  ];
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
      hints: [
        "Drill one function by id: wpd query frame latest <id>",
        "Group differently: wpd query cpu latest --by file",
        "Compare two runs: wpd cpu-diff <baseline.cpu.json> <current.cpu.json>",
      ],
    };
    return emit(overview, fmt);
  }

  console.log(
    `CPU sampling: ${bold(`${num(model.scriptingMs, 1)} ms`)} JS self-time ${dim(`(sampled, summed over the whole window) · ${model.sampleCount} samples @ ${model.sampleIntervalUs}us · idle ${num(model.system.idleMs, 1)} ms · gc ${num(model.system.gcMs, 1)} ms`)}`,
  );
  if (model.breakdown)
    console.log(
      dim(
        "  (that headline is the sampled total minus idle; the bar below splits it, breaking gc and browser/engine work out of the js slice.)",
      ),
    );
  printCpuBreakdown(model);
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
