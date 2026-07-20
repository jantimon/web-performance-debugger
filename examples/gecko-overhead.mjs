// Gecko-overhead matrix probe. wpd's Firefox gecko capture costs ~150% wall over a plain Firefox
// BiDi launch on a reflow-heavy workload (Chrome's sampler costs ~4-7% on the same work). This
// probe attributes those points. It discriminates:
//   interval-sweep (standing vs per-periodic-sample): 1/4/16/50 ms at fixed features.
//   workload (marker/cause-stack weighting): shipped config on a MIXED reflow workload vs a PURE-JS
//     one with zero layout.
//   thread filter: MOZ_PROFILER_STARTUP_FILTERS=GeckoMain vs unset.
//   ring buffer: ENTRIES 1M vs 16M.
//   feature marginal: js vs js,cpu.
//
// Method mirrors examples/capture-mode-speed.mjs: ONE page-clock window (performance.now INSIDE the
// page) times the SAME workload in every cell, so node-side dispatch stays outside the window; a
// fresh Firefox launches per cell per round (the Gecko profiler is a launch-time startup feature,
// no per-iteration toggle); cells interleave (rotated order) per round so drift spreads. Baseline
// per workload = plain Firefox, no profiler env. Firefox only. Firefox clamps performance.now() to
// 1 ms, so the MEAN over the pooled samples is the small-effect read and the median the robustness
// cross-check. Requires a build first (imports parseGecko from dist/ for the signal-loss check):
//   npm run build
//   node examples/gecko-overhead.mjs
//   WPD_ROUNDS=8 WPD_ITER=20 node examples/gecko-overhead.mjs   # the defaults the docs cite

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
// A file URL, not a raw path, so the dynamic import resolves on Windows too (matches runtime/node.ts).
const { parseGecko } = await import(pathToFileURL(join(dist, "profile/gecko.js")).href);

const ROUNDS = Number(process.env.WPD_ROUNDS ?? 8);
const ITER = Number(process.env.WPD_ITER ?? 20);
const WARMUP = Number(process.env.WPD_WARMUP ?? 4);
const GECKO_ENTRIES = 16_000_000; // GECKO_PROFILER_ENTRIES (src/browser/launch.ts)

// MIXED: ~7 ms integer loop + a read-after-write thrash over 25 boxes (22 rounds => ~550 forced
// reflows). Verbatim from examples/capture-mode-speed.mjs so the two probes share a workload.
function mixedWorkload() {
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

// PURE-JS: integer loop only, ZERO layout/DOM, sized so its window (~14 ms) is comparable to the
// mixed baseline. No reflows => no Reflow/Styles markers and no cause-stack captures, which isolates
// the marker cost from the periodic sampler's own wall cost.
function pureWorkload() {
  const start = performance.now();
  let accumulator = 0;
  for (let index = 0; index < 1_900_000; index++) accumulator = (accumulator * 31 + index) | 0;
  return { elapsedMs: performance.now() - start, checksum: accumulator | 0 };
}

const WORKLOADS = { mixed: mixedWorkload, pure: pureWorkload };

const geckoDumpDir = mkdtempSync(join(tmpdir(), "wpd-gecko-overhead-"));
let dumpCount = 0;
const savedDumps = {}; // cellId -> last dump kept for the signal-loss check

// The gecko env for a cell config; a null config launches plain Firefox (the baseline). Matches
// geckoEnv() in src/browser/launch.ts, adding the FILTERS knob wpd does not set.
function geckoEnv(config) {
  if (!config) {
    // Strip any MOZ_PROFILER_* the caller already has in their environment: a stray one would start
    // the profiler on the baseline and quietly corrupt every delta computed against it.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("MOZ_PROFILER_")) delete env[key];
    return { env, dumpPath: null };
  }
  const dumpPath = join(geckoDumpDir, `dump-${dumpCount++}.json`);
  const env = {
    ...process.env,
    MOZ_PROFILER_STARTUP: "1",
    MOZ_PROFILER_SHUTDOWN: dumpPath,
    MOZ_PROFILER_STARTUP_FEATURES: config.features,
    MOZ_PROFILER_STARTUP_INTERVAL: String(config.interval),
    MOZ_PROFILER_STARTUP_ENTRIES: String(config.entries),
  };
  if (config.filters) env.MOZ_PROFILER_STARTUP_FILTERS = config.filters;
  return { env, dumpPath };
}

async function runCell(cell) {
  const workloadFn = WORKLOADS[cell.workload];
  const { env, dumpPath } = geckoEnv(cell.config);
  const browser = await puppeteer.launch({ browser: "firefox", headless: true, env });
  const samples = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    for (let index = 0; index < WARMUP; index++) await page.evaluate(workloadFn);
    for (let index = 0; index < ITER; index++) {
      const result = await page.evaluate(workloadFn);
      samples.push(result.elapsedMs);
    }
  } finally {
    await browser.close();
  }
  if (dumpPath) {
    try {
      const kept = join(geckoDumpDir, `keep-${cell.id}.json`);
      copyFileSync(dumpPath, kept);
      savedDumps[cell.id] = kept;
    } catch (error) {
      // Log rather than swallow: otherwise the later signal-loss check prints "no dump kept" with no
      // hint why. Fall back to the original dump path so verification can still read it.
      const reason = String(error instanceof Error ? error.message : error).split("\n")[0];
      process.stderr.write(`keep-dump failed for ${cell.id}: ${reason}\n`);
      savedDumps[cell.id] = dumpPath;
    }
  }
  return samples;
}

