import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

// True end-to-end: drives the built CLI, which launches real Chrome via Puppeteer, records a
// trace + CPU profile, and resolves work back to source. Skipped automatically when Chrome was
// never downloaded (the unit CI job sets PUPPETEER_SKIP_DOWNLOAD), so `npm test` stays green and
// browser-free there; a dedicated CI job installs Chrome and runs this for real. Set
// WPD_E2E_REQUIRED=1 to turn a missing browser into a hard failure instead of a skip, so that
// job can never silently pass without exercising the browser path.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repoRoot, "dist", "cli.js");
const examples = path.join(repoRoot, "examples");

async function browserAvailable() {
  try {
    // executablePath() is async in puppeteer v25 (it resolves the installed build).
    const executable = await puppeteer.executablePath();
    return typeof executable === "string" && existsSync(executable);
  } catch {
    return false;
  }
}

const ready = await browserAvailable();
if (!ready && process.env.WPD_E2E_REQUIRED) {
  throw new Error("WPD_E2E_REQUIRED is set but no Chrome is installed for Puppeteer.");
}
const e2e = ready ? test : (name, _opts, fn) => test(name, { skip: "Chrome not installed" }, fn ?? _opts);

// Chrome launch + two isolated passes; generous so a slow CI runner does not flake.
const TIMEOUT_MS = 180_000;

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`cli ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
  return result.stdout;
}

// A local HTTP origin for the --url on-ramp, served from a SEPARATE process: the test drives the CLI
// with a blocking spawnSync, which pins this process's event loop, so an in-process http.server could
// never answer the child's request. The child writes its assigned port to a file once listening; we
// poll it with a synchronous Atomics.wait sleep (no event loop needed). No external network: CI serves
// itself.
// `host` binds AND is the returned hostname. Default "127.0.0.1" (an IP is its own isolation site).
// Pass "localhost" to make the navigation from wpd's 127.0.0.1 blank host cross-SITE, which swaps the
// renderer process (127.0.0.1 and localhost are different sites; a mere port change is not): that is
// the cross-process boot the F1 re-anchor exists for. Binding and connecting on the same name avoids
// an IPv4/IPv6 localhost-resolution mismatch.
function startOnrampServer(html, host = "127.0.0.1") {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-srv-"));
  const portFile = path.join(dir, "port");
  const script = `import http from "node:http";
import { writeFileSync } from "node:fs";
const body = ${JSON.stringify(html)};
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
server.listen(0, ${JSON.stringify(host)}, () => writeFileSync(${JSON.stringify(portFile)}, String(server.address().port)));
`;
  const scriptFile = path.join(dir, "server.mjs");
  writeFileSync(scriptFile, script);
  const child = spawn(process.execPath, [scriptFile], { stdio: "ignore" });
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    if (existsSync(portFile)) port = readFileSync(portFile, "utf8").trim() || undefined;
    if (!port) sleep(50);
  }
  if (!port) {
    child.kill();
    throw new Error("on-ramp test server did not start within 5s");
  }
  return { url: `http://${host}:${port}/`, close: () => child.kill() };
}

// A boot that does real, countable rendering work: 200 absolutely-positioned boxes appended with a
// forced synchronous layout read (offsetWidth while dirty) and a per-box background, so the load
// window carries layout + style + paint the counts and bar must report.
const BOOT_WORK_HTML =
  "<!doctype html><meta charset=utf-8><title>boot</title>" +
  "<style>.box{position:absolute;width:40px;height:40px}</style><div id=root></div>" +
  "<script>const root=document.getElementById('root');" +
  "for(let index=0;index<200;index++){const box=document.createElement('div');box.className='box';" +
  "box.style.left=(index*7%800)+'px';box.style.top=(index*11%500)+'px';" +
  "box.style.background='hsl('+(index*9%360)+',70%,50%)';root.appendChild(box);" +
  "box.style.width=(box.offsetWidth>0?41:40)+'px';}<\/script>";

// Forced-layout blame is a --deep (rung 3) product: it needs the `.stack` trace category, which
// only --deep captures (the default rung has no trace; --breakdown drops .stack).
e2e("record --deep + query blame attributes forced layout to the source line", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "forced");
  runCli(["record", path.join(examples, "forces-layout.mjs"), "--bench", "--deep", "--iterations", "3", "--out", out]);
  assert.ok(existsSync(out), "recording file written");

  const blame = JSON.parse(runCli(["query", "blame", out, "--forced", "--json"]));
  assert.ok(Array.isArray(blame) && blame.length > 0, "at least one forced-layout source group");
  const fromExample = blame.filter((row) => row.at?.includes("forces-layout.mjs"));
  assert.ok(fromExample.length > 0, "forced layout attributed to forces-layout.mjs");
  const top = fromExample[0];
  assert.ok(top.forced > 0, "forced count is positive");
  assert.ok(top.kinds.includes("layout"), "kinds include layout");
});

