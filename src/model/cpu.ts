import type { RecordingMeta } from "./meta.js";
import type { SiteRelation } from "./site-relation.js";

/** One function aggregated across a CPU sampling profile (self/total time). */
export interface CpuFunction {
  /** stable id = rank by self time; used by `query frame <id>` */
  id: number;
  fn: string;
  /** resolved original "file:line" when a sourcemap was available */
  source?: string;
  /** bare resolved file path (no line), for the by-file rollup */
  file?: string;
  /**
   * Owning npm/workspace package, e.g. "react-dom", "next-yak", "app". Parenthesized buckets are
   * not real packages: "(native)"/"(node)"/"(blob)"/"(inline)"/"(wasm)", and "(<host>)" for a
   * remote script whose sourcemap did not resolve (its owner is genuinely unknown; see
   * RecordingMeta.sourcemaps). "app" means code that IS the profiled app: a resolved source
   * outside node_modules.
   */
  package: string;
  /** the minified V8 name, when `fn` is the sourcemap-resolved original (else absent) */
  minified?: string;
  selfMs: number;
  selfPct: number;
  totalMs: number;
}

/** Self time grouped by some key (package or file). */
export interface CpuGroupStat {
  key: string;
  selfMs: number;
  selfPct: number;
  functions: number;
  /**
   * URL-mechanical site relation of an ORIGIN-bucket key (`(cdn.example.com)`) to the measured page:
   * same-origin | same-site | cross-site, via the public-suffix list. Present only on origin buckets
   * of a `--url` run (a real page URL to compare against); absent on real packages, non-origin buckets,
   * and non-`--url` runs. It is `site relation`, a fact -- NEVER an ownership or "third-party" claim (a
   * cross-site CDN can be first-party-owned). See model/site-relation.ts.
   */
  siteRelation?: SiteRelation;
}

/** A call-graph edge: time the callee's subtree spent directly under the caller. */
export interface CpuEdge {
  caller: number;
  callee: number;
  ms: number;
}

/** Sampled time outside user JS: idle (no JS on stack), GC, and V8 program/runtime. */
export interface CpuSystem {
  idleMs: number;
  gcMs: number;
  programMs: number;
}

/** One slice of the CPU-time breakdown. */
export interface CpuSlice {
  ms: number;
}

/** The `js` slice, subdivided by owning package (same buckets as packageRollup). */
export interface CpuJsSlice extends CpuSlice {
  /** self ms per owning package; sums to `ms` */
  byPackage: Record<string, number>;
}

/**
 * A reconciling decomposition of the CPU profile's own sampled window into where time went.
 *
 * Built from the raw profile's `samples[]` + `timeDeltas[]`: every time delta is attributed to its
 * sample's node, and each node classifies into exactly one slice, so
 * `js + browser + gc + idle === wallMs` EXACTLY in memory, with zero residual. On disk the numbers
 * are rounded to 4 decimals by serialize, so a persisted slice sum can differ from `wallMs` by up to
 * ~1e-3 ms; that rounding dust is not a residual. `wallMs` is the sum of the profile's own time
 * deltas (not an external wall), which is also `CpuModel.totalMs`. That exact tiling is the product
 * promise; it is not a proportional allocation.
 *
 * Honesty constraints, both from docs/dev:
 *  - On browser lanes the `js` slice is NOT pure JS: synchronous engine work JS triggered (a forced
 *    layout) is billed to the forcing frame (~85% of the layout probe's "JS" self-time is reflow).
 *    Only `--target node` measures pure JS. The report annotates this on browser lanes.
 *  - `browser` is engine/runtime work with the profiled JS not on the stack ((program)/(root) plus
 *    the tool's own harness frames), left UNSPLIT: no invented style/layout/paint numbers, which
 *    would require fusing the trace onto this timeline.
 *
 * On chrome/node this carries `js · browser · gc · idle`, all from V8's synthetic frames. On
 * Firefox (js,cpu) it additionally splits `style` and `layout` out of the engine work, from the
 * per-sample Layout-category frame, and idle is the per-sample CPU-usage signal (`threadCPUDelta`),
 * not a category. Absent on a Firefox dump with no CPU signal (a fabricated idle is worse than
 * none) and on older `.cpu.json` files. Optional throughout, so a reader that predates the field or
 * the style/layout slices keeps working.
 */
