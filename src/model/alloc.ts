import type { RecordingMeta } from "./meta.js";

/**
 * One function aggregated across a V8 heap SAMPLING profile: the bytes it allocated directly (its own
 * frame, children excluded). The self-time analog of `CpuFunction`, weighed in bytes instead of ms
 */
export interface AllocFunction {
  /** stable id = rank by self bytes; used by the hot list ordering */
  id: number;
  fn: string;
  /** resolved original "file:line" when the frame carried a position */
  source?: string;
  /** bare resolved file path (no line), for the by-file rollup */
  file?: string;
  /**
   * Owning npm/workspace package, e.g. "react-dom", "tailwind-merge", "app". Parenthesized buckets
   * are not real packages: "(node)" (node builtins), "(native)", "(unmapped: ...)". "app" means code
   * that IS the profiled app: a resolved source outside node_modules. Same resolution as `CpuFunction`
   */
  package: string;
  /** the minified V8 name, when `fn` is the sourcemap-resolved original (else absent) */
  minified?: string;
  /** bytes this frame allocated directly (sampled, GC-inclusive) */
  selfBytes: number;
  /** share of `AllocModel.totalBytes`, so the per-package/per-function shares reconcile to 100% */
  selfPct: number;
}

/** Self bytes grouped by some key (package or file) */
export interface AllocGroupStat {
  key: string;
  selfBytes: number;
  selfPct: number;
  functions: number;
}

/**
 * The V8 heap sampler configuration this run recorded under, stored so a reader knows where the
 * numbers come from. Fixed in v1 (not tunable): the byte interval and BOTH GC-inclusion flags are constants,
 * because the default live-only sampler reads 0 bytes for pure churn (the wrong signal); recording the
 * config makes an old artifact self-describing if the constants ever change
 */
export interface AllocSamplingConfig {
  /** `HeapProfiler.startSampling` samplingInterval, bytes (the average bytes between samples) */
  samplingIntervalBytes: number;
  /** `includeObjectsCollectedByMajorGC` was on: objects freed by a major GC are counted */
  includeMajorGC: boolean;
  /** `includeObjectsCollectedByMinorGC` was on: objects freed by a minor GC (scavenge) are counted */
  includeMinorGC: boolean;
}

/**
 * Resolved, self-contained model of a V8 heap sampling profile (`--alloc`, node lane): per-function
 * self bytes rolled up by package/file, already sourcemap-resolved, so `query alloc` reads it post-hoc.
 * The raw `.heapprofile` is written alongside for DevTools (the Memory panel loads it).
 *
 * Parallel to `CpuModel` but on the allocation axis: no CPU self-time, no call-graph edges, no
 * reconciling bar. Allocation attribution is what this model answers -- which dependency allocates
 */
export interface AllocModel {
  /** path to the raw .heapprofile (absolute back-pointer) */
  profile: string;
  meta: RecordingMeta;
  sampling: AllocSamplingConfig;
  /**
   * Total sampled bytes attributed to rankable user frames (the denominator the package/file/function
   * shares reconcile to 100% against). Directional (~10-20%): a sampled estimate of allocation volume,
   * NOT an exact heap total. The per-package SHARES are the trustworthy signal (~5% ratio fidelity)
   */
  totalBytes: number;
  /** how many allocation samples the profile carried */
  sampleCount: number;
  /** functions sorted by self bytes descending; id is the index */
  functions: AllocFunction[];
  /**
   * How many distinct frames could not be attributed to an owner and fell back to an origin bucket.
   * 0 in the normal node-lane case (file:// frames resolve to their path). Optional: an older model
   * may not carry it
   */
  unmappedFrames?: number;
}
