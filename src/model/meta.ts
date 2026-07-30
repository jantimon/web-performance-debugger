import type { BlameSemantic } from "./attribution.js";
import type { SourceMapDiagnostics } from "./sourcemap-meta.js";
import type { Measured } from "./measured.js";
import type { EngineVersion } from "./engine-version.js";
import type { CaptureMode } from "../record/capture.js";
import type { FrameworkMode } from "./addon.js";

/**
 * The `--target` engine lane a recording was produced on, the axis the query views tag their spans
 * with. Derived from `meta.browser` + the workload lane (model/spans.ts `recordingLane`), NOT from
 * `meta.target` (which holds the recorded module/url/html path, a display string). Distinct from
 * `WorkloadLane`: two chrome lanes (driver/bench/builtin-load) share the one "chrome" target.
 */
export type TargetLane = "chrome" | "firefox" | "node";

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

/**
 * A recording's meta. It carries NO `kind` discriminant: the sibling run-group manifest (`GroupMeta`)
 * stamps `kind: "run-group"` to mark itself, so a reader tells the two artifact kinds apart at the same
 * schema epoch by the presence of that field (absent here = a plain recording).
 */
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
   * "gecko" | "gecko-deep" (firefox) | "node-cpu" | "node-alloc" (the --alloc heap-sampling lane; CPU
   * not measured). Every invocation is exactly one pass (one browser launch, one run of the flow), so
   * this is a scalar naming the capture mode, not a multi-pass plan.
   */
  capture: CaptureMode;
  /**
   * The resolved framework-addon mode this run selected (`--framework off|auto`, default `auto`), so a
   * consumer distinguishes a deliberate `off` from an `auto` run that detected no framework (both carry
   * no `Span.addons`). A core fact, not addon output: it records the choice regardless of whether
   * any addon contributed. Display-only (no gate branches on it), so optional per the gate-field
   * invariant. Absent only on recordings written before this field. See model/addon.ts.
   */
  framework?: FrameworkMode;
  /** JS self-time from the sibling CpuModel (`CpuModel.jsSelfMs`), cached here so a reader gets the
   * headline without opening the model; `Measured`, null/absent on `--deep` (sampler off, no model) and
   * `--alloc`. NOT the non-idle sampled total: gc/engine/native are excluded. */
  jsSelfMs?: Measured<number>;
  /** count of classified trace events in the run window, a diagnostic: 0 fires the empty-run hint and
   * shows beside the JS-self line. Absent on lanes that capture no trace (node). */
  totalEvents?: number;
  notes: string[];
  /**
   * Sourcemap resolution for this run: how many scripts a map was attempted for, how many
   * resolved, and why the rest did not. Absent on runs that attempted none, and on older
   * recordings. When resolution fails, CPU self-time is attributed to
   * minified bundle names rather than the originating package, so this is the field that says
   * whether `query cpu --by package` can be trusted.
   */
  sourcemaps?: SourceMapDiagnostics;
  /** browser backend: "chrome" (default, CDP) or "firefox" (BiDi + Gecko profiler). Absent => chrome. */
  browser?: "chrome" | "firefox";
  /**
   * The engine build this run measured on: the resolved browser version (chrome `browser.version()`,
   * firefox over BiDi) or, on the node lane, `process.version`. Carries the raw string plus the parsed
   * major milestone. The comparability gate WARNS (never blocks) on a milestone difference: exact
   * counts and the frame floor survive a browser bump, but directional numbers (renderTime, stall
   * rate) can shift with the engine. Absent on recordings written before this field. See
   * model/engine-version.ts and the browser-version axis in model/compat.ts.
   */
  browserVersion?: EngineVersion;
  /**
   * Bot-challenge detection verdict, stamped ONLY when detection fired AND `--allow-bot-wall` let the
   * run measure the challenge page anyway (a refusal throws before any recording is written, so a
   * refused run never reaches here). A machine-readable copy of the loud note, so a consumer reads the
   * verdict without parsing prose. Absent on every clean run. Display-only (no gate branches on it), so
   * optional per the gate-field invariant (docs/dev/rendering-counts.md). See record/bot-wall.ts.
   */
  botWall?: {
    detected: boolean;
    /** the evidence strings that fired (BotWallVerdict.firedSignals) */
    signals: string[];
    /** challenge vendor origins observed, as "host (Vendor)"; empty when the challenge was same-origin */
    vendorOrigins: string[];
    /** the proof screenshot path, when one was saved beside the recording */
    screenshot?: string;
    /** always true here: the field exists only on a detected-but-measured run */
    measuredAnyway: boolean;
  };
  /**
   * Which code this run's forced-layout blame names (see BlameSemantic): "flush-site" (the read),
   * comparable at line granularity across both engines. Absent => the run produced no blame
   * (--target node, or a chrome capture mode without a .stack trace).
   */
  blameSemantic?: BlameSemantic;
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

/**
 * Did this run drive the page via Puppeteer (`measureStep`)? Derived from the workload lane rather
 * than a stored flag: "driver" (a module drove the page) and "builtin-load" (the zero-authoring
 * on-ramp navigated a host page) are both driver mode; "bench" and "node" are not.
 */
export function isDriverRecording(meta: Pick<RecordingMeta, "workload">): boolean {
  const lane = meta.workload?.lane;
  return lane === "driver" || lane === "builtin-load";
}

/** The execution runtime: "node" (in-process V8, CPU only) or "chrome" (a Puppeteer page, the default
 * for every browser lane). Derived from the workload lane: only the node lane runs in-process. */
export function recordingRuntime(meta: Pick<RecordingMeta, "workload">): "chrome" | "node" {
  return meta.workload?.lane === "node" ? "node" : "chrome";
}
