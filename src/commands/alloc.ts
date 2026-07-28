import type { AllocModel } from "../model/recording.js";
import type { AllocOverview } from "../model/query.js";
import { num, table } from "../output/ascii.js";
import { bold, cyan, dim, red, yellow } from "../output/color.js";
import { structuredFormat, emit, type StructuredOutOpts } from "../output/format.js";
import { loadAllocModel, packageAllocRollup, fileAllocRollup } from "../profile/allocprofile.js";
import { shortSource, tailPath } from "../profile/cpuprofile.js";

// Warm "heat" for an allocation share: the bigger the share, the louder the color. Same thresholds
// as the CPU report, so the two read the same way.
const heat = (pct: number, text: string): string =>
  pct >= 25 ? red(text) : pct >= 10 ? yellow(text) : text;

/** Bytes as a compact "12.3 MB" / "456.0 KB" / "789 B" cell. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${num(bytes / (1024 * 1024), 1)} MB`;
  if (bytes >= 1024) return `${num(bytes / 1024, 1)} KB`;
  return `${Math.round(bytes)} B`;
}

const HEAD = (labels: string[]): string[] => labels.map((label) => bold(label));

/** The two-tier trust sentence, printed in the report footer (and stated in meta.notes + the README).
 * Shares/ratios are the signal; the absolute total is directional. */
const ALLOC_TRUST =
  "Allocated bytes are sampled (GC-inclusive) on V8's allocation clock. Trustworthy in aggregate as per-package shares and ratios (~5% ratio fidelity); the absolute byte total is directional (~10-20%), not exact.";

/** Compact by-package headline, printed right after `record --alloc`. */
export function printAllocHeadline(model: AllocModel): void {
  const byPackage = packageAllocRollup(model);
  console.log(
    `\nAllocation: ${bold(fmtBytes(model.totalBytes))} sampled ${dim(`(GC-inclusive, ${model.sampleCount} samples @ ${fmtBytes(model.sampling.samplingIntervalBytes)} interval)`)} (run ${cyan("'query alloc latest'")} to drill):\n`,
  );
  console.log(
    table(
      HEAD(["package", "bytes", "share", "fns"]),
      byPackage
        .slice(0, 8)
        .map((entry) => [
          entry.key,
          fmtBytes(entry.selfBytes),
          heat(entry.selfPct, `${num(entry.selfPct, 1)}%`),
          dim(String(entry.functions)),
        ]),
    ),
  );
  console.log(dim(ALLOC_TRUST));
}

interface OutOpts extends StructuredOutOpts {
  top?: number;
  by?: string;
}

const DEFAULT_TOP = 25;
const GROUPINGS = new Set(["package", "file", "function"]);

/** Overview: where allocation goes, by package/file and by function. Bounded in size. */
export async function queryAlloc(file: string, opts: OutOpts): Promise<void> {
  const by = opts.by ?? "package";
  if (!GROUPINGS.has(by)) throw new Error(`--by must be one of: package, file, function`);
  const model = await loadAllocModel(file);
  const topN = opts.top != null ? opts.top : DEFAULT_TOP;
  const byPackage = packageAllocRollup(model);
  const byFile = fileAllocRollup(model);
  const hot = model.functions.slice(0, topN);
  const droppedFrames = model.functions.slice(topN);
  const dropped = {
    frames: droppedFrames.length,
    selfBytes: droppedFrames.reduce((sum, fn) => sum + fn.selfBytes, 0),
  };

  const fmt = structuredFormat(opts);
  if (fmt) {
    const overview: AllocOverview = {
      profile: model.profile,
      totalBytes: model.totalBytes,
      sampleCount: model.sampleCount,
      sampling: model.sampling,
      byPackage,
      byFile,
      hot,
      dropped,
      hints: [
        "Group differently: wpd query alloc latest --by file",
        "Open the raw profile in Chrome DevTools > Memory (load the .heapprofile)",
      ],
    };
    return emit(overview, fmt);
  }

  const iterations = model.meta.iterations;
  const windowNote =
    iterations > 1
      ? `sampled, summed over the whole window across ${iterations} iterations (divide by ${iterations} for a per-iteration figure)`
      : "sampled, summed over the whole window";
  const hostCpu = model.meta.hostCpuIndex != null ? ` · host-cpu ${model.meta.hostCpuIndex}` : "";
  console.log(
    `Allocation sampling: ${bold(fmtBytes(model.totalBytes))} allocated ${dim(`(${windowNote}) · ${model.sampleCount} samples @ ${fmtBytes(model.sampling.samplingIntervalBytes)} interval · GC-inclusive${hostCpu}`)}`,
  );
  if (by !== "function") {
    const grouping = by === "file" ? byFile : byPackage;
    console.log(`\nBy ${by} (allocated bytes):\n`);
    console.log(
      table(
        HEAD([by, "bytes", "share", "fns"]),
        grouping
          .slice(0, 15)
          .map((entry) => [
            by === "file" ? tailPath(entry.key, 3) : entry.key,
            fmtBytes(entry.selfBytes),
            heat(entry.selfPct, `${num(entry.selfPct, 1)}%`),
            dim(String(entry.functions)),
          ]),
      ),
    );
  }
  console.log(`\nTop allocating functions (by self bytes):\n`);
  console.log(
    table(
      HEAD(["id", "bytes", "share", "package", "function (source)"]),
      hot.map((fn) => [
        dim(String(fn.id)),
        fmtBytes(fn.selfBytes),
        heat(fn.selfPct, `${num(fn.selfPct, 1)}%`),
        cyan(fn.package),
        `${fn.fn}${fn.file ? ` ${dim(`(${shortSource(fn.file, fn.source)})`)}` : ""}`,
      ]),
    ),
  );
  if (dropped.frames)
    console.log(
      dim(
        `\n${dropped.frames} more function(s) below the top ${topN}, totaling ${fmtBytes(dropped.selfBytes)}.`,
      ),
    );
  console.log(dim(`\n${ALLOC_TRUST}`));
}