// The signature move: --deep detects layout thrashing (write->read->write->read) over the trace's
// invalidation records, reports the count + interleave, and annotates each forced read with the
// WRITE that dirtied it. examples/forces-layout.mjs is a known thrash: bump() writes inline style
// (line 16), then each geometry property is read on its own line, so every read re-flushes.
e2e("record --deep detects layout thrashing and dual-annotates read + dirtied-by write", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "thrash");
  runCli(["record", path.join(examples, "forces-layout.mjs"), "--bench", "--deep", "--iterations", "1", "--out", out]);

  // The thrash rollup rides the run span's anatomy. N = 3 is the headline threshold; this workload
  // thrashes far over it (measured ~42 steps over ~21 geometry reads).
  const anatomy = JSON.parse(runCli(["query", "span", out, "run", "--json"]));
  assert.ok(anatomy.thrash, "the run span carries a thrash rollup on --deep");
  assert.ok(anatomy.thrash.count >= 3, `thrashCount >= N=3, got ${anatomy.thrash.count}`);
  assert.ok(Array.isArray(anatomy.thrash.steps) && anatomy.thrash.steps.length > 0, "the interleave has steps");
  // The anatomy also carries the forced read-sites, dual-annotated with the dirtied-by write.
  assert.ok(Array.isArray(anatomy.forced) && anatomy.forced.length > 0, "forced read-sites present");

  // The interleave names BOTH ends: a read line and the bump() write line (16).
  const namesRead = anatomy.thrash.steps.some((step) => step.read?.includes("forces-layout.mjs"));
  assert.ok(namesRead, "a thrash step names a geometry read line in forces-layout.mjs");
  const writeLines = anatomy.thrash.steps.flatMap((step) => step.dirtiedBy.map((w) => w.at));
  assert.ok(
    writeLines.some((at) => /forces-layout\.mjs:16\b/.test(at)),
    `a thrash step's dirtied-by names the bump() write line 16, got ${JSON.stringify([...new Set(writeLines)])}`,
  );

  // The dual annotation also hangs on `query blame --forced`: the read stays the headline, the write
  // is attached as dirtiedBy with its Chrome invalidation reason.
  const blame = JSON.parse(runCli(["query", "blame", out, "--forced", "--json"]));
  const annotated = blame.find((row) => row.dirtiedBy?.some((w) => /forces-layout\.mjs:16\b/.test(w.at)));
  assert.ok(annotated, "a forced read-site carries a dirtied-by write");
  const bumpWrite = annotated.dirtiedBy.find((w) => /forces-layout\.mjs:16\b/.test(w.at));
  assert.equal(bumpWrite.reason, "Inline CSS style declaration was mutated", "the write names its mutation reason");
  assert.ok(annotated.at.includes("forces-layout.mjs"), "the read (headline) is a forces-layout.mjs line");
});

// --target node profiles in-process via node's V8 inspector, so it needs no browser and
// runs everywhere (not gated on Chrome).
test("record --target node resolves hot functions to source without a browser", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "nodecpu");
  runCli(["record", path.join(examples, "cpu-busywork.mjs"), "--target", "node", "--iterations", "3", "--out", out]);
  assert.ok(existsSync(`${out}.cpu.json`), "cpu model written");
  assert.ok(existsSync(`${out}.cpuprofile`), "raw cpuprofile written");

  const model = JSON.parse(runCli(["query", "cpu", out, "--json"]));
  assert.ok(model.scriptingMs > 0, "non-zero sampled scripting time");
  const named = model.hot.find(
    (fn) => fn.fn === "hashString" || fn.fn === "buildRows" || fn.fn === "serializeStyle",
  );
  assert.ok(named, "a named busywork function is hot");
  assert.ok(named.source?.includes("cpu-busywork.mjs"), "hot function resolved to its source file");
});

e2e("record resolves hot functions to source", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "cpu");
  runCli(["record", path.join(examples, "cpu-busywork.mjs"), "--bench", "--iterations", "3", "--out", out]);
  assert.ok(existsSync(`${out}.cpu.json`), "cpu model written");
  assert.ok(existsSync(`${out}.cpuprofile`), "raw cpuprofile written");

  // Query by the bare --out path (no extension): exercises the sibling .cpu.json resolution.
  const model = JSON.parse(runCli(["query", "cpu", out, "--json"]));
  assert.ok(model.scriptingMs > 0, "non-zero sampled scripting time");
  assert.ok(model.sampleCount > 0, "profiler collected samples");
  const named = model.hot.find(
    (fn) => fn.fn === "hashString" || fn.fn === "buildRows" || fn.fn === "serializeStyle",
  );
  assert.ok(named, "a named busywork function is hot");
  assert.ok(named.source?.includes("cpu-busywork.mjs"), "hot function resolved to its source file");
});

