import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

e2e("record + query blame attributes forced layout to the source line", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "forced");
  runCli(["record", path.join(examples, "forces-layout.mjs"), "--bench", "--iterations", "3", "--out", out]);
  assert.ok(existsSync(out), "recording file written");

  const blame = JSON.parse(runCli(["query", "blame", out, "--forced", "--json"]));
  assert.ok(Array.isArray(blame) && blame.length > 0, "at least one forced-layout source group");
  const fromExample = blame.filter((row) => row.at?.includes("forces-layout.mjs"));
  assert.ok(fromExample.length > 0, "forced layout attributed to forces-layout.mjs");
  const top = fromExample[0];
  assert.ok(top.forced > 0, "forced count is positive");
  assert.ok(top.kinds.includes("layout"), "kinds include layout");
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

// The invariant this pins: counts answer "how much work does one iteration cause", so they must
// not move when --iterations changes. They used to be summed over the whole loop (measured on
// this probe: layoutCount 22 -> 102 -> 202 at 1/5/10), which silently rescaled every threshold --
// `assert --max-layouts 30` passed at 1 and failed at 10 on an unchanged page. Wall is the
// opposite: it only means something in bulk, so its sample count MUST track --iterations.
e2e("bench counts describe one iteration, not --iterations of them", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const read = (iterations) => {
    const out = path.join(dir, `iters-${iterations}`);
    runCli([
      "record", path.join(examples, "forces-layout.mjs"),
      "--bench", "--iterations", String(iterations), "--out", out,
    ]);
    return JSON.parse(readFileSync(out, "utf8")).summary;
  };

  const one = read(1);
  const many = read(8);

  assert.ok(one.layoutCount > 0, "the probe forces layout at all");
  assert.equal(many.layoutCount, one.layoutCount, "layoutCount must not scale with --iterations");
  assert.equal(many.styleCount, one.styleCount, "styleCount must not scale with --iterations");
  assert.equal(
    many.forcedLayoutCount,
    one.forcedLayoutCount,
    "forcedLayoutCount must not scale with --iterations",
  );

  // Wall is the axis that SHOULD grow: one sample per timed iteration, contiguous, all real.
  assert.equal(one.perIteration.length, 1, "one iteration yields one wall sample");
  assert.equal(many.perIteration.length, 8, "eight iterations yield eight wall samples");
  assert.ok(
    many.perIteration.every((ms) => ms > 0),
    "every iteration of a split timed phase is measured, including those after the counts bracket",
  );
  assert.ok(many.stats && many.stats.samples === 8, "stats are computed over all timed iterations");

  // The mirror of the counts bug, and a regression this actually hit: pinning the trace pass to
  // one iteration made wallMs describe that ONE iteration while still being read as the whole
  // run, which silently loosened `assert --max-wall` by ~N x on an unchanged page. Wall must stay
  // on the N axis, and must be exactly the samples `stats` describes.
  const sum = (samples) => samples.reduce((total, ms) => total + ms, 0);
  assert.ok(
    Math.abs(many.wallMs - sum(many.perIteration)) < 0.001,
    "bench wallMs is the sum of the timed samples, not a window that excludes most of them",
  );
  assert.ok(
    many.wallMs > one.wallMs,
    `wallMs must grow with --iterations (got ${many.wallMs} at 8 vs ${one.wallMs} at 1)`,
  );
});

// The headline of driver --iterations: a real interaction measured once is a single sample of a
// clock Chrome deliberately clamps, which cannot separate a regression from noise. Measured on
// this flow, the n=1 reading of "first increment" was 87ms while the median over 6 was 40ms with
// a 255ms outlier -- the single sample was not merely imprecise, it was 2x off the typical value.
// Counts must NOT move with --iterations; only the sample count may.
e2e("driver --iterations repeats the flow: per-step medians, per-iteration counts", { timeout: TIMEOUT_MS }, () => {
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
      "--html", html, "--iterations", String(iterations), "--out", out,
    ]);
    return {
      recording: JSON.parse(readFileSync(out, "utf8")),
      index: JSON.parse(readFileSync(`${out}.index.json`, "utf8")),
    };
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

  // Counts are the axis that must hold still. Guard non-vacuity first: every equality below would
  // hold at 0 === 0 on a page that did nothing, which is how the skipped version of this test
  // passed for free.
  assert.ok(one.recording.summary.layoutCount > 0, "the fixture actually causes layout");
  assert.ok(one.recording.summary.forcedLayoutCount > 0, "and forces it synchronously");
  assert.equal(
    many.recording.summary.layoutCount,
    one.recording.summary.layoutCount,
    "overall layoutCount must not scale with --iterations",
  );
  assert.equal(
    many.recording.summary.forcedLayoutCount,
    one.recording.summary.forcedLayoutCount,
    "overall forcedLayoutCount must not scale with --iterations",
  );
  assert.equal(
    many.index.steps[0].headline.layoutCount,
    one.index.steps[0].headline.layoutCount,
    "per-step layoutCount must not scale with --iterations",
  );
  assert.ok(many.index.steps[0].stats?.samples === 5, "the step index exposes the spread");
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

  assert.ok(Array.isArray(rec.breakdowns) && rec.breakdowns.length > 0, "breakdowns present");
  const runSpan = rec.breakdowns.find((span) => span.kind === "run");
  assert.ok(runSpan, "a run span exists");

  for (const span of rec.breakdowns) {
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
  const runSpan = rec.breakdowns.find((span) => span.kind === "run");
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

  const measureBars = rec.breakdowns.filter((span) => span.kind === "measure" && span.label === "user-span");
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

  const runSpan = rec.breakdowns.find((span) => span.kind === "run");
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
