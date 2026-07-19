import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector";
import {
  buildCpuModel,
  DEFAULT_CPU_INTERVAL_US,
  type RawCpuProfile,
} from "../profile/cpuprofile.js";
import { buildSummary, NO_RENDERING_CAPTURE } from "../metrics/summarize.js";
import { buildRecordingSpans } from "../record/spans-build.js";
import { writePointer } from "../commands/resolve.js";
import { serialize, extFor } from "../output/format.js";
import type { CpuModel, Recording, RecordingMeta } from "../model/recording.js";
import { RUN_MEASURE } from "../model/marks.js";
import { nodeRuntime } from "../record/notes.js";
import type { RecordOptions } from "../commands/record.js";
import { VERSION, TOOL } from "../version.js";
import { SCHEMA_VERSION } from "../schema.js";

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
  await post("Profiler.start");

  const perIteration: number[] = [];
  let rawProfile: RawCpuProfile | undefined;
  try {
    for (let iteration = 0; iteration < opts.iterations; iteration++) {
      const startedAt = performance.now();
      await run(ctx);
      perIteration.push(performance.now() - startedAt);
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
    target: opts.module,
    fn: opts.fn,
    iterations: opts.iterations,
    warmup: opts.warmup,
    headless: true,
    userDataDir: null,
    lifecycle,
    passes: ["node-cpu"],
    notes: [nodeRuntime()],
    driver: false,
    runtime: "node",
  };

  const cpuProfilePath = path.join(outDir, `${base}.cpuprofile`);
  await fs.writeFile(cpuProfilePath, JSON.stringify(rawProfile), "utf8");
  const cpuModel = await buildCpuModel(rawProfile, {
    profilePath: cpuProfilePath,
    meta,
    sampleIntervalUs: intervalUs,
    root,
    runtime: "node",
  });
  const cpuModelPath = path.join(outDir, `${base}.cpu${extFor(opts.format)}`);
  await fs.writeFile(cpuModelPath, serialize(cpuModel, opts.format), "utf8");

  const summary = buildSummary({
    perIteration,
    wallMs,
    inpMs: null,
    detailEvents: [],
    detailWindowStart: null,
    // No DOM: every rendering count is not-measured (NO_RENDERING_CAPTURE default). scriptingMs is
    // the in-process V8 profile's JS self-time.
    scriptingMs: cpuModel.scriptingMs,
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
    }),
  };
  await fs.writeFile(outPath, serialize(recording, opts.format), "utf8");

  await writePointer({
    recording: outPath,
    cpuProfile: cpuProfilePath,
    cpuModel: cpuModelPath,
  });

  return { recording, outPath, cpuProfilePath, cpuModelPath, cpuModel };
}