// The single-axis capture invariant after the one-pass cutover. Every invocation is one pass, so
// counts and wall come from the SAME run. The default rung (sampler only, no trace) measures no
// rendering counts at all -- Measured null, never a fake 0 -- while --deep captures the exact counts
// (with slice durations suppressed, the .stack refusal). Wall is the axis that grows with
// --iterations; the bench wall is exactly the sum of the timed samples.
e2e("the capture ladder: default rung has no counts; --deep has exact counts with suppressed durations", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));

  // Default rung: no trace, so every rendering count is not-measured (null), never 0.
  const dfltOut = path.join(dir, "default");
  runCli(["record", path.join(examples, "forces-layout.mjs"), "--bench", "--iterations", "1", "--out", dfltOut]);
  const dflt = JSON.parse(readFileSync(dfltOut, "utf8")).summary;
  assert.equal(dflt.layoutCount, null, "default rung measures no layout count (—, never 0)");
  assert.equal(dflt.forcedLayoutCount, null, "and no forced count");
  assert.equal(dflt.layoutMs, null, "and no durations");
  assert.ok(dflt.scriptingMs > 0, "but the CPU model still measures JS self-time");

  // --deep: exact counts are the product; slice durations are suppressed (.stack distorts them).
  const readDeep = (iterations) => {
    const out = path.join(dir, `deep-${iterations}`);
    runCli(["record", path.join(examples, "forces-layout.mjs"), "--bench", "--deep", "--iterations", String(iterations), "--out", out]);
    return JSON.parse(readFileSync(out, "utf8")).summary;
  };
  const deep = readDeep(1);
  assert.ok(deep.layoutCount > 0, "--deep counts the forced layouts exactly");
  assert.ok(deep.forcedLayoutCount > 0, "and attributes them as forced");
  assert.ok(deep.styleCount > 0, "and counts style recalcs");
  assert.equal(deep.layoutMs, null, "but slice durations are suppressed on the .stack trace (—, never a distorted number)");
  assert.equal(deep.styleMs, null);

  // Wall is the axis that grows with --iterations: one sample per timed iteration, all real, and the
  // bench wall is EXACTLY their sum (no split, no bracket).
  const many = readDeep(8);
  assert.equal(deep.perIteration.length, 1, "one iteration yields one wall sample");
  assert.equal(many.perIteration.length, 8, "eight iterations yield eight wall samples");
  assert.ok(many.perIteration.every((ms) => ms > 0), "every timed iteration is measured");
  assert.ok(many.stats && many.stats.samples === 8, "stats are computed over all timed iterations");
  const sum = (samples) => samples.reduce((total, ms) => total + ms, 0);
  assert.ok(
    Math.abs(many.wallMs - sum(many.perIteration)) < 0.001,
    "bench wallMs is exactly the sum of the timed samples",
  );
  assert.ok(many.wallMs > deep.wallMs, `wallMs grows with --iterations (${many.wallMs} at 8 vs ${deep.wallMs} at 1)`);
});

// The headline of driver --iterations: a real interaction measured once is a single sample of a
// clock Chrome deliberately clamps, which cannot separate a regression from noise. Measured on
// this flow, the n=1 reading of "first increment" was 87ms while the median over 6 was 40ms with
// a 255ms outlier -- the single sample was not merely imprecise, it was 2x off the typical value.
// Per-step counts window to iteration 0, so they must NOT move with --iterations; only the sample
// count may. Run under --deep, the rung whose full trace carries exact per-step counts.
e2e("driver --deep --iterations repeats the flow: per-step medians, per-step counts don't scale", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  // A committed fixture, not examples/react-counter, whose dist/ is git-ignored and never built in
  // CI: the test would have returned early and reported green without exercising anything. It has
  // to live under the repo because --html is served by a static server rooted at the cwd; the
  // driver module is import()ed in Node, so that one can be written to a temp dir.
  const html = path.join(repoRoot, "test", "fixtures", "driver-probe.html");
  assert.ok(existsSync(html), "driver-probe.html is committed, so this test cannot silently skip");
  const flow = path.join(dir, "flow.mjs");
  writeFileSync(
    flow,
    `export async function prepare({ page }) {
       await page.waitForSelector("#inc");
     }
     export async function run({ page, measureStep }) {
       await measureStep("add rows", () => page.click("#inc"));
     }`,
  );

  const read = (iterations) => {
    const out = path.join(dir, `drv-${iterations}`);
    runCli([
      "record", flow,
      "--html", html, "--deep", "--iterations", String(iterations), "--out", out,
    ]);
    // The collapse: one artifact. Steps are spans of kind "step" on the recording -- there is no
    // separate index file to read.
    const recording = JSON.parse(readFileSync(out, "utf8"));
    return { recording, steps: recording.spans.filter((span) => span.kind === "step") };
  };

  const one = read(1);
  const many = read(5);

  // Every step is re-measured per iteration and keeps its own samples, grouped by label rather
  // than colliding on it (the label is what joins a step across passes).
  const step = many.recording.summary.perStep[0];
  assert.equal(step.perIteration.length, 5, "each step carries one sample per iteration");
  assert.ok(step.stats && step.stats.samples === 5, "and gets real stats, not null");
  assert.equal(one.recording.summary.perStep[0].stats, null, "one sample still yields no statistic");
  assert.equal(
    many.recording.summary.perStep.length,
    one.recording.summary.perStep.length,
    "repeating the flow must not multiply the steps",
  );

  // The headline is the median of the samples, so a cold first iteration cannot define the number.
  const sorted = [...step.perIteration].sort((left, right) => left - right);
  assert.ok(Math.abs(step.stats.medianMs - sorted[2]) < 0.001, "wall headline is the median");

  // Per-step counts are the axis that must hold still: they window to the first timed iteration's
  // trace window, so they never scale with --iterations. Guard non-vacuity first: every equality
  // below would hold at 0 === 0 on a page that did nothing.
  assert.ok(one.steps[0].counts.layoutCount > 0, "the fixture actually causes layout");
  assert.ok(one.steps[0].counts.forcedLayoutCount > 0, "and forces it synchronously");
  assert.equal(
    many.steps[0].counts.layoutCount,
    one.steps[0].counts.layoutCount,
    "per-step layoutCount must not scale with --iterations (windowed to iteration 0)",
  );
  assert.equal(
    many.steps[0].counts.forcedLayoutCount,
    one.steps[0].counts.forcedLayoutCount,
    "per-step forcedLayoutCount must not scale with --iterations",
  );
  assert.ok(many.steps[0].stats?.samples === 5, "the step span exposes the spread");
});

