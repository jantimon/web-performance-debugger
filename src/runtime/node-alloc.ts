import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector";
import { buildAllocModel, type RawHeapProfile } from "../profile/allocprofile.js";
import type { AllocSamplingConfig } from "../model/alloc.js";
import { attachTeardownFailure } from "../model/teardown.js";
import { buildSummary, NO_RENDERING_CAPTURE } from "../metrics/summarize.js";
import { buildRecordingSpans } from "../record/spans-build.js";
import { writePointer } from "../commands/resolve.js";
import { writeFileAtomic } from "../model/atomic-write.js";
import { serialize, extFor } from "../output/format.js";
import type { AllocModel } from "../model/alloc.js";
import type { Recording, RecordingMeta } from "../model/recording.js";
import { RUN_MEASURE } from "../model/marks.js";
import { nodeAllocRuntime } from "../record/notes.js";
import type { RecordOptions } from "../record/options.js";
import { VERSION, TOOL } from "../version.js";
import { SCHEMA_VERSION } from "../schema.js";
import { stableWorkloadPath } from "../model/compat.js";
import { measureHostCpuIndex } from "../model/host-cpu.js";

/**
 * The V8 heap sampler config for `--alloc`, fixed (not tunable in v1).
 *
 * [measured, Node 24.13] The GC-inclusion flags are MANDATORY, not optional. The default sampler is
 * LIVE-ONLY: with both flags off it reads 0 MB for pure churn (short-lived garbage a GC already
 * reclaimed), the wrong signal for "which dependency allocates during renderToString". Turning BOTH
 * `includeObjectsCollectedByMajorGC` and `includeObjectsCollectedByMinorGC` on recovers the full
 * 58 MB churn. The 32 KB interval is fixed too: the per-package split is interval-INDEPENDENT
 * (identical at 512 KB and 32 KB, spread 4.3pp -> 0.6pp), so the exact value does not move the answer;
 * 32 KB lands enough samples for per-function resolution while keeping the sampling overhead ~10%.
 * Never drop the flags without re-measuring (docs/dev/allocation-profiling.md)
 */
const ALLOC_SAMPLING: AllocSamplingConfig = {
  samplingIntervalBytes: 32 * 1024,
  includeMajorGC: true,
  includeMinorGC: true,
};

