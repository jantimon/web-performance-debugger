import type { RecordingMeta, WorkloadIdentity } from "./recording.js";
import { recordingRuntime } from "./meta.js";

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

/** The one capture mode this recording captured. */
function captureModeOf(meta: RecordingMeta): string {
  return meta.capture;
}

/** Headless frame cadence, which sets the wall/INP floor: "headed" | "new" (chrome built-in headless,
 * ~60Hz) | "shell" (an older ~120Hz recording). Differing values refuse a gate, so an old shell
 * recording never diffs against a new-headless one as if the floor were the same. See
 * docs/dev/frame-floor.md. */
function headlessFlavour(meta: RecordingMeta): string {
  if (meta.headless === false) return "headed";
  return meta.headlessMode ?? "shell";
}

function throttleOf(meta: RecordingMeta): string {
  return meta.throttle?.cpuRate ? `${meta.throttle.cpuRate}x` : "off";
}

/**
 * Widest common OS ephemeral-port range. Linux `listen(0)` starts at 32768 (default 32768-60999),
 * macOS/BSD/Windows at 49152. Anchoring at 32768 (not the 49152 dynamic/private start) covers Linux's
 * default too; anchoring higher would keep the port for the low ~58% of Linux-assigned ports. A
 * loopback host on such a port picks one fresh every run (a `listen(0)` bench/test server), so it
 * carries no cross-run identity. Shared by `stableWorkloadHost` here and `unmappedOriginBucket`
 * (cpuprofile.ts) for the same reason: an ephemeral port must not split a cross-run identity or a
 * cpu-diff join. Trade: a deliberate service on a 32768-49151 port loses its port; accepted for the
 * same reason the range exists.
 */
export const EPHEMERAL_PORT_MIN = 32768;
export const EPHEMERAL_PORT_MAX = 65535;

/** A loopback host literal (127.0.0.0/8, ::1, localhost), by hostname or IP. The narrow set the
 * ephemeral-port fold applies to: a real service on :8080 vs :9090 can be a genuinely different
 * deployment, so only loopback hosts drop their port. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  // A full dotted-quad in 127.0.0.0/8, anchored so a DNS name like "127.0.x.example.com" (or any
  // host with a non-numeric label) is not read as loopback. Node normalizes short forms (127.1) to
  // the quad before this sees them.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
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
  // URL.hostname already carries the brackets for an IPv6 literal (`[::1]`), so use it verbatim.
  return `${parsed.protocol}//${parsed.hostname}:<ephemeral>${parsed.pathname}${parsed.search}${parsed.hash}`;
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
 * Two host-CPU indices more than 25% apart (a ratio of the larger to the smaller) read as
 * different-class hosts. The within-host measurement noise is ~2-3% [measured, docs/dev/cpu-profiling.md];
 * 25% clears that and normal thermal drift by a wide margin while a genuinely faster/slower machine
 * (M-series vs a shared CI runner differ several-fold) trips it.
 */
const HOST_CPU_RATIO_THRESHOLD = 0.25;

/**
 * The host-CPU axis: were the two recordings measured on materially different hardware?
 *
 * CPU self-time ms are host-relative (a faster CPU runs the same code in fewer ms), so a self-time
 * delta between two hosts is mostly the hosts. When both sides carry a `hostCpuIndex` and they differ
 * beyond HOST_CPU_RATIO_THRESHOLD, surface a WARNING axis naming both indices. When one side lacks it
 * (an older recording, or one written before this field), the sameness cannot be verified, so warn
 * too, under the same axis. Both-absent, or both present and within threshold, returns null (silent).
 *
 * Non-blocking, unlike `cpu-throttle`. The blocking axes are things wpd DID to the capture (an
 * artificial slowdown, an iteration count, a warmup boundary) -- provably config, deterministic, and
 * fully wpd's doing. The host index is an ENVIRONMENTAL observation with its own few-% noise: blocking
 * on it would refuse a legitimate same-machine gate whenever a laptop thermally drifts between two
 * runs. So it advises loudly (self-time is host-scaled here), the same tier as `sampler-interval`,
 * and leaves the gate to the caller.
 */