// --- the fused --breakdown pass and the reconciling seven-slice bar ---

const SLICE_NAMES = ["js", "style", "layout", "paint", "gc", "other", "idle"];
const sliceSum = (breakdown) =>
  SLICE_NAMES.reduce((total, name) => total + breakdown.slices[name].ms, 0);

// Flagship reconciliation: on a forced-layout-heavy workload every span must tile its own window
// (Σ slices + idle == wall) and the style+layout slices must carry real, substantial ms: the
// forced-layout probe's cost is style recalc plus layout, ~5.5+2.0 ms measured, not one "forced
// layout" number.
e2e("record --breakdown: every span reconciles, and style+layout carry real ms", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "bd-forced");
  runCli([
    "record", path.join(examples, "forces-layout.mjs"),
    "--bench", "--breakdown", "--iterations", "5", "--out", out,
  ]);
  const rec = JSON.parse(readFileSync(out, "utf8"));

  const bars = rec.spans.filter((span) => span.breakdown);
  assert.ok(bars.length > 0, "spans carrying a reconciling bar present");
  const runSpan = bars.find((span) => span.kind === "run");
  assert.ok(runSpan, "a run span exists");

  for (const span of bars) {
    const breakdown = span.breakdown;
    const sum = sliceSum(breakdown);
    assert.ok(
      Math.abs(sum - breakdown.wallMs) < 0.01,
      `${span.label}: slices+idle ${sum} must equal wall ${breakdown.wallMs}`,
    );
    assert.equal(breakdown.residualMs, undefined, `${span.label}: an exact tiling carries no residual`);
  }

  // This workload dirties style + layout on every iteration; over 5 iterations their combined ms is
  // several ms (measured single-iteration: style ~5.5 ms + layout ~2.0 ms).
  const styleLayout = runSpan.breakdown.slices.style.ms + runSpan.breakdown.slices.layout.ms;
  assert.ok(styleLayout > 3, `style+layout should be several ms, got ${styleLayout}`);

  // Forced-layout count is NOT measured in breakdown mode (no `.stack`): null, never a fake 0.
  assert.equal(rec.summary.forcedLayoutCount, null, "forced is reported as not-measured, not 0");
});

// The idle edge probe C left untested: a run() that only awaits is ~pure waiting, so idle must
// dominate the window and the sum must still close.
e2e("record --breakdown: a waiting-dominated span is mostly idle and still closes", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "bd-idle");
  runCli([
    "record", path.join(examples, "awaits-only.mjs"),
    "--bench", "--breakdown", "--iterations", "3", "--out", out,
  ]);
  const rec = JSON.parse(readFileSync(out, "utf8"));
  const runSpan = rec.spans.find((span) => span.kind === "run");
  assert.ok(runSpan, "a run span exists");

  const { wallMs, slices } = runSpan.breakdown;
  assert.ok(slices.idle.ms / wallMs > 0.8, `idle should dominate a waiting window, got ${(slices.idle.ms / wallMs) * 100}%`);
  const sum = sliceSum(runSpan.breakdown);
  assert.ok(Math.abs(sum - wallMs) < 0.01, `slices+idle ${sum} must equal wall ${wallMs}`);
});

// The mark bridge: a page-side performance.measure becomes a span with its own breakdown. Repeated
// once per --iteration, its occurrences are its samples: the stored bar is the lower-median-by-wall
// real occurrence (samples == iterations), NOT iteration 1's, and it still reconciles because it is a
// real sample rather than a per-slice average.
e2e("record --breakdown: a repeated performance.measure merges to a median bar (samples == iterations)", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "bd-measure");
  runCli([
    "record", path.join(repoRoot, "test", "fixtures", "user-measure.mjs"),
    "--bench", "--breakdown", "--iterations", "3", "--out", out,
  ]);
  const rec = JSON.parse(readFileSync(out, "utf8"));

  const measureBars = rec.spans.filter((span) => span.kind === "measure" && span.label === "user-span");
  assert.equal(measureBars.length, 1, "the repeated label collapses to ONE stored bar, not one per iteration");
  const measureSpan = measureBars[0];
  assert.equal(measureSpan.samples, 3, "samples == iterations (one occurrence per iteration, all merged)");
  assert.ok(measureSpan.breakdown.wallMs > 0, "the measure span has a positive wall");
  // The kept bar is a real occurrence: its wall sits within the disclosed spread.
  assert.ok(
    measureSpan.wallMinMs <= measureSpan.breakdown.wallMs && measureSpan.breakdown.wallMs <= measureSpan.wallMaxMs,
    `wall ${measureSpan.breakdown.wallMs} within spread ${measureSpan.wallMinMs}..${measureSpan.wallMaxMs}`,
  );
  const sum = sliceSum(measureSpan.breakdown);
  assert.ok(
    Math.abs(sum - measureSpan.breakdown.wallMs) < 0.01,
    `the median bar reconciles exactly (residual 0): ${sum} vs ${measureSpan.breakdown.wallMs}`,
  );
  assert.equal(measureSpan.breakdown.residualMs, undefined, "a real reconciling sample carries no residual");
  // The work inside the measure is a JS loop, so its js slice must be the dominant one.
  assert.ok(measureSpan.breakdown.slices.js.ms > 0, "the measured JS work lands in the js slice");
});

