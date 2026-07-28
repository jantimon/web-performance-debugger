import type { BlameSemantic } from "./attribution.js";
import type { SourceMapDiagnostics } from "./sourcemap-meta.js";

/**
 * Which way the run executed the flow:
 *   - "driver": a module drove the page via Puppeteer (measureStep).
 *   - "bench": a module was import()'d inside the browser (--bench).
 *   - "builtin-load": no module; the built-in on-ramp navigated a host page and settled.
 *   - "node": the module ran in-process (--target node), CPU only.
 */
export type WorkloadLane = "driver" | "bench" | "builtin-load" | "node";

/**
 * The executed flow's identity, kept SEPARATE from `target` (a single display string that a host
 * page overwrites with itself, dropping the module). Two recordings share a workload only when all
 * three axes match: the same lane ran the same module against the same host. A different module (or
 * the built-in load flow) against the same host is a DIFFERENT workload, so a `diff`/`cpu-diff` gate
 * across it refuses instead of subtracting two programs.
 */
export interface WorkloadIdentity {
  lane: WorkloadLane;
  /** the host page a module drove or the on-ramp loaded: a URL, a root-relative HTML path, or null
   * (blank page / node lane). */
  host: string | null;
  /** the executed module, root-relative (stableWorkloadPath), or null on the built-in load flow. */
  module: string | null;
}

export interface RecordingMeta {
  tool: string;
  /** the package version that wrote this artifact (e.g. "0.1.0") */
  version: string;
  /** on-disk schema epoch (major-only); see SCHEMA_VERSION. Makes artifacts self-describing. */
  schemaVersion: string;
  createdAt: string;
  mode: "module" | "html" | "url";
  target: string;
  /**
   * The executed flow's structured identity (lane + host + module), so a diff distinguishes two
   * different programs run against the same host page, which `target` alone cannot. Absent on
   * recordings written before this field: a pair that both lack it falls back to the `target`
   * comparison; a structured-vs-absent pair cannot verify the flow and warns rather than blocking.
   */
  workload?: WorkloadIdentity;
  /**
   * Opt-in variant label (`--variant <label>`), for when ONE module path runs several techniques
   * switched by an env var so `workload` reads them as the same flow. A diff/cpu-diff gate refuses
   * across differing (or present-vs-absent) variants. Absent by default, so old recordings and runs
   * without the flag stay valid and compare as before.
   */
  variant?: string;
  fn: string;
  iterations: number;
  warmup: number;
  headless: boolean;
  /** Headless frame-cadence axis, stamped when a chrome run is headless. Current runs always stamp
   * "new" (Chrome's built-in headless, ~60Hz); "shell" only appears on an older recording (~120Hz).
   * Absent => headed, or firefox/node. Frame cadence sets the wall/INP floor, so a diff across it is
   * not comparable (docs/dev/frame-floor.md), which is why the axis is retained. */
  headlessMode?: "shell" | "new";
  /** CPU sampler interval (microseconds) this run requested. Absent on older recordings. */
  cpuIntervalUs?: number;
  /**
   * Host-CPU speed scalar (higher = faster host), measured in the node process before the capture by
   * a fixed dependency-free microbenchmark (model/host-cpu.ts). CPU self-time ms are host-relative:
   * across machines they embed the hardware gap, so a `diff`/`cpu-diff` between two recordings whose
   * indices differ materially is warned as host-scaled, not a code delta. Stamped on all lanes; absent
   * on older recordings. wpd does NOT normalize self-time by it -- it is a fact beside the numbers and
   * a comparability gate axis, nothing more (docs/dev/cpu-profiling.md). */
  hostCpuIndex?: number;
  /** persistent Chrome profile reused across passes/runs (shorter of relative|absolute), or null */
  userDataDir: string | null;
  /** lifecycle hooks found and called */
  lifecycle: string[];
  /**
   * The one capture that ran, by capture-mode name: "default" (sampler only) | "breakdown" | "deep" |
   * "gecko" (firefox) | "node-cpu" (plus "precise-wall" on retired recordings). Every invocation is
   * exactly one pass (one browser launch, one run of the flow), so this is a single-element array
   * naming the capture mode, not a multi-pass plan.
   */
  passes: string[];
  notes: string[];
  /**
   * Sourcemap resolution for this run: how many scripts a map was attempted for, how many
   * resolved, and why the rest did not. Absent on runs that attempted none, and on older
   * recordings. When resolution fails, CPU self-time is attributed to
   * minified bundle names rather than the originating package, so this is the field that says
   * whether `query cpu --by package` can be trusted.
   */
  sourcemaps?: SourceMapDiagnostics;
  /** driver (puppeteer) mode: run executed in Node with { page, ctx, measureStep } */
  driver: boolean;
  /** browser backend: "chrome" (default, CDP) or "firefox" (BiDi + Gecko profiler). Absent => chrome. */
  browser?: "chrome" | "firefox";
  /**
   * Which code this run's forced-layout blame names (see BlameSemantic): "flush-site" (the read),
   * comparable at line granularity across both engines. Absent => the run produced no blame
   * (--target node, or a chrome capture mode without a .stack trace).
   */
  blameSemantic?: BlameSemantic;
  /** execution runtime: "chrome" (Puppeteer page) or "node" (in-process V8, CPU only) */
  runtime?: "chrome" | "node";
  /**
   * The renderer main thread the trace-derived counts and the reconciling bar were scoped to, and how
   * it was chosen (see trace/main-thread.ts). `split` is the load-bearing signal: true when the run's
   * rendering landed on MORE than one renderer process one after another (successive cross-process
   * navigations), so the selected thread holds only part of it and the counts are known-INCOMPLETE.
   * `assert`/`diff --fail-on-regression` refuse count and count-derived thresholds when it is set,
   * the same honest-refusal the Measured contract makes for a not-measured count. Absent on non-counting
   * captures (the sampler-only default mode, firefox) and on recordings written before this field. */
  mainThread?: { via: "marker" | "reanchored" | "heuristic"; split: boolean };
  /**
   * The trace buffer overran and Chrome dropped events (`trace: true`). Trace-derived counts then
   * UNDERCOUNT, so they are known-incomplete: `assert`/`diff --fail-on-regression` refuse count and
   * count-derived thresholds, and `meta.notes` carries the loud disclosure. Absent when no loss
   * occurred and on recordings written before this field. */
  dataLoss?: { trace: boolean };
  /** artificial slowdown applied during the run */
  throttle?: { cpuRate?: number };
  /** when this recording is one step of a stepped run */
  step?: { index: number; label: string };
}