/** Promise wrapper around an inspector Session's callback-style post() */
function heapSession() {
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
 * The `--alloc` node lane: import the module IN THIS PROCESS and run its `run()` under V8's heap
 * SAMPLING profiler (`HeapProfiler.startSampling`), attributing allocated bytes to source/package.
 * This is a DEDICATED capture mode with the CPU sampler OFF, so CPU self-time / a CpuModel are
 * NOT-MEASURED here (absent, never a perturbed-but-disclosed number): [measured] the heap sampler at
 * 32 KB inflates co-riding CPU self-time +11.3%, so wpd refuses to fuse the two
 */
export async function recordAllocNode(opts: RecordOptions): Promise<{
  recording: Recording;
  outPath: string;
  allocProfilePath: string;
  allocModelPath: string;
  allocModel: AllocModel;
}> {
  const root = process.cwd();
  if (!opts.module) throw new Error("--alloc needs a module to import and profile.");
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
    const alsoTried = opts.fn && opts.fn !== "run" ? ` (no \`${opts.fn}\` export either)` : "";
    throw new Error(
      `${absModule} exports no \`run\` function${alsoTried}. Export \`run\` (or a default function): export async function run(ctx) { ... }`,
    );
  }
  const prepare = pick("prepare", "setup", "beforeAll");
  const cleanup = pick("cleanup", "teardown", "afterAll");

  const lifecycle: string[] = [];
  if (prepare) lifecycle.push("prepare");
  lifecycle.push("run");
  if (cleanup) lifecycle.push("cleanup");

  const ctx: Record<string, unknown> = {};

  // Price the host CPU before the sampled loop, so it prices the HOST and never rides the window
  const hostCpuIndex = measureHostCpuIndex();

  // prepare + warmup run BEFORE sampling starts, so their allocation does not land in the profile
  if (prepare) await prepare(ctx);
  for (let iteration = 0; iteration < opts.warmup; iteration++) await run(ctx);

  const { session, post } = heapSession();
  await post("HeapProfiler.enable");
  await post("HeapProfiler.startSampling", {
    samplingInterval: ALLOC_SAMPLING.samplingIntervalBytes,
    includeObjectsCollectedByMajorGC: ALLOC_SAMPLING.includeMajorGC,
    includeObjectsCollectedByMinorGC: ALLOC_SAMPLING.includeMinorGC,
  });

  // The per-iteration wall under allocation sampling: honest as "time under allocation sampling"
  // (systematic overhead ~+10% at 32 KB), comparable alloc-vs-alloc, never a bare benchmark wall
  const perIteration: number[] = [];
  let rawProfile: RawHeapProfile | undefined;
  let runError: unknown;
  let runFailed = false;
  try {
    for (let iteration = 0; iteration < opts.iterations; iteration++) {
      const startedAt = performance.now();
      await run(ctx);
      perIteration.push(performance.now() - startedAt);
    }
  } catch (error) {
    runFailed = true;
    runError = error;
  }
  // Teardown after the run, whether it succeeded or threw: stop sampling, drop the session, run the
  // user's cleanup so external resources are released
  const stopped = await post("HeapProfiler.stopSampling").catch(() => undefined);
  rawProfile = stopped?.profile as RawHeapProfile | undefined;
  await post("HeapProfiler.disable").catch(() => {});
  try {
    session.disconnect();
    if (cleanup) await cleanup(ctx);
  } catch (teardownError) {
    if (runFailed) attachTeardownFailure(runError, teardownError);
    else throw teardownError;
  }
  if (runFailed) throw runError;
  if (!rawProfile) throw new Error("HeapProfiler.stopSampling returned no profile");

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
    hostCpuIndex,
    userDataDir: null,
    lifecycle,
    capture: "node-alloc",
    /**
     * The resolved framework-addon mode, so `off` is distinguishable from an `auto` run that detected
     * nothing. A core fact; always stamped
     */
    framework: opts.framework ?? "auto",
    notes: [nodeAllocRuntime()],
  };

  const allocProfilePath = path.join(outDir, `${base}.heapprofile`);
  await writeFileAtomic(allocProfilePath, JSON.stringify(rawProfile));
  const allocModel = await buildAllocModel(rawProfile, {
    profilePath: allocProfilePath,
    meta,
    sampling: ALLOC_SAMPLING,
    root,
    runtime: "node",
  });
  const allocModelPath = path.join(outDir, `${base}.alloc${extFor(opts.format)}`);
  await writeFileAtomic(allocModelPath, serialize(allocModel, opts.format));

  const summary = buildSummary({
    perIteration,
    wallMs,
    inpMs: null,
    detailEvents: [],
    detailWindowStart: null,
    /** No DOM and no CPU sampler: every rendering count AND jsSelfMs is not-measured (null), never 0 */
    capabilities: NO_RENDERING_CAPTURE,
    jsSelfMs: null,
  });
  meta.totalEvents = summary.totalEvents;
  const recording: Recording = {
    meta,
    window: { measure: RUN_MEASURE, startTs: null, endTs: null, wallMs },
    marks: [],
    events: [],
    /**
     * One run span; no reconciling bar (allocation has no ms-tiled window), so query spans reports it
     * barless. The allocation attribution lives on the sibling AllocModel, read by `query alloc`
     */
    spans: buildRecordingSpans({
      summary,
      detailEvents: [],
      capabilities: NO_RENDERING_CAPTURE,
      bars: [],
      runWindowEnd: null,
    }),
  };
  await writeFileAtomic(outPath, serialize(recording, opts.format));

  await writePointer({
    recording: outPath,
    allocProfile: allocProfilePath,
    allocModel: allocModelPath,
  });

  return { recording, outPath, allocProfilePath, allocModelPath, allocModel };
}