export interface CpuBreakdown {
  /** sum of the profile's time deltas, ms; equals CpuModel.totalMs */
  wallMs: number;
  slices: {
    js: CpuJsSlice;
    /** style recalc (Firefox: Layout-category style frames). Absent on chrome/node. */
    style?: CpuSlice;
    /** layout/reflow (Firefox: Layout-category reflow frames). Absent on chrome/node. */
    layout?: CpuSlice;
    /**
     * (program)/(root) + tool harness frames on chrome/node; on Firefox also DOM-accessor time and
     * Profiler self-overhead. Engine/runtime work with the profiled JS not on the stack, unsplit.
     */
    browser: CpuSlice;
    gc: CpuSlice;
    idle: CpuSlice;
  };
  /** wallMs - Σ slices; present only when a node's owner resolved to null so its time landed in no
   * slice (the tiling did not close within float dust). Absent/0 in the normal case. */
  residualMs?: number;
}

/**
 * Resolved, self-contained model of a CPU sampling profile. Sized by function count
 * (not sample count), already sourcemap-resolved, so `query cpu` / `query frame` /
 * `cpu-diff` read it post-hoc without the ephemeral capture server. The raw
 * `.cpuprofile` is written alongside for humans (DevTools / Speedscope).
 */
export interface CpuModel {
  /** path to the raw .cpuprofile */
  profile: string;
  meta: RecordingMeta;
  sampleCount: number;
  sampleIntervalUs: number;
  /** wall span of the sampled window, ms */
  totalMs: number;
  /**
   * JS self-time, ms: the sum over rankable user functions -- the SAME set `packageRollup`/`fileRollup`
   * tile, so their percentages reconcile to 100% against it. This is the CPU headline and the axis
   * `cpu-diff --fail-on-regression` gates. On the browser lanes it folds in the synchronous engine work
   * JS triggered (a forced layout bills to the forcing frame; ~85% of the layout probe's JS self-time is
   * reflow); only `--target node` measures pure JS. Excludes gc, engine/(program), idle, and tool frames.
   */
  jsSelfMs: number;
  /**
   * Non-idle sampled total, ms (`js + gc + engine/native`, i.e. everything sampled that was not idle).
   * Informational and honestly named: it is NOT JS self-time, so a per-package share must never
   * denominate on it. `jsSelfMs` is the headline; `breakdown` splits this into its slices.
   */
  activeMs: number;
  system: CpuSystem;
  /**
   * Reconciling decomposition of the sampled window (the slices tile it exactly): `js · browser ·
   * gc · idle` on chrome/node, `js · style · layout · browser · gc · idle` on Firefox (js,cpu).
   * Absent on a Firefox dump with no `threadCPUDelta` signal (idle would be fabricated) and on
   * older models. Additive: readers that predate it are unaffected.
   */
  breakdown?: CpuBreakdown;
  /** functions sorted by self time descending; id is the index */
  functions: CpuFunction[];
  /** caller->callee edges (thresholded), for callers/callees drilling */
  edges: CpuEdge[];
  /**
   * How many distinct frames could not be attributed to an owner and fell back to an origin
   * bucket (`(cdn.example.com)`). This is what a failed sourcemap actually costs you, and the
   * only honest trigger for "the package rollup cannot be believed". 0 means every frame found
   * its owner -- including when no sourcemap resolved at all, which is the normal case for plain
   * unbundled source that needs no map. Optional: an older model may not carry it.
   */
  unmappedFrames?: number;
}
