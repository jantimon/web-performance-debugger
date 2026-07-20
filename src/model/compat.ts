import type { RecordingMeta, WorkloadIdentity } from "./recording.js";

/**
 * One capture axis that differs between two recordings being compared. `blocksGating` axes make a
 * gate (`diff --fail-on-regression`, `cpu-diff --fail-on-regression`) meaningless: the delta reflects
 * the capture config, not a code change, so gating across one would fabricate a pass/fail.
 */
import path from "node:path";

/**
 * A workload path stabilized for cross-run identity: resolved against the recording root, then
 * relative to it when it lives underneath (the same module recorded from a different cwd or via a
 * different spelling joins instead of spuriously refusing a gate). Paths outside the root stay
 * absolute; URLs never come through here.
 */
export function stableWorkloadPath(root: string, rawPath: string): string {
  const resolved = path.resolve(root, rawPath);
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith("..") ? relative : resolved;
}

export interface CompatMismatch {
  axis: string;
  base: string;
  current: string;
  blocksGating: boolean;
}

/** The one capture mode this recording captured, as a stable string (passes are single-element today,
 * but sort+join keeps an older multi-pass recording comparing deterministically). */
function captureModeOf(meta: RecordingMeta): string {
  return [...(meta.passes ?? [])].sort().join("+");
}

/** Headless frame cadence, which sets the wall/INP floor: "headed" | "shell" (~120Hz) | "new"
 * (~60Hz). See docs/dev/frame-floor.md. */
function headlessFlavour(meta: RecordingMeta): string {
  if (meta.headless === false) return "headed";
  return meta.headlessMode ?? "shell";
}

function throttleOf(meta: RecordingMeta): string {
  return meta.throttle?.cpuRate ? `${meta.throttle.cpuRate}x` : "off";
}

/**
 * Widest common OS ephemeral-port range (the same floor cpuprofile.ts uses for its unmapped-origin
 * bucket, and for the same reason): Linux `listen(0)` starts at 32768, macOS/BSD/Windows at 49152.
 * A dev/test server on a loopback host picks one of these fresh every run, so it carries no cross-run
 * identity and must not read as a different workload.
 */
const EPHEMERAL_PORT_MIN = 32768;
const EPHEMERAL_PORT_MAX = 65535;

/** A loopback host literal (127.0.0.0/8, ::1, localhost), by hostname or IP. The narrow set the
 * ephemeral-port fold applies to: a real service on :8080 vs :9090 can be a genuinely different
 * deployment, so only loopback hosts drop their port. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  return /^127\.\d/.test(host);
}

/**
 * A workload host stabilized for cross-run identity. A loopback host on an OS-assigned ephemeral port
 * (a `listen(0)` bench/test server: 127.0.0.1, localhost, [::1]) gets its port replaced with the
 * literal `<ephemeral>`, so the same page served on a fresh random port each run reads as ONE
 * workload rather than refusing a gate that is actually fine. The token stays IN the canonical so a
 * reader who sees the host understands the port was folded. Non-loopback hosts and registered ports
 * pass through unchanged: those name a service the user runs on purpose. Non-URL hosts (a
 * root-relative HTML path) and null are returned as-is.
 */
