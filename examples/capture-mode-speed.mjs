// Capture-mode speed probe: measures the wall-time overhead each capture mode adds over a
// NO-MEASUREMENT baseline (plain browser, no trace, no sampler, no gecko profiler), on one mixed
// JS + layout/style workload, on both engines. Backs the Speed column in the README's
// "One capture per run: the capture modes" table and the full results table in
// docs/dev/cpu-profiling.md.
//
// Method: one page-clock window (performance.now inside the page) times the SAME workload in every
// cell, so node-side dispatch and the trace start/stop calls stay outside the timed window; the
// number is how much the active instrumentation slows the page's own execution. Cells are
// interleaved across rounds (rotated order per round) so thermal drift spreads across modes rather
// than biasing one. A fresh browser launches per cell per round, because Firefox's profiler is a
// launch-time startup feature (no per-iteration start/stop) and a clean process avoids cross-mode
// carryover. Chrome instrumentation matches src/record/capture.ts verbatim: default = the CDP
// sampler at the 200us default interval; --breakdown = a light trace (breakdownTraceCategories,
// carrying the v8.cpu_profiler sample stream, NO CDP profiler); --deep = the full .stack +
// invalidationTracking trace, sampler off; --precise-wall = nothing beyond the baseline (its whole
// point is a pristine wall), so it reads within noise of it. Firefox is one gecko pass in every
// mode, so gecko and gecko-deep share one capture and one overhead; --breakdown/--precise-wall do
// not exist there.
//
// Requires a build first (imports the real category/trace helpers from dist/):
//   npm run build
//   node examples/capture-mode-speed.mjs                 # full run (medians the README/docs cite)
//   WPD_SPEED_ROUNDS=2 WPD_SPEED_ITERATIONS=8 node examples/capture-mode-speed.mjs   # quick check
//   WPD_SPEED_ENGINES=chrome node examples/capture-mode-speed.mjs   # skip Firefox

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const { startTrace, stopTrace } = await import(join(dist, "trace/tracing.js"));
const { traceCategories, breakdownTraceCategories } = await import(
  join(dist, "trace/categories.js")
);

const ROUNDS = Number(process.env.WPD_SPEED_ROUNDS ?? 8);
const ITERATIONS = Number(process.env.WPD_SPEED_ITERATIONS ?? 20);
const WARMUP = Number(process.env.WPD_SPEED_WARMUP ?? 4);
const ENGINES = (process.env.WPD_SPEED_ENGINES ?? "chrome,firefox").split(",");
const CPU_INTERVAL_US = 200; // DEFAULT_CPU_INTERVAL_US (src/profile/cpuprofile.ts)
const GECKO_ENTRIES = 16_000_000; // GECKO_PROFILER_ENTRIES (src/browser/launch.ts)

/**
 * The measured workload, run and timed INSIDE the page. Deterministic MIXED mid-size work sized so
 * the JS loop and the layout/style thrash cost about the same (~7 ms each, ~14 ms total): a fixed
 * integer loop (pure JS) plus a read-after-write thrash over 25 boxes (forced synchronous layout +
 * style invalidation), so --deep's `.stack` + invalidationTracking overhead is visible (a pure-JS
 * loop would read ~0 there) without letting a layout-dominated window inflate the trace cost past
 * what a real interaction pays. DOM setup is idempotent and excluded from the timed window. Returns
 * the page-clock elapsed ms.
 */
function workload() {
  let host = document.getElementById("wpd-probe-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "wpd-probe-host";
    let markup = "";
    for (let boxIndex = 0; boxIndex < 25; boxIndex++) {
      markup +=
        '<div class="wpd-probe-box" style="width:100px;height:40px;border:2px solid #333;' +
        'padding:2px;position:relative;overflow:scroll">' +
        '<div style="width:300px;height:300px"></div></div>';
    }
    host.innerHTML = markup;
    document.body.appendChild(host);
  }
  const boxes = host.querySelectorAll(".wpd-probe-box");
  const start = performance.now();
  let accumulator = 0;
  for (let index = 0; index < 900000; index++) accumulator = (accumulator * 31 + index) | 0;
  let sink = 0;
  for (let round = 0; round < 22; round++) {
    for (const box of boxes) {
      box.style.width = 100 + (round % 50) + "px";
      box.style.paddingLeft = (round % 7) + "px";
      sink += box.offsetWidth;
      sink += box.getBoundingClientRect().height;
    }
  }
  return { elapsedMs: performance.now() - start, checksum: (accumulator + sink) | 0 };
}

/** Run WARMUP + ITERATIONS timed evaluations of the workload with `mode`'s instrumentation active. */
async function runCell(engine, mode) {
  const launch =
    engine === "firefox"
      ? { browser: "firefox", headless: true, env: geckoEnvFor(mode) }
      : { headless: "shell" };
  const browser = await puppeteer.launch(launch);
  const samples = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const client = engine === "firefox" ? null : await page.createCDPSession();
    for (let index = 0; index < WARMUP; index++) await page.evaluate(workload);
    await startInstrumentation(client, mode);
    for (let index = 0; index < ITERATIONS; index++) {
      const result = await page.evaluate(workload);
      samples.push(result.elapsedMs);
    }
    await stopInstrumentation(client, mode);
  } finally {
    await browser.close();
  }
  return samples;
}