// `query spans`: the unified per-span surface. On chrome --breakdown it sources the stored
// seven-slice bars, so a consumer reads the run span AND the user measure with one shape and one
// access path (spans[], keyed by label) -- the label-keyed join a matrix consumer performs.
e2e("query spans: unified per-span shape over a chrome --breakdown recording", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "spans-chrome");
  runCli([
    "record", path.join(repoRoot, "test", "fixtures", "user-measure.mjs"),
    "--bench", "--breakdown", "--iterations", "2", "--out", out,
  ]);

  const spans = JSON.parse(runCli(["query", "spans", out, "--json"]));
  assert.equal(spans.source, "breakdowns", "chrome --breakdown sources the stored per-span bars");
  assert.ok(Array.isArray(spans.spans) && spans.spans.length > 0, "spans present");
  const runSpan = spans.spans.find((span) => span.kind === "run");
  assert.ok(runSpan, "the run span is always present");
  const measure = spans.spans.find((span) => span.kind === "measure" && span.label === "user-span");
  assert.ok(measure, "the user performance.measure surfaces as a labeled span");
  // The unified superset shape: every slice key present; chrome measures them all.
  for (const key of ["js", "style", "layout", "paint", "gc", "other", "idle"])
    assert.ok(key in measure.slices, `slice '${key}' present in the unified shape`);
  assert.ok(measure.slices.js.byPackage, "js keeps its by-package split");
  // The aggregation contract: the run window spans every iteration (a sum), the repeated measure is
  // the median of its per-iteration occurrences; both stamp the recording's iteration count.
  assert.equal(runSpan.aggregation, "sum", "the run span is a total across iterations");
  assert.equal(measure.aggregation, "median", "a repeated measure span reports its median sample");
  assert.equal(measure.samples, 2, "samples == iterations (recorded with --iterations 2)");
  assert.ok(measure.wallMinMs <= measure.wallMs && measure.wallMs <= measure.wallMaxMs, "wall within the disclosed spread");
  assert.equal(runSpan.samples, undefined, "the run span carries no merge disclosure fields");
  assert.equal(runSpan.iterations, 2, "the run span carries the recording's iteration count");
  assert.equal(measure.iterations, 2, "the measure span carries the recording's iteration count");

  // --label narrows to the exact span.
  const filtered = JSON.parse(runCli(["query", "spans", out, "--json", "--label", "user-span"]));
  assert.equal(filtered.spans.length, 1);
  assert.equal(filtered.spans[0].label, "user-span");
});

// `query span <label>`: one span's full anatomy. On a --breakdown run span it carries the reconciling
// bar AND the run-window hot functions (the resolved CPU model IS the run window). A bare label
// resolves the single matching span.
e2e("query span run: --breakdown recording shows the bar and the run-window hot functions", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "span-bd");
  runCli([
    "record", path.join(examples, "forces-layout.mjs"),
    "--bench", "--breakdown", "--iterations", "5", "--out", out,
  ]);
  const anatomy = JSON.parse(runCli(["query", "span", out, "run", "--json"]));
  assert.equal(anatomy.kind, "run");
  assert.equal(anatomy.aggregation, "sum", "the run window is a total across iterations");
  assert.ok(anatomy.slices, "the reconciling bar's unified slices are present");
  for (const key of SLICE_NAMES)
    assert.ok(key in anatomy.slices, `slice '${key}' present in the anatomy`);
  // The run span's hot list comes from the sibling CPU model (the sampler brackets the whole loop).
  assert.ok(anatomy.hot, "hot functions are present for the run span");
  assert.equal(anatomy.hot.scope, "run-window");
  assert.ok(anatomy.hot.functions.length > 0, "at least one hot function in the run window");
  // A --breakdown run drops the .stack forced count: not-measured, never a fake 0.
  assert.equal(anatomy.counts.forcedLayoutCount, null, "forced count is not-measured on --breakdown");
});