function stableWorkloadHost(host: string | null): string | null {
  if (host == null) return host;
  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    return host;
  }
  if (parsed.port === "") return host;
  const port = Number(parsed.port);
  if (port < EPHEMERAL_PORT_MIN || port > EPHEMERAL_PORT_MAX) return host;
  if (!isLoopbackHostname(parsed.hostname)) return host;
  const hostPart = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
  return `${parsed.protocol}//${hostPart}:<ephemeral>${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** One line naming lane + host + module, so two flows differ here whenever any of the three does. A
 * real value is quoted (JSON.stringify), a null one is the bare word `null`, so a host page or module
 * literally named "null" cannot read as absent and collide with a blank-page run. `stableHost` folds
 * an ephemeral loopback port to `<ephemeral>` (identity comparison); the raw form is for disclosure. */
function workloadCanonical(identity: WorkloadIdentity, stableHost = false): string {
  const rawHost = stableHost ? stableWorkloadHost(identity.host) : identity.host;
  const host = rawHost === null ? "null" : JSON.stringify(rawHost);
  const workloadModule = identity.module === null ? "null" : JSON.stringify(identity.module);
  return `${identity.lane} host=${host} module=${workloadModule}`;
}

/**
 * The workload axis: does the same flow run on both sides?
 *
 *   - both carry a structured `workload` -> compare it; a different lane/host/module blocks the gate
 *     (subtracting two programs is not a code delta).
 *   - neither does (both predate the field) -> fall back to the `target` string, as before.
 *   - one does, one does not -> the older side carries no module identity when a host page was
 *     present, so the flow cannot be verified. WARN under a distinct axis name rather than block:
 *     refusing every gate against a pre-upgrade baseline would be heavier than the risk, but the
 *     reader must know the sameness is unverified.
 *
 * Host identity folds an ephemeral loopback port (stableWorkloadHost): the same page served on a
 * fresh `listen(0)` port each run is ONE workload. When that fold makes two otherwise-identical
 * workloads match, the raw hosts (with their differing ports) are surfaced as a NON-blocking note, so
 * a reader sees why the gate did not refuse rather than a silent pass.
 */
function workloadMismatch(base: RecordingMeta, current: RecordingMeta): CompatMismatch {
  if (base.workload && current.workload) {
    const baseStable = workloadCanonical(base.workload, true);
    const currentStable = workloadCanonical(current.workload, true);
    if (baseStable !== currentStable)
      return { axis: "workload", base: baseStable, current: currentStable, blocksGating: true };
    // Same workload once the ephemeral loopback port is folded. Report the RAW hosts so a differing
    // port is visible (base !== current keeps the entry) but does not block; an exact match (raw
    // hosts equal too) collapses to base === current and is filtered out upstream.
    return {
      axis: "workload",
      base: workloadCanonical(base.workload, false),
      current: workloadCanonical(current.workload, false),
      blocksGating: false,
    };
  }
  if (!base.workload && !current.workload)
    return { axis: "workload", base: base.target, current: current.target, blocksGating: true };
  return {
    axis: "workload-identity",
    base: base.workload ? workloadCanonical(base.workload) : `pre-identity(${base.target})`,
    current: current.workload
      ? workloadCanonical(current.workload)
      : `pre-identity(${current.target})`,
    blocksGating: false,
  };
}

/**
 * Which capture axes differ between two recordings, and whether each blocks a regression gate.
 *
 * A diff subtracts fields as if the two captures measured the same thing; they do not when the axis
 * below differs. An axis `blocksGating` when a delta on it is provably the config talking, not the
 * code:
 *
 *   - browser/runtime/capture-mode: different count provenance entirely (Gecko markers vs trace, a
 *     --deep exact count vs a --breakdown null).
 *   - workload: a different lane, host page, or module was recorded (workloadMismatch), so the two
 *     are not the same flow. A mixed pair (one side predates the structured identity) warns under
 *     "workload-identity" instead of blocking, since its sameness cannot be verified either way.
 *   - iterations: run counts TOTAL across iterations (one pass runs every iteration), so iters 1 vs
 *     5 makes every count 5x and manufactures "regressions".
 *   - headless flavour / throttle: the frame cadence and the artificial slowdown both shift the
 *     numbers the gate reads (wall/INP floor; slice and paint cadence).
 *   - warmup: the untimed runs before the timed window carry workload state (cache priming, JIT
 *     tiers, lazy CSS, memoization, first-render code). Moving a call across that boundary changes
 *     which counts land in the timed window, so a first-call layout can read as 0 -> 1 from a
 *     `--warmup` change alone. It is workload state, not sampling noise, so it blocks the gate.
 *   - variant: an opt-in `--variant <label>` the user attaches when ONE module path runs several
 *     techniques switched by an env var, which `workload` cannot tell apart (same lane/host/module).
 *     A different label is a different technique, so gating across it subtracts apples from oranges.
 *     A present label vs an absent one also blocks: the flow the absent side ran cannot be verified
 *     to be the same technique, so it refuses rather than fabricating a pass. Both-absent (the
 *     default, nobody uses variants) matches and never appears here.
 *
 * The sampler interval only WARNS: it moves sampling density and steady-state, not the gated exact
 * counts.
 */
export function comparabilityMismatches(
  base: RecordingMeta,
  current: RecordingMeta,
): CompatMismatch[] {
  const axes: CompatMismatch[] = [
    {
      axis: "browser",
      base: base.browser ?? "chrome",
      current: current.browser ?? "chrome",
      blocksGating: true,
    },
    {
      axis: "runtime",
      base: base.runtime ?? "chrome",
      current: current.runtime ?? "chrome",
      blocksGating: true,
    },
    {
      axis: "capture-mode",
      base: captureModeOf(base),
      current: captureModeOf(current),
      blocksGating: true,
    },
    workloadMismatch(base, current),
    {
      axis: "iterations",
      base: String(base.iterations ?? "?"),
      current: String(current.iterations ?? "?"),
      blocksGating: true,
    },
    {
      axis: "headless",
      base: headlessFlavour(base),
      current: headlessFlavour(current),
      blocksGating: true,
    },
    {
      axis: "cpu-throttle",
      base: throttleOf(base),
      current: throttleOf(current),
      blocksGating: true,
    },
    {
      axis: "warmup",
      base: String(base.warmup ?? "?"),
      current: String(current.warmup ?? "?"),
      blocksGating: true,
    },
    {
      axis: "variant",
      base: base.variant ?? "(none)",
      current: current.variant ?? "(none)",
      blocksGating: true,
    },
    {
      axis: "sampler-interval",
      base: base.cpuIntervalUs != null ? `${base.cpuIntervalUs}us` : "?",
      current: current.cpuIntervalUs != null ? `${current.cpuIntervalUs}us` : "?",
      blocksGating: false,
    },
  ];
  return axes.filter((entry) => entry.base !== entry.current);
}

/** The axes that make a `cpu-diff --fail-on-regression` gate meaningless: a JS self-time delta is
 * config, not code, when they differ. Lane (browser/runtime) and workload change WHAT is sampled;
 * `iterations` and `cpu-throttle` change its SCALE. CPU self-time totals across every sampled
 * iteration (one pass runs them all), so iters 1 vs 4 roughly quadruples the summed ms; CPU
 * throttling stretches the same self-time clock. `warmup` moves the workload's first-call state
 * (JIT tiers, caches, first-render code) into or out of the timed window, so an expensive first call
 * lands in the samples under `--warmup 0` and not under `--warmup 1` though the code is identical.
 * Each fabricates a self-time "regression" from pure config. A differing `variant` is a different
 * technique behind one module path, so a self-time delta across it is not a code change either.
 * Capture mode and headless move rendering counts and the wall/INP floor, not the profiler's own
 * self-time clock, so cpu-diff only WARNS on those. */
export const CPU_DIFF_BLOCKING_AXES = new Set([
  "browser",
  "runtime",
  "workload",
  "iterations",
  "warmup",
  "variant",
  "cpu-throttle",
]);
