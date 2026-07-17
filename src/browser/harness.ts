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
 *   - "timed"   runs the measured iterations, wrapped in wpd:* marks. May itself be called
 *               twice (see `offset`): once for the first iteration, once for the rest, so the
 *               caller can close the CDP counter bracket in between.
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
  /**
   * Index this call's first iteration gets in its `wpd:iter:N` marks. The timed phase is split
   * so the CDP counters can bracket the first iteration alone (counts must not scale with
   * --iterations), and the counters are read from Node, so closing that bracket means returning
   * from page.evaluate mid-loop. The offset keeps iteration numbering contiguous across the
   * two calls. Defaults to 0, i.e. an unsplit phase.
   */
  offset?: number;
  /** emit wpd:run:start before the loop; false on the second call of a split phase */
  runStart?: boolean;
  /** emit wpd:run:end + measure wpd:run after the loop; false on the first call of a split phase */
  runEnd?: boolean;
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
  const offset = arg.offset ?? 0;
  const perIteration: number[] = [];
  if (arg.runStart !== false) performance.mark("wpd:run:start");
  for (let iteration = 0; iteration < iterations; iteration++) {
    const index = offset + iteration;
    performance.mark(`wpd:iter:${index}:start`);
    const t0 = performance.now();
    await run(ctx);
    const durationMs = performance.now() - t0;
    performance.mark(`wpd:iter:${index}:end`);
    performance.measure(`wpd:iter:${index}`, `wpd:iter:${index}:start`, `wpd:iter:${index}:end`);
    perIteration.push(durationMs);
  }
  if (arg.runEnd !== false) {
    performance.mark("wpd:run:end");
    performance.measure("wpd:run", "wpd:run:start", "wpd:run:end");
  }

  // Force a synchronous layout flush so the run's pending style/layout lands in the trace. Every
  // timed call flushes, not just the last: on a split phase the caller reads the CDP counters as
  // soon as this returns, and unflushed style/layout would land after the bracket closed, i.e. be
  // counted against the wrong iteration (or not at all).
  if (document.body) void document.body.offsetHeight;

  return { perIteration, lifecycle };
}