function hostCpuMismatch(base: RecordingMeta, current: RecordingMeta): CompatMismatch | null {
  const baseIndex = base.hostCpuIndex;
  const currentIndex = current.hostCpuIndex;
  if (baseIndex == null && currentIndex == null) return null;
  const label = (index: number | undefined): string =>
    index == null ? "unmeasured" : String(index);
  if (baseIndex == null || currentIndex == null)
    return {
      axis: "host-cpu",
      base: label(baseIndex),
      current: label(currentIndex),
      blocksGating: false,
    };
  const larger = Math.max(baseIndex, currentIndex);
  const smaller = Math.min(baseIndex, currentIndex);
  if (smaller <= 0 || larger / smaller - 1 <= HOST_CPU_RATIO_THRESHOLD) return null;
  return {
    axis: "host-cpu",
    base: String(baseIndex),
    current: String(currentIndex),
    blocksGating: false,
  };
}

/**
 * The browser/engine-version axis: did the two recordings run on different engine milestones?
 *
 * Exact counts and the frame floor survive a Chrome/Firefox/node bump, but directional numbers
 * (renderTime, stall rate, slice ms) can shift with the engine. So a milestone difference WARNS,
 * never blocks -- like host-cpu, it is an environmental observation, not a config wpd applied. Fires
 * only on a MILESTONE difference (a patch/build bump within one milestone is not comparability
 * -relevant); when a milestone is missing on one side (older recording, unparsed format) it falls back
 * to a raw-string comparison so the reader still sees the two builds. Both-absent returns null (silent).
 */
function browserVersionMismatch(
  base: RecordingMeta,
  current: RecordingMeta,
): CompatMismatch | null {
  const baseVersion = base.browserVersion;
  const currentVersion = current.browserVersion;
  if (baseVersion == null && currentVersion == null) return null;
  const label = (version: RecordingMeta["browserVersion"]): string =>
    version == null
      ? "unmeasured"
      : version.milestone != null
        ? String(version.milestone)
        : version.raw;
  if (baseVersion == null || currentVersion == null)
    return {
      axis: "browser-version",
      base: label(baseVersion),
      current: label(currentVersion),
      blocksGating: false,
    };
  if (baseVersion.milestone != null && currentVersion.milestone != null) {
    if (baseVersion.milestone === currentVersion.milestone) return null;
    return {
      axis: "browser-version",
      base: String(baseVersion.milestone),
      current: String(currentVersion.milestone),
      blocksGating: false,
    };
  }
  // At least one side carries no parsed milestone: compare the raw strings so a difference is still surfaced.
  if (baseVersion.raw === currentVersion.raw) return null;
  return {
    axis: "browser-version",
    base: baseVersion.raw,
    current: currentVersion.raw,
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
 *   - browser/runtime/capture-mode: a different count source entirely (Gecko markers vs trace, a
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
 * Three axes only WARN. The sampler interval moves sampling density and steady-state, not the gated
 * exact counts. The host-CPU index (hostCpuMismatch) flags that the two ran on materially different
 * hardware, so a self-time delta is host-scaled. The browser version (browserVersionMismatch) flags an
 * engine-milestone difference, past which directional numbers can shift while exact counts survive.
 * All three are advisory: environmental observations, not a config wpd applied.
 */
export function comparabilityMismatches(
  base: RecordingMeta,
  current: RecordingMeta,
): CompatMismatch[] {
  const hostCpu = hostCpuMismatch(base, current);
  const browserVersion = browserVersionMismatch(base, current);
  const axes: CompatMismatch[] = [
    {
      axis: "browser",
      base: base.browser ?? "chrome",
      current: current.browser ?? "chrome",
      blocksGating: true,
    },
    {
      axis: "runtime",
      base: recordingRuntime(base),
      current: recordingRuntime(current),
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
    // Beyond-threshold or one-side-unmeasured only; within-threshold (and both-absent) is silent, so
    // it is a maybe-entry rather than a fixed axis the final base!==current filter would keep.
    ...(hostCpu ? [hostCpu] : []),
    // Milestone difference only (or one-side-unmeasured); same-milestone and both-absent are silent.
    ...(browserVersion ? [browserVersion] : []),
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