// Per-span hot functions (--breakdown chrome). A heavy user measure pools its per-occurrence samples
// and surfaces a ranked hot list on the CPU-sampler scripting axis (shares of the span's pooled JS
// samples, with the pooled + occurrence counts disclosed); a trivial measure stays below the
// pooled-sample floor and is suppressed rather than fabricating a top-N.
e2e("query span <measure>: --breakdown surfaces per-span hot functions, suppressing a trivial span", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "measure-hot");
  const iterations = 6;
  runCli([
    "record", path.join(repoRoot, "test", "fixtures", "measure-hot.mjs"),
    "--bench", "--breakdown", "--iterations", String(iterations), "--out", out,
  ]);

  const heavy = JSON.parse(runCli(["query", "span", out, "measure:heavy", "--json"]));
  assert.ok(heavy.hot, "the heavy measure carries a per-span hot list");
  assert.equal(heavy.hot.scope, "measure-pooled", "a measure span pools its occurrences");
  assert.equal(heavy.hot.occurrences, iterations, "every occurrence is pooled and disclosed");
  assert.ok(heavy.hot.pooledSamples >= 10, `pooled samples clear the floor: ${heavy.hot.pooledSamples}`);
  assert.ok(heavy.hot.functions?.length > 0, "the ranked hot list is present");
  // Shares are of the span's pooled JS samples; the ranked subset cannot exceed the pooled scripting.
  const sumSelf = heavy.hot.functions.reduce((total, fn) => total + fn.selfMs, 0);
  assert.ok(sumSelf <= heavy.hot.scriptingMs + 1e-6, "Σ per-function selfMs <= the span's pooled scripting");
  assert.ok(heavy.hot.functions.every((fn) => fn.selfPct > 0 && fn.selfPct <= 100), "each function reports a valid share");
  assert.ok(
    heavy.hot.functions.some((fn) => fn.fn === "heavyWork" || fn.source?.includes("measure-hot")),
    "the dominant work resolves to a named source function",
  );

  const trivial = JSON.parse(runCli(["query", "span", out, "measure:trivial", "--json"]));
  assert.ok(trivial.hot, "the trivial measure still reports a hot object");
  assert.equal(trivial.hot.suppressed, true, "below the pooled floor: suppressed, never a fabricated top-N");
  assert.equal(trivial.hot.functions, undefined, "no functions when suppressed");
  assert.ok(trivial.hot.pooledSamples < 10, "the trivial window gathered too few samples to rank");
});

// `query span <step-label>` on a --deep driver recording: the step's exact windowed counts plus the
// forced read-sites (dual-annotated with the dirtied-by write) from the deep event log, scoped to the
// step. A step span carries no run-window hot list (per-span CPU windowing is not reconstructed, and
// --deep has no CPU model anyway).
e2e("query span <step>: --deep driver recording shows the step's counts and forced/dirtied annotations", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const html = path.join(repoRoot, "test", "fixtures", "driver-probe.html");
  assert.ok(existsSync(html), "driver-probe.html is committed, so this test cannot silently skip");
  const flow = path.join(dir, "flow.mjs");
  writeFileSync(
    flow,
    `export async function prepare({ page }) { await page.waitForSelector("#inc"); }
     export async function run({ page, measureStep }) {
       await measureStep("add rows", () => page.click("#inc"));
     }`,
  );
  const out = path.join(dir, "span-step");
  runCli(["record", flow, "--html", html, "--deep", "--iterations", "1", "--out", out]);

  const anatomy = JSON.parse(runCli(["query", "span", out, "add rows", "--json"]));
  assert.equal(anatomy.kind, "step", "a bare label resolves the single matching step span");
  // Exact windowed counts (--deep).
  assert.ok(anatomy.counts.layoutCount > 0, "the step's layout count is present");
  assert.ok(anatomy.counts.forcedLayoutCount > 0, "and it forced layout synchronously");
  // Forced read-sites from the event log, each naming a resolved source line.
  assert.ok(Array.isArray(anatomy.forced) && anatomy.forced.length > 0, "forced read-sites present");
  assert.ok(anatomy.forced.every((entry) => typeof entry.at === "string"), "each forced entry names a source line");
  const dirtied = anatomy.forced.some((entry) => entry.dirtiedBy?.length > 0);
  assert.ok(dirtied, "a forced read-site is dual-annotated with the dirtied-by write");
  // A step span carries no run-window hot list.
  assert.equal(anatomy.hot, null, "hot is not-available for a step span");
});

// The removed `query digest` / `query index` verbs exit 1 with a message naming the replacement, not
// commander's bare "unknown command" and not a stack trace. Browser-free, so a plain test (never
// skipped): the stub errors before any recording is read.
for (const removed of ["digest", "index"]) {
  test(`query ${removed} was removed and points at the replacement`, () => {
    const result = spawnSync(process.execPath, [cli, "query", removed, "latest", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `query ${removed} exits non-zero`);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, new RegExp(`\`query ${removed}\` was removed`), "names the removed verb");
    assert.match(output, /query span[s]?/, "names the replacement verb");
    assert.doesNotMatch(output, /at Object\.|node:internal/, "no stack trace");
  });
}

