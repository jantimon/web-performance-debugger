/**
 * Runs INSIDE the browser page (serialized by puppeteer's page.evaluate).
 * Must be self-contained: it may only use its argument and browser globals.
 *
 * Lifecycle (benchmarking convention, like benchmark.js / tinybench):
 *   prepare()  -> once, before any timed run        (aliases: setup)
 *   run()      -> the measured function, called `iterations` times  (aliases: default export)
 *   cleanup()  -> once, after all runs               (aliases: teardown)
 *
 * Split into three phases so the measured window is clean:
 *   - "setup"   runs prepare() + warmup BEFORE tracing/CDP snapshots, so neither the
 *               setup DOM work nor warmup iterations inflate the authoritative counts.
 *   - "timed"   runs the measured iterations, wrapped in wpd:* marks.
 *   - "cleanup" runs cleanup() AFTER tracing stops, so teardown work is never counted.
 * ctx is shared across the three page.evaluate calls via a page global; module-level
 * state already persists through the browser's module cache between calls.
 */
export interface HarnessArgs {
  moduleUrl: string;
  fnName: string;
  iterations: number;
  warmup: number;
  phase: "setup" | "timed" | "cleanup";
}

export interface HarnessResult {
  perIteration: number[];
  lifecycle: string[];
}

export async function runHarness(arg: HarnessArgs): Promise<HarnessResult> {
  const { moduleUrl, fnName, iterations, warmup, phase } = arg;
  const mod: any = await import(moduleUrl);

  const pick = (...names: string[]) => {
    for (const name of names) {
      if (typeof mod[name] === "function") return mod[name] as (...args: any[]) => any;
    }
    return undefined;
  };

  const run = pick(fnName, "run") ?? (typeof mod.default === "function" ? mod.default : undefined);
  if (!run) {
    throw new Error(`Module has no '${fnName}' / 'run' export and no callable default export.`);
  }
  const prepare = pick("prepare", "setup", "beforeAll");
  const cleanup = pick("cleanup", "teardown", "afterAll");

  const lifecycle: string[] = [];
  if (prepare) lifecycle.push("prepare");
  lifecycle.push("run");
  if (cleanup) lifecycle.push("cleanup");

  // Shared context object passed to every hook, persisted across phases (page global).
  const store = ((globalThis as any).__cpHarness ??= {});
  const ctx: Record<string, unknown> = (store.ctx ??= {});

  if (phase === "setup") {
    if (prepare) await prepare(ctx);
    // warmup (untimed, excluded from the measured window)
    for (let iteration = 0; iteration < warmup; iteration++) await run(ctx);
    return { perIteration: [], lifecycle };
  }

  if (phase === "cleanup") {
    if (cleanup) await cleanup(ctx);
    return { perIteration: [], lifecycle };
  }

  // phase === "timed"
  const perIteration: number[] = [];
  performance.mark("wpd:run:start");
  for (let iteration = 0; iteration < iterations; iteration++) {
    performance.mark(`wpd:iter:${iteration}:start`);
    const t0 = performance.now();
    await run(ctx);
    const durationMs = performance.now() - t0;
    performance.mark(`wpd:iter:${iteration}:end`);
    performance.measure(
      `wpd:iter:${iteration}`,
      `wpd:iter:${iteration}:start`,
      `wpd:iter:${iteration}:end`,
    );
    perIteration.push(durationMs);
  }
  performance.mark("wpd:run:end");
  performance.measure("wpd:run", "wpd:run:start", "wpd:run:end");

  // Force a synchronous layout flush so the run's pending style/layout lands in the trace.
  if (document.body) void document.body.offsetHeight;

  return { perIteration, lifecycle };
}
