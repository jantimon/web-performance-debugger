import { isToolFrameUrl } from "../trace/stacks.js";

/** The reconciling breakdown slice a sample's wall-delta lands in (Firefox lane). `idle` comes from
 * the per-sample CPU-usage signal; style/layout/gc/js from the leaf-ward frame category; `other` is
 * DOM-accessor time, Profiler self-overhead, and everything else. Parallel to a converted profile's
 * `samples`, so summing `timeDeltas` by this classification tiles the profile window exactly. */
export type GeckoSlice = "js" | "style" | "layout" | "gc" | "idle" | "other";

/** Raw V8 CPU sampling profile, as returned by CDP `Profiler.stop` (`.profile`). */
export interface RawCpuProfile {
  nodes: RawProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
  /**
   * Firefox (js,cpu) only: per-sample breakdown data the Gecko converter attaches, parallel to
   * `samples`/`timeDeltas`. Absent on chrome/node (their breakdown reads node classification) and on
   * firefox dumps with an empty `threadCPUDelta` column (no honest idle signal, so no breakdown).
   */
  gecko?: { sampleSlices: GeckoSlice[] };
  /**
   * Trace-sourced (--breakdown chrome) only: the absolute trace-clock timestamp (us) of each sample,
   * parallel to `samples`. The profile merges the per-process streams a cross-document navigation
   * splits, so `startTime + Σ timeDeltas` no longer reconstructs a sample's real clock position; the
   * per-span windowing reads these directly. Absent on the CDP/node/gecko single-stream profiles,
   * where the cumulative reconstruction is exact, and stripped before the raw `.cpuprofile` is written
   * (it is not part of the DevTools format).
   */
  sampleTimestampsUs?: number[];
}

export interface RawProfileNode {
  id: number;
  callFrame: RawCallFrame;
  hitCount?: number;
  children?: number[];
}

export interface RawCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  /** 0-based, per CDP convention */
  lineNumber: number;
  /** 0-based, per CDP convention */
  columnNumber: number;
}

/** Pseudo-frames V8 injects that are not user functions; bucketed, not ranked. */
const SYSTEM_FRAMES = new Set(["(idle)", "(program)", "(garbage collector)", "(root)"]);

export function frameKey(callFrame: RawCallFrame): string {
  return [callFrame.functionName, callFrame.url, callFrame.lineNumber, callFrame.columnNumber].join(
    " ",
  );
}

/**
 * A rankable user function, i.e. one that earns an id in `CpuModel.functions[]`. Excludes V8's
 * pseudo-frames ((idle)/(program)/(garbage collector)/(root)) and the tool's own harness frames. The
 * ONE predicate the ranked model and the per-span `functionIdByNode` join both use, so they assign
 * identical ids and a per-span sample cannot land on a phantom function.
 */
export function isRankableFrame(callFrame: RawCallFrame): boolean {
  if (SYSTEM_FRAMES.has(callFrame.functionName) && !callFrame.url) return false;
  return !isToolFrameUrl(callFrame.url);
}

/**
 * The one ranking both CpuModel.functions[] and the per-span hot refs share: rankable frames by
 * self-time descending, key as the tie-break. Function ids ARE positions in this order, so any
 * consumer deriving ids must call this rather than re-sorting.
 */
export function rankedFrameKeys(
  callFrameByKey: Map<string, RawCallFrame>,
  selfUsByKey: Map<string, number>,
): string[] {
  return [...callFrameByKey.keys()]
    .filter((key) => isRankableFrame(callFrameByKey.get(key)!))
    .sort(
      (left, right) =>
        (selfUsByKey.get(right) ?? 0) - (selfUsByKey.get(left) ?? 0) || left.localeCompare(right),
    );
}

/**
 * Owning `CpuModel.functions[]` id per cpuprofile node, for the per-span hot tally. The id is the
 * node's frame rank by self time, computed the SAME way `buildCpuModel` ranks (`isRankableFrame`
 * filter, then self-time descending with a frameKey tiebreak), so a per-span sample joins to the
 * EXACT function `query cpu`/`query frame` show. A node whose frame is not a rankable user function
 * (V8 pseudo-frame, tool harness) has no id: it is absent from the map, never a phantom.
 *
 * Pure over `raw`: the rank depends only on sample self-time and the frame key, not on source
 * resolution, so this needs neither the sourcemap resolver nor the built model. It re-derives
 * self-time per key rather than sharing `buildCpuModel`'s (both are cheap node walks over the same
 * `raw`), so the join stays a standalone function the record-time projection loop can call directly.
 */
export function functionIdByNode(raw: RawCpuProfile): Map<number, number> {
  const selfUsByNode = new Map<number, number>();
  for (let index = 0; index < raw.samples.length; index++) {
    const nodeId = raw.samples[index];
    selfUsByNode.set(
      nodeId,
      (selfUsByNode.get(nodeId) ?? 0) + Math.max(0, raw.timeDeltas[index] ?? 0),
    );
  }
  const selfUsByKey = new Map<string, number>();
  const callFrameByKey = new Map<string, RawCallFrame>();
  for (const node of raw.nodes) {
    const key = frameKey(node.callFrame);
    callFrameByKey.set(key, node.callFrame);
    selfUsByKey.set(key, (selfUsByKey.get(key) ?? 0) + (selfUsByNode.get(node.id) ?? 0));
  }
  const idByKey = new Map<string, number>();
  rankedFrameKeys(callFrameByKey, selfUsByKey).forEach((key, index) => idByKey.set(key, index));
  const byNode = new Map<number, number>();
  for (const node of raw.nodes) {
    const id = idByKey.get(frameKey(node.callFrame));
    if (id != null) byNode.set(node.id, id);
  }
  return byNode;
}
