import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector";
import {
  buildCpuModel,
  DEFAULT_CPU_INTERVAL_US,
  windowCumulativeCpuProfile,
  type RawCpuProfile,
} from "../profile/cpuprofile.js";
import { usToMs, msToUs } from "../model/time.js";
import { buildSummary, NO_RENDERING_CAPTURE } from "../metrics/summarize.js";
import { buildRecordingSpans } from "../record/spans-build.js";
import { writePointer } from "../commands/resolve.js";
import { writeFileAtomic } from "../model/atomic-write.js";
import { serialize, extFor } from "../output/format.js";
import type { CpuModel, Recording, RecordingMeta } from "../model/recording.js";
import { RUN_MEASURE } from "../model/marks.js";
import { nodeRuntime } from "../record/notes.js";
import type { RecordOptions } from "../commands/record.js";
import { VERSION, TOOL } from "../version.js";
import { SCHEMA_VERSION } from "../schema.js";
import { stableWorkloadPath } from "../model/compat.js";

/** Promise wrapper around an inspector Session's callback-style post(). */
function profilerSession() {
  const session = new Session();
  session.connect();
  const post = (method: string, params?: Record<string, unknown>): Promise<any> =>
    new Promise((resolve, reject) =>
      session.post(method, params as any, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
  return { session, post };
}

/**
 * Node runtime for the CPU bench lane (--target node): import the module IN THIS PROCESS
 * and run its `run()` under the V8 sampling profiler (node's built-in `inspector`, which
 * returns the same .cpuprofile shape as CDP). Pure-JS only: no DOM, no layout/paint, so the
 * output is a CPU model (+ a CPU-only recording) and nothing else. The profiler is started
 * right before the timed loop and stopped right after, so only run() and its callees are
 * sampled; the orchestration frames in this file are dropped via isToolFrameUrl.
 */
export async function recordNode(opts: RecordOptions): Promise<{
  recording: Recording;
  outPath: string;
  cpuProfilePath: string;
  cpuModelPath: string;
  cpuModel: CpuModel;
}> {
  const root = process.cwd();
  // --target node always has a module (the CLI rejects a bare `record --target node`); the built-in
  // on-ramp is driver-only, so there is nothing to synthesize here.
  if (!opts.module) throw new Error("--target node needs a module to import and profile.");
  const absModule = path.resolve(opts.module);
  await fs.access(absModule).catch(() => {
    throw new Error(`Module not found: ${absModule}`);
  });

  const mod: any = await import(pathToFileURL(absModule).href);
  const pick = (...names: string[]) => {
    for (const name of names) {
      if (typeof mod[name] === "function") return mod[name] as (...args: any[]) => any;
    }
    return undefined;
  };
  const run = pick(opts.fn, "run") ?? (typeof mod.default === "function" ? mod.default : undefined);
  if (!run) {
    throw new Error(`Module has no '${opts.fn}' / 'run' export and no callable default export.`);
  }
  const prepare = pick("prepare", "setup", "beforeAll");
  const cleanup = pick("cleanup", "teardown", "afterAll");

  const lifecycle: string[] = [];
  if (prepare) lifecycle.push("prepare");
  lifecycle.push("run");
  if (cleanup) lifecycle.push("cleanup");

  const intervalUs = opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US;
  const ctx: Record<string, unknown> = {};

  // prepare + warmup run BEFORE the profiler starts, so they don't pollute the samples.
  if (prepare) await prepare(ctx);
  for (let iteration = 0; iteration < opts.warmup; iteration++) await run(ctx);

  const { session, post } = profilerSession();
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: intervalUs });
  // The profiler's own clock (profile.startTime/endTime, microseconds) shares node's monotonic tick
  // source with performance.now, offset by a stable constant. Read performance.now right before
  // Profiler.start: the profiler stamps startTime at the beginning of that call, so this pins the
  // offset (profile-clock minus perf.now) to under ~0.1 ms. The loop bounds below become the explicit
  // application window the profile is clipped to, dropping the sampler-startup prefix.
  const nowBeforeProfilerStartMs = performance.now();
  await post("Profiler.start");

  const perIteration: number[] = [];
  // The timed loop's own bounds on the perf.now clock: windowStart is the first run()'s start,
  // windowEnd the last run()'s end. The ~9-30 ms the profiler spends warming up before the first
  // run() falls BEFORE windowStart, so clipping to this window bills that prefix to no frame.
  let windowStartNowMs: number | null = null;
  let windowEndNowMs = 0;
  let rawProfile: RawCpuProfile | undefined;
  try {
    for (let iteration = 0; iteration < opts.iterations; iteration++) {
      const startedAt = performance.now();
      if (windowStartNowMs == null) windowStartNowMs = startedAt;
      await run(ctx);
      const finishedAt = performance.now();
      windowEndNowMs = finishedAt;
      perIteration.push(finishedAt - startedAt);
    }
  } finally {
    // Best-effort teardown even if run() threw: stop the profiler, drop the inspector session,
    // and run the user's cleanup so external resources (temp dirs, servers) are released.
    const stopped = await post("Profiler.stop").catch(() => undefined);
    rawProfile = stopped?.profile as RawCpuProfile | undefined;
    session.disconnect();
    if (cleanup) await cleanup(ctx);
  }
  if (!rawProfile) throw new Error("Profiler.stop returned no profile");

  // Clip the profile to the timed loop's window on the profiler's own clock. The clock offset is the
  // gap between the profiler's startTime (captured at the start of Profiler.start) and the perf.now
  // read taken immediately before it; adding it converts the loop bounds into the profile clock. Skip
  // when no run() executed (iterations 0), leaving the raw profile untouched.
  if (windowStartNowMs != null) {
    const clockOffsetMs = usToMs(rawProfile.startTime) - nowBeforeProfilerStartMs;
    const windowStartUs = msToUs(windowStartNowMs + clockOffsetMs);
    const windowEndUs = msToUs(windowEndNowMs + clockOffsetMs);
    rawProfile = windowCumulativeCpuProfile(rawProfile, windowStartUs, windowEndUs);
  }

  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.resolve(
        "recordings",
        `${new Date().toISOString().replace(/[:.]/g, "-")}${extFor(opts.format)}`,
      );
  const outDir = path.dirname(outPath);
  const base = path.basename(outPath, path.extname(outPath));
  await fs.mkdir(outDir, { recursive: true });

  const wallMs = perIteration.length ? perIteration.reduce((sum, value) => sum + value, 0) : null;

  const meta: RecordingMeta = {
    tool: TOOL,
    version: VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    mode: "module",
    target: stableWorkloadPath(root, opts.module),
    workload: { lane: "node", host: null, module: stableWorkloadPath(root, opts.module) },
    variant: opts.variant,
    fn: opts.fn,
    iterations: opts.iterations,
    warmup: opts.warmup,
    headless: true,
    cpuIntervalUs: intervalUs,
    userDataDir: null,
    lifecycle,
    passes: ["node-cpu"],
    notes: [nodeRuntime()],
    driver: false,
    runtime: "node",
  };

  const cpuProfilePath = path.join(outDir, `${base}.cpuprofile`);
  await writeFileAtomic(cpuProfilePath, JSON.stringify(rawProfile));
  const cpuModel = await buildCpuModel(rawProfile, {
    profilePath: cpuProfilePath,
    meta,
    sampleIntervalUs: intervalUs,
    root,
    runtime: "node",
  });
  const cpuModelPath = path.join(outDir, `${base}.cpu${extFor(opts.format)}`);
  await writeFileAtomic(cpuModelPath, serialize(cpuModel, opts.format));

  const summary = buildSummary({
    perIteration,
    wallMs,
    inpMs: null,
    detailEvents: [],
    detailWindowStart: null,
    // No DOM: every rendering count is not-measured (NO_RENDERING_CAPTURE default). jsSelfMs is
    // the in-process V8 profile's JS self-time.
    jsSelfMs: cpuModel.jsSelfMs,
  });
  const recording: Recording = {
    meta,
    window: { measure: RUN_MEASURE, startTs: null, endTs: null, wallMs },
    marks: [],
    events: [],
    summary,
    // One run span; its reconciling bar lives on CpuModel.breakdown (js/native/gc/idle), which
    // `query spans` synthesizes the run entry from, so no bar is stored on the span itself.
    spans: buildRecordingSpans({
      summary,
      detailEvents: [],
      capabilities: NO_RENDERING_CAPTURE,
      bars: [],
      runWindowEnd: null,
    }),
  };
  await writeFileAtomic(outPath, serialize(recording, opts.format));

  // A plain node record owns `latest`; a --group record defers the pointer to recordAndReport, which
  // writes it ONLY AFTER the manifest join is accepted (a refused join leaves `latest` on the prior
  // group, never downgraded to this orphan recording).
  if (!opts.group)
    await writePointer({
      recording: outPath,
      cpuProfile: cpuProfilePath,
      cpuModel: cpuModelPath,
    });

  return { recording, outPath, cpuProfilePath, cpuModelPath, cpuModel };
}