// The off-thread frame side track (Chrome --breakdown). It is DISPLAY-ONLY -- the frame count is
// scheduler/settle noise that swings 1->28 on unchanged code (FP-1), so this asserts PRESENCE and
// SHAPE only, never exact counts: the field exists, tallies to `total`, and the compact line is
// printed alongside the bar. Exact-count assertions would flake by design.
e2e("record --breakdown: a per-span frame side track is recorded and printed", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "bd-frames");
  const stdout = runCli([
    "record", path.join(examples, "forces-layout.mjs"),
    "--bench", "--breakdown", "--iterations", "5", "--out", out,
  ]);
  const rec = JSON.parse(readFileSync(out, "utf8"));

  const runSpan = rec.spans.find((span) => span.kind === "run");
  assert.ok(runSpan?.frames, "the run span carries a frame side track");
  const frames = runSpan.frames;
  // A painting workload produces at least one compositor frame in the run window (start-onward,
  // so the settle-tail presentation is included). Only presence is asserted, not how many.
  assert.ok(frames.total > 0, "the run span caught at least one frame");
  assert.equal(
    frames.presented + frames.presentedPartial + frames.dropped + frames.noUpdate,
    frames.total,
    "the four verdict tallies sum to total",
  );
  assert.equal(frames.frames.length, frames.total, "one raw record per frame");
  // The side track is display-only: it never leaks into the summary the gates read.
  assert.equal(
    Object.keys(rec.summary).some((key) => /frame/i.test(key) && !/forced/i.test(key)),
    false,
    "no frame field on summary, so assert/diff structurally cannot gate on it",
  );
  // ...and it is printed alongside the bar.
  assert.match(stdout, /frames: \d+ presented · \d+ partial · \d+ dropped/);
});

// The zero-authoring on-ramp: `record --url` with NO module runs a built-in driver flow that
// navigates to the url inside one "load" step and settles, so the boot lands in the run window. Every
// rung works unchanged over it. Served from a local origin (no external network), on the default rung
// and --breakdown.
e2e("record --url with no module runs the built-in load flow (default + --breakdown)", { timeout: TIMEOUT_MS }, () => {
  const html = "<!doctype html><meta charset=utf-8><title>onramp</title><body><h1>hello</h1><p>on-ramp</p></body>";
  const server = startOnrampServer(html);
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  try {
    // Default rung: the built-in "load" step span exists, INP is null (a load has no interaction), and
    // the no-trace rung reports no rendering counts (null, never a fake 0). The CPU model still runs.
    const dfltOut = path.join(dir, "onramp-default");
    runCli(["record", "--url", server.url, "--out", dfltOut]);
    const dflt = JSON.parse(readFileSync(dfltOut, "utf8"));
    assert.equal(dflt.meta.mode, "url", "the on-ramp records the url mode");
    assert.equal(dflt.meta.driver, true, "the built-in flow is a driver flow");
    const loadStep = dflt.spans.find((span) => span.kind === "step" && span.label === "load");
    assert.ok(loadStep, "a 'load' step span is recorded");
    assert.equal(dflt.summary.inpMs, null, "a page load has no interaction, so INP is null");
    assert.equal(loadStep.counts.layoutCount, null, "default rung measures no counts (—, never 0)");
    assert.ok(
      dflt.meta.notes.some((note) => /Built-in load flow/.test(note)),
      "the built-in flow is disclosed in the notes",
    );
    assert.ok(dflt.summary.scriptingMs != null, "the CPU model still measures JS self-time on the boot");

    // --breakdown: the run span AND the load step carry a reconciling bar (Σ slices + idle == wall),
    // counts are measured, and the navigating load step is priced on the trace clock (spans the nav).
    const bdOut = path.join(dir, "onramp-breakdown");
    runCli(["record", "--url", server.url, "--breakdown", "--out", bdOut]);
    const bd = JSON.parse(readFileSync(bdOut, "utf8"));
    const runSpan = bd.spans.find((span) => span.kind === "run");
    const bdLoad = bd.spans.find((span) => span.kind === "step" && span.label === "load");
    assert.ok(runSpan?.breakdown, "the run span carries a reconciling bar");
    assert.ok(bdLoad?.breakdown, "the load step carries a reconciling bar");
    for (const span of [runSpan, bdLoad]) {
      const sum = sliceSum(span.breakdown);
      assert.ok(
        Math.abs(sum - span.breakdown.wallMs) < 0.01,
        `${span.label}: slices+idle ${sum} must equal wall ${span.breakdown.wallMs}`,
      );
    }
    assert.equal(bdLoad.wallClock, "trace", "the navigating load step is priced on the trace clock");
    assert.ok(bd.summary.paintCount >= 1, "the boot painted at least once, counted on --breakdown");
    assert.equal(bd.summary.forcedLayoutCount, null, "forced is not-measured on --breakdown (no .stack)");

    // F4: --iterations on the default (no-trace) rung yields no wall and no median, because the
    // navigating load step resets the page clock and there is no trace clock to span it. The note must
    // say so and steer to --breakdown, NOT the warm/cold note that would promise a median.
    const iterOut = path.join(dir, "onramp-iter-default");
    runCli(["record", "--url", server.url, "--iterations", "2", "--out", iterOut]);
    const iter = JSON.parse(readFileSync(iterOut, "utf8"));
    const iterLoad = iter.spans.find((span) => span.kind === "step" && span.label === "load");
    assert.equal(iterLoad.stats, null, "no median on the no-trace rung: the navigating step has no wall");
    assert.ok(
      iter.meta.notes.some((note) => /no per-iteration wall or median/.test(note)),
      "the no-median note fires and points to --breakdown",
    );
    assert.ok(
      !iter.meta.notes.some((note) => /boots cold, but/.test(note)),
      "the warm/cold note (which promises a median) does NOT fire where there is no wall",
    );
  } finally {
    server.close();
  }
});

