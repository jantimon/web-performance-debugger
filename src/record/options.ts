import type { BrowserName } from "../browser/backend.js";
import type { Format } from "../output/format.js";

export interface RecordOptions {
  /** the user's driver/bench/node module; omitted for the built-in on-ramp flow (--url/--html only) */
  module?: string;
  fn: string;
  /** browser backend: "chrome" (default, full CDP) or "firefox" (BiDi + Gecko profiler) */
  browser?: BrowserName;
  html?: string;
  url?: string;
  /** --url named a host with no scheme, so http:// was assumed for `url`; a note discloses it. */
  urlSchemeAssumed?: boolean;
  iterations: number;
  warmup: number;
  out?: string;
  headless: boolean;
  /** persistent Chrome profile dir (resolved absolute); reuse one login across passes/runs */
  userDataDir?: string;
  /** chrome only: launch with --no-sandbox (reduced containment). Off by default; opt in only in a
   * trusted, isolated environment. */
  disableSandbox?: boolean;
  /** ms to wait after run() for async paints to flush; internal default 200 (no user flag) */
  settleMs: number;
  format: Format;
  /** driver (puppeteer) mode: run executes in Node and receives { page, ctx } */
  driver: boolean;
  /** keep the iterations that completed when a later iteration fails, with a loud note (driver mode) */
  keepPartial?: boolean;
  /** artificial slowdown: CPU throttling multiplier (e.g. 4 = 4x slower) */
  cpuThrottle?: number;
  /** capture a CPU sampling profile (writes .cpuprofile + .cpu model); on by default, off on --deep
   * (the sampler cannot ride a `.stack` trace) and --precise-wall. */
  cpuProfile?: boolean;
  /** CPU sampler interval in microseconds (default DEFAULT_CPU_INTERVAL_US); internal, no user flag */
  cpuIntervalUs?: number;
  /** execution runtime: "chrome" (default, Puppeteer page) or "node" (in-process V8, CPU only) */
  runtime?: "chrome" | "node";
  /** CDP protocol timeout (ms); raise above the 180s default for heavy traced interactions */
  protocolTimeoutMs?: number;
  /**
   * The --breakdown capture mode (chrome only): a light trace (no `.stack`, no invalidationTracking)
   * fused with the CPU sampler in ONE pass, producing a reconciling js/style/layout/paint/gc/other/idle
   * bar per span. Cannot report forced-layout counts or blame (they need `.stack`).
   */
  breakdown?: boolean;
  /**
   * The --deep capture mode (chrome only): ONE full-trace pass (`.stack` + invalidationTracking) with
   * the sampler OFF. The attribution report -- exact forced-layout blame, invalidation rollup, exact
   * counts -- with slice durations suppressed (the `.stack` trace distorts them). No CPU model, no bar.
   */
  deep?: boolean;
  /** The default capture mode minus the sampler: a pristine benchmark wall, no profiler, no counts. */
  preciseWall?: boolean;
  /** Opt-in variant label stamped on meta, so a diff/cpu-diff gate refuses across two techniques
   * that run through one module path (env-switched). Absent by default. */
  variant?: string;
  /** Append this recording to a named run-group manifest (`--group <name>`), so a two-question flow
   * (e.g. --breakdown AND --deep) records as siblings under one manifest. The join refuses an
   * incompatible member (see model/group.ts). Absent for a plain single recording. */
  group?: string;
  /** The full set of capture modes a `--members` run asked for, set by the runner on every member so
   * each append derives partial status structurally. Internal (no CLI flag); absent for a plain
   * single `--group` record, which is complete-by-construction. */
  groupRequested?: string[];
}