// One temp dir for every Gecko shutdown dump, removed at the end. Firefox writes a large dump
// (16M-entry ring buffer, 16MB+) on each close; a full run makes one per gecko cell per round, so
// they must not accumulate.
const geckoDumpDir = mkdtempSync(join(tmpdir(), "wpd-speed-"));
let geckoDumpCount = 0;

/** Firefox: the gecko modes launch under the Gecko startup profiler (matches geckoEnv in
 * src/browser/launch.ts); the baseline launches plain. Chrome ignores this. */
function geckoEnvFor(mode) {
  if (mode !== "gecko" && mode !== "gecko-deep") return process.env;
  return {
    ...process.env,
    MOZ_PROFILER_STARTUP: "1",
    MOZ_PROFILER_SHUTDOWN: join(geckoDumpDir, `gecko-${geckoDumpCount++}.json`),
    MOZ_PROFILER_STARTUP_FEATURES: "js,cpu",
    MOZ_PROFILER_STARTUP_INTERVAL: "1",
    MOZ_PROFILER_STARTUP_ENTRIES: String(GECKO_ENTRIES),
  };
}

async function startInstrumentation(client, mode) {
  if (mode === "default") {
    await client.send("Profiler.enable");
    await client.send("Profiler.setSamplingInterval", { interval: CPU_INTERVAL_US });
    await client.send("Profiler.start");
  } else if (mode === "breakdown") {
    await startTrace(client, breakdownTraceCategories());
  } else if (mode === "deep") {
    await startTrace(client, traceCategories({ invalidationTracking: true }));
  }
}

async function stopInstrumentation(client, mode) {
  if (mode === "default") await client.send("Profiler.stop");
  else if (mode === "breakdown" || mode === "deep") await stopTrace(client);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const CELLS = [];
if (ENGINES.includes("chrome")) {
  for (const mode of ["baseline", "default", "breakdown", "deep", "precise-wall"])
    CELLS.push({ engine: "chrome", mode });
}
if (ENGINES.includes("firefox")) {
  for (const mode of ["baseline", "gecko", "gecko-deep"]) CELLS.push({ engine: "firefox", mode });
}

const collected = new Map(CELLS.map((cell) => [`${cell.engine}:${cell.mode}`, []]));
// An engine whose browser is not installed (Chrome ships with `npm install`, Firefox needs
// `npx puppeteer browsers install firefox`) self-skips on its first launch failure, like the repo's
// firefox e2e does, so the run still reports every engine that IS present rather than crashing.
const skippedEngines = new Set();

try {
  for (let round = 0; round < ROUNDS; round++) {
    // Rotate cell order each round so drift/thermal effects do not bias one mode.
    const order = CELLS.map((_, index) => CELLS[(index + round) % CELLS.length]);
    for (const cell of order) {
      if (skippedEngines.has(cell.engine)) continue;
      try {
        const samples = await runCell(cell.engine, cell.mode);
        collected.get(`${cell.engine}:${cell.mode}`).push(...samples);
        process.stderr.write(
          `round ${round + 1}/${ROUNDS} ${cell.engine}:${cell.mode} median ${median(samples).toFixed(2)}ms\n`,
        );
      } catch (error) {
        // First failure for an engine (usually "browser not installed") skips the whole engine so a
        // partial run still reports; a mid-run failure for an already-measured engine is logged but
        // its collected samples are kept.
        const collectedSoFar = collected.get(`${cell.engine}:${cell.mode}`).length;
        if (collectedSoFar === 0) skippedEngines.add(cell.engine);
        // A thrown value is not guaranteed to be an Error, so coerce before reading a message: the
        // self-skip must survive a non-Error throw rather than crash inside its own handler.
        const reason = String(error instanceof Error ? error.message : error).split("\n")[0];
        process.stderr.write(`SKIP ${cell.engine}:${cell.mode} (round ${round + 1}): ${reason}\n`);
      }
    }
  }
} finally {
  rmSync(geckoDumpDir, { recursive: true, force: true });
}

function report(engine) {
  const baseline = median(collected.get(`${engine}:baseline`) ?? []);
  if (!baseline) return;
  console.log(
    `\n=== ${engine} (baseline median ${baseline.toFixed(2)} ms, ` +
      `${ROUNDS} rounds x ${ITERATIONS} iterations) ===`,
  );
  console.log("mode".padEnd(14), "median", "  min", "  max", " spread%", "  delta vs baseline");
  for (const cell of CELLS.filter((entry) => entry.engine === engine)) {
    const samples = collected.get(`${engine}:${cell.mode}`);
    if (samples.length === 0) {
      // A mode that failed every round after its engine's baseline succeeded collected nothing;
      // median/min/max would read NaN/Infinity, so report it as n/a rather than printing garbage.
      console.log(cell.mode.padEnd(14), "n/a");
      continue;
    }
    const med = median(samples);
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const spreadPct = ((max - min) / med) * 100;
    const deltaPct = ((med - baseline) / baseline) * 100;
    console.log(
      cell.mode.padEnd(14),
      med.toFixed(2).padStart(6),
      min.toFixed(2).padStart(5),
      max.toFixed(2).padStart(5),
      `${spreadPct.toFixed(0)}%`.padStart(7),
      `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`.padStart(9),
    );
  }
}

for (const engine of ENGINES) {
  if (skippedEngines.has(engine)) {
    console.log(`\n=== ${engine} skipped (browser not installed) ===`);
    continue;
  }
  report(engine);
}