// F1/F2 regression: a --url boot navigates the blank host page (wpd serves it on 127.0.0.1) to the
// target on a DIFFERENT SITE ("localhost"), which swaps the renderer process. wpd:run:start is marked
// on the pre-navigation renderer; all the boot's layout/style/paint runs on the process the page
// navigated INTO. The counts and the reconciling bar must FOLLOW the page to that process, not report
// the pre-nav blank thread as ~100% idle with zero counts. The outcome (non-zero counts, a bar that is
// not almost-all idle) holds whether or not a given CI actually swaps, so the test is not flaky: it
// fails only on the bug it guards (counts wrongly 0).
e2e("record --url boot: counts/bar follow a cross-process navigation, not the blank host thread (F1/F2)", { timeout: TIMEOUT_MS }, () => {
  const server = startOnrampServer(BOOT_WORK_HTML, "localhost");
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  try {
    // --breakdown: the run bar tiles the post-navigation renderer, so layout/style are real and the
    // bar is not the ~100% idle F1 produced. Both the run span and the load step carry the counts.
    const bdOut = path.join(dir, "boot-breakdown");
    runCli(["record", "--url", server.url, "--breakdown", "--out", bdOut]);
    const bd = JSON.parse(readFileSync(bdOut, "utf8"));
    assert.ok(bd.summary.layoutCount > 0, `layoutCount must be non-zero on a laying-out boot (got ${bd.summary.layoutCount})`);
    assert.ok(bd.summary.styleCount > 0, `styleCount must be non-zero on a laying-out boot (got ${bd.summary.styleCount})`);
    const runSpan = bd.spans.find((span) => span.kind === "run");
    const bdLoad = bd.spans.find((span) => span.kind === "step" && span.label === "load");
    assert.ok(runSpan?.breakdown, "the run span carries a reconciling bar");
    const idleFraction = runSpan.breakdown.slices.idle.ms / runSpan.breakdown.wallMs;
    assert.ok(idleFraction < 0.95, `the run bar is not almost-all idle (idle was ${(idleFraction * 100).toFixed(1)}%)`);
    assert.ok(bdLoad.counts.layoutCount > 0, "the load step's counts also follow the navigated process");

    // --deep: exact counts on the same cross-process boot must be > 0 (the F2 consequence: a real
    // laying-out page must not pass a --max-layouts gate at 0).
    const deepOut = path.join(dir, "boot-deep");
    runCli(["record", "--url", server.url, "--deep", "--out", deepOut]);
    const deep = JSON.parse(readFileSync(deepOut, "utf8"));
    assert.ok(deep.summary.layoutCount > 0, `--deep layoutCount must be non-zero (got ${deep.summary.layoutCount})`);
    assert.ok(deep.summary.forcedLayoutCount > 0, "the forced-layout reads at boot are counted on --deep");
  } finally {
    server.close();
  }
});

// The flag guards reject before any browser launches, so this runs everywhere (not gated on Chrome).
test("record --headless-mode shell errors when combined with --no-headless", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "record", path.join(examples, "forces-layout.mjs"), "--headless-mode", "shell", "--no-headless"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "the bad flag combo exits non-zero");
  assert.match(result.stderr, /--headless-mode shell requires headless \(drop --no-headless\)/);
});

// --headless-mode is a Chrome-only launch flavour, so ANY explicit value is rejected on firefox/node
// (not just shell). Guards reject before any browser launches, so this runs everywhere.
test("record --headless-mode new errors on a firefox target (chrome-only flag)", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "record", path.join(examples, "forces-layout.mjs"), "--target", "firefox", "--headless-mode", "new"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "the chrome-only flag on firefox exits non-zero");
  assert.match(result.stderr, /--headless-mode is chrome-only \(target is firefox\)/);
});

// The rungs are mutually exclusive: two rungs are two captures / two questions, so wpd points at
// running twice rather than fusing them. Guards fire before any browser launches.
const guardError = (args) =>
  spawnSync(process.execPath, [cli, "record", path.join(examples, "forces-layout.mjs"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });

test("record --breakdown --deep is rejected (two rungs, two invocations)", () => {
  const result = guardError(["--breakdown", "--deep"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--breakdown and --deep are two different rungs/);
});

test("record --precise-wall --breakdown is rejected (rung 1 minus sampler vs a higher rung)", () => {
  const result = guardError(["--precise-wall", "--breakdown"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--precise-wall is rung 1 minus the sampler/);
});

test("record --breakdown on firefox is rejected (the gecko pass IS the firefox lane)", () => {
  // --deep on firefox is a reporting tier over the same gecko pass (its dirtied-by write report
  // is covered in test/firefox.e2e.test.mjs). --breakdown has no meaning on firefox and is
  // refused before any browser launches.
  const result = guardError(["--target", "firefox", "--breakdown"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported/);
  assert.match(result.stderr, /--breakdown/);
});

test("record --deep on node is rejected (CPU-only lane, no trace)", () => {
  const result = guardError(["--target", "node", "--deep"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CPU-only lane/);
});