const shipped = { features: "js,cpu", interval: 1, entries: GECKO_ENTRIES };
const CELLS = [
  { id: "mixed:baseline", workload: "mixed", config: null },
  { id: "mixed:shipped", workload: "mixed", config: { ...shipped } },
  { id: "mixed:int4", workload: "mixed", config: { ...shipped, interval: 4 } },
  { id: "mixed:int16", workload: "mixed", config: { ...shipped, interval: 16 } },
  { id: "mixed:int50", workload: "mixed", config: { ...shipped, interval: 50 } },
  { id: "mixed:filterMain", workload: "mixed", config: { ...shipped, filters: "GeckoMain" } },
  { id: "mixed:ent1M", workload: "mixed", config: { ...shipped, entries: 1_000_000 } },
  { id: "mixed:jsonly", workload: "mixed", config: { ...shipped, features: "js" } },
  { id: "pure:baseline", workload: "pure", config: null },
  { id: "pure:shipped", workload: "pure", config: { ...shipped } },
];

const collected = new Map(CELLS.map((cell) => [cell.id, []]));
let skipped = false;

for (let round = 0; round < ROUNDS && !skipped; round++) {
  const order = CELLS.map((_, index) => CELLS[(index + round) % CELLS.length]);
  for (const cell of order) {
    try {
      const samples = await runCell(cell);
      collected.get(cell.id).push(...samples);
      process.stderr.write(
        `round ${round + 1}/${ROUNDS} ${cell.id} median ${median(samples).toFixed(2)}ms\n`,
      );
    } catch (error) {
      // A thrown value is not guaranteed to be an Error, so coerce before reading a message: the
      // self-skip must survive a non-Error throw rather than crash inside its own handler.
      const reason = String(error instanceof Error ? error.message : error).split("\n")[0];
      process.stderr.write(`SKIP ${cell.id} (round ${round + 1}): ${reason}\n`);
      // Firefox not installed (npx puppeteer browsers install firefox) => bail on the first baseline.
      if (collected.get(cell.id).length === 0 && cell.id.endsWith("baseline")) {
        skipped = true;
        break;
      }
    }
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function stats(id) {
  const values = collected.get(id) ?? [];
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    mean,
    med: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    spreadPct: ((Math.max(...values) - Math.min(...values)) / median(values)) * 100,
    n: values.length,
  };
}

function report() {
  for (const workload of ["mixed", "pure"]) {
    const base = stats(`${workload}:baseline`);
    if (!base) continue;
    console.log(
      `\n=== ${workload} (baseline mean ${base.mean.toFixed(2)}ms / median ${base.med.toFixed(2)}ms, ` +
        `${ROUNDS}x${ITER}=${base.n}) ===`,
    );
    console.log("cell".padEnd(20), "  mean", "median", "spread", "  Δmean", " Δmedian");
    for (const cell of CELLS.filter((entry) => entry.workload === workload)) {
      const stat = stats(cell.id);
      if (!stat) {
        console.log(cell.id.padEnd(20), "n/a");
        continue;
      }
      const fmt = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
      console.log(
        cell.id.padEnd(20),
        stat.mean.toFixed(2).padStart(6),
        stat.med.toFixed(2).padStart(6),
        `${stat.spreadPct.toFixed(0)}%`.padStart(6),
        fmt(((stat.mean - base.mean) / base.mean) * 100).padStart(8),
        fmt(((stat.med - base.med) / base.med) * 100).padStart(8),
      );
    }
  }
}

report();

// Signal-loss check: does the GeckoMain-filtered / small-ring dump still carry everything wpd reads
// off the content main thread (threadCPUDelta for idle, Reflow/Styles markers for counts/blame,
// and a shape parseGecko accepts)?
function verifyDump(id) {
  const path = savedDumps[id];
  if (!path) {
    console.log(`\n[verify] ${id}: no dump kept`);
    return;
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const allThreads = [];
  (function collect(container) {
    for (const thread of container.threads ?? []) allThreads.push(thread);
    for (const child of container.processes ?? []) collect(child);
  })(raw);
  const busiest = allThreads.reduce(
    (best, thread) =>
      (thread.samples?.data?.length ?? 0) > (best.samples?.data?.length ?? 0) ? thread : best,
    allThreads[0],
  );
  const cpuDeltaCol = busiest.samples?.schema?.threadCPUDelta;
  const cpuPopulated =
    cpuDeltaCol != null
      ? busiest.samples.data.filter((row) => row[cpuDeltaCol] != null).length /
        busiest.samples.data.length
      : 0;
  let reflowMarkers = 0;
  for (const thread of allThreads) {
    const nameCol = thread.markers?.schema?.name;
    if (nameCol == null) continue;
    for (const markerRow of thread.markers.data) {
      const markerName = thread.stringTable?.[markerRow[nameCol]];
      if (markerName === "Reflow" || markerName === "Styles") reflowMarkers++;
    }
  }
  let parseOk = "?";
  try {
    parseGecko(raw);
    parseOk = "ok";
  } catch (error) {
    parseOk = `THREW: ${String(error instanceof Error ? error.message : error).split(":")[0]}`;
  }
  const names = [...new Set(allThreads.map((thread) => thread.name))].join(", ");
  console.log(`\n[verify] ${id}: threads=${allThreads.length} [${names}]`);
  console.log(
    `  busiest="${busiest.name}" samples=${busiest.samples?.data?.length} ` +
      `threadCPUDelta=${(cpuPopulated * 100).toFixed(0)}% populated`,
  );
  console.log(
    `  Reflow/Styles markers=${reflowMarkers}  parseGecko=${parseOk}  ` +
      `dump=${(readFileSync(path).length / 1e6).toFixed(1)}MB`,
  );
}

console.log("\n===== dump verification (thread-filter signal-loss check) =====");
verifyDump("mixed:shipped");
verifyDump("mixed:filterMain");
verifyDump("mixed:ent1M");

rmSync(geckoDumpDir, { recursive: true, force: true });
