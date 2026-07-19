import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

// End-to-end for the Firefox lane: drives the built CLI with --target firefox, which launches
// real Firefox over WebDriver BiDi, profiles run() with the Gecko profiler, and resolves CPU
// self-time + forced layout/style back to source. Firefox's puppeteer build is installed
// separately (`npx puppeteer browsers install firefox`), so this self-skips when it is absent to
// keep `npm test` and the browser-free CI job green. Unlike the Chrome e2e there is no
// WPD_E2E_REQUIRED hard-fail: Firefox stays an optional lane (run it via `npm run test:e2e:firefox`).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repoRoot, "dist", "cli.js");
const examples = path.join(repoRoot, "examples");

// executablePath() mis-guesses the Firefox build path, so probe by actually launching it (the
// e2e needs a working launch anyway); a failure means Firefox is not installed => skip.
async function firefoxAvailable() {
  try {
    const browser = await puppeteer.launch({ browser: "firefox", headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const ready = await firefoxAvailable();
const e2e = ready
  ? test
  : (name, _opts, fn) => test(name, { skip: "Firefox not installed" }, fn ?? _opts);

// Firefox launch + gecko shutdown dump + parse; generous so a slow CI runner does not flake.
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

// Regression: a plain `--target firefox` run used to need --cpu-profile to measure anything, and
// silently reported every rendering count as 0 without it. The gecko pass is no longer opt-in, so
// the bare invocation must now carry real detail. This test exists to keep that footgun from
// returning: assert on the counts, not just on the pass list.
e2e(
  "record --target firefox yields rendering detail with no extra flag",
  { timeout: TIMEOUT_MS },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wpd-ff-"));
    const out = path.join(dir, "default");
    runCli(["record", path.join(examples, "forces-layout.mjs"), "--bench", "--target", "firefox", "--iterations", "3", "--out", out]);
    assert.ok(existsSync(out), "recording file written");

    const recording = JSON.parse(runCli(["query", "digest", out, "--json"]));
    assert.equal(recording.meta.browser, "firefox", "meta records the firefox backend");
    assert.deepEqual(recording.meta.passes, ["timing", "gecko"], "gecko pass runs by default");
    assert.ok(
      recording.meta.notes.some((note) => /Firefox backend/.test(note)),
      "notes disclose the Firefox capability limits",
    );
    assert.ok(recording.summary.wallMs != null && recording.summary.wallMs >= 0, "wall time reported");
    // The point of the change: these were 0 before, which was indistinguishable from a clean run.
    assert.ok(recording.summary.forcedLayoutCount > 0, "forced layout counted without --cpu-profile");
  },
);

// The chrome capture-ladder flags have no meaning on firefox: the ONE gecko pass IS the lane at
// every rung. --deep (and --breakdown / --precise-wall) are refused rather than silently ignored.
// The guard fires before any browser launches, so this runs everywhere (not gated on Firefox).
test("record --target firefox --deep is refused (the gecko pass IS the firefox lane)", () => {
  const result = spawnSync(process.execPath, [cli, "record", path.join(examples, "cpu-busywork.mjs"), "--bench", "--target", "firefox", "--deep"], { encoding: "utf8" });
  assert.notEqual(result.status, 0, "exits non-zero");
  assert.match(result.stderr, /unsupported/, "explains why it is refused");
});

e2e(
  "record --target firefox resolves hot functions to source",
  { timeout: TIMEOUT_MS },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wpd-ff-"));
    const out = path.join(dir, "cpu");
    runCli(["record", path.join(examples, "cpu-busywork.mjs"), "--bench", "--target", "firefox", "--iterations", "20", "--out", out]);
    assert.ok(existsSync(`${out}.cpu.json`), "cpu model written");
    assert.ok(existsSync(`${out}.geckoprofile.json`), "raw gecko dump written");

    const model = JSON.parse(runCli(["query", "cpu", out, "--json"]));
    assert.ok(model.scriptingMs > 0, "non-zero sampled scripting time");
    assert.ok(model.sampleCount > 0, "gecko profiler collected samples");
    const named = model.hot.find(
      (fn) => fn.fn === "hashString" || fn.fn === "buildRows" || fn.fn === "serializeStyle",
    );
    assert.ok(named, "a named busywork function is hot");
    assert.ok(named.source?.includes("cpu-busywork.mjs"), "hot function resolved to its source file");
  },
);

e2e(
  "record --target firefox attributes forced layout to the READ site with the property (not the write)",
  { timeout: TIMEOUT_MS },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wpd-ff-"));
    const out = path.join(dir, "blame");
    runCli(["record", path.join(examples, "forces-layout.mjs"), "--bench", "--target", "firefox", "--iterations", "40", "--out", out]);

    const blame = JSON.parse(runCli(["query", "blame", out, "--forced", "--json"]));
    assert.ok(Array.isArray(blame) && blame.length > 0, "at least one forced layout/style source group");
    const fromExample = blame.filter((row) => row.at?.includes("forces-layout.mjs"));
    assert.ok(fromExample.length > 0, "forced layout/style attributed to forces-layout.mjs");
    assert.ok(fromExample[0].forced > 0, "forced count is positive");
    const kinds = new Set(fromExample.flatMap((row) => row.kinds ?? []));
    assert.ok(kinds.has("layout") || kinds.has("style"), "kinds include layout or style");

    // Read-site semantics: the geometry READ lines are named, never the bump()/style-write lines.
    const blamedLines = new Set(
      fromExample.map((row) => Number(row.at.match(/forces-layout\.mjs:(\d+)/)?.[1])),
    );
    for (const writeLine of [13, 15, 16, 17, 19, 21])
      assert.ok(!blamedLines.has(writeLine), `write line ${writeLine} must never be blamed`);
    // At least one line inside the reads block (46..145), where the geometry reads live.
    assert.ok([...blamedLines].some((line) => line >= 46 && line <= 145), "a geometry-read line");
    // The forcing DOM property is spelled out on the read-site rows.
    const properties = fromExample.flatMap((row) => row.properties ?? []);
    assert.ok(
      properties.some((property) => /offset|scroll|client|Height|Width|Rect|getComputed/.test(property)),
      "at least one forcing DOM property is named",
    );

    // The recording's blame semantic is now read-site (flush-site), matching Chrome.
    const digest = JSON.parse(runCli(["query", "digest", out, "--json"]));
    assert.equal(digest.meta.blameSemantic, "flush-site", "firefox now names the read site");
  },
);

e2e(
  "record --target firefox emits a reconciling breakdown with honest idle",
  { timeout: TIMEOUT_MS },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wpd-ff-"));
    const out = path.join(dir, "awaits");
    runCli(["record", path.join(examples, "awaits-only.mjs"), "--bench", "--target", "firefox", "--iterations", "2", "--out", out]);

    const model = JSON.parse(runCli(["query", "cpu", out, "--json"]));
    const breakdown = model.breakdown;
    assert.ok(breakdown, "firefox CPU breakdown is emitted (idle from threadCPUDelta)");
    assert.ok(breakdown.slices.style && breakdown.slices.layout, "style/layout slices present");
    const sum =
      breakdown.slices.js.ms +
      breakdown.slices.style.ms +
      breakdown.slices.layout.ms +
      breakdown.slices.browser.ms +
      breakdown.slices.gc.ms +
      breakdown.slices.idle.ms;
    assert.ok(Math.abs(sum - breakdown.wallMs) < 0.01, "slices tile the sampled window (reconciles)");
    // A pure-wait run is dominated by idle.
    assert.ok(breakdown.slices.idle.ms / breakdown.wallMs > 0.8, "idle > 80% on a pure-wait run");
  },
);

e2e(
  "record --target firefox surfaces a performance.measure span with its own breakdown",
  { timeout: TIMEOUT_MS },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wpd-ff-"));
    const out = path.join(dir, "measure");
    runCli(["record", path.join(examples, "measure-span.mjs"), "--bench", "--target", "firefox", "--iterations", "5", "--out", out]);

    const digest = JSON.parse(runCli(["query", "digest", out, "--json"]));
    assert.ok(Array.isArray(digest.breakdowns), "breakdowns present");
    const bars = digest.breakdowns.filter((entry) => entry.kind === "measure" && entry.label === "work");
    assert.equal(bars.length, 1, "the repeated 'work' label collapses to ONE stored bar");
    const span = bars[0];
    // Repeated once per --iteration: the bar is the lower-median-by-wall occurrence, samples == iterations.
    assert.equal(span.samples, 5, "samples == iterations (one occurrence per iteration, all merged)");
    assert.ok(
      span.wallMinMs <= span.breakdown.wallMs && span.breakdown.wallMs <= span.wallMaxMs,
      `wall ${span.breakdown.wallMs} within spread ${span.wallMinMs}..${span.wallMaxMs}`,
    );
    const slices = span.breakdown.slices;
    const sum =
      slices.js.ms + slices.style.ms + slices.layout.ms + slices.paint.ms + slices.gc.ms + slices.other.ms + slices.idle.ms;
    assert.ok(Math.abs(sum - span.breakdown.wallMs) < 0.01, "the median bar tiles its own window (a real sample reconciles)");
    assert.equal(slices.paint.ms, 0, "paint is 0 on firefox (off-main-thread)");
  },
);

// `query spans` reads the SAME unified shape on firefox as on chrome: the run span plus the user
// performance.measure, keyed by label. This is the cross-engine join the dogfooding report asked
// for -- a firefox consumer no longer special-cases CpuModel.breakdown or misses per-measure spans.
e2e(
  "query spans: unified per-span shape over a firefox recording (run + performance.measure)",
  { timeout: TIMEOUT_MS },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wpd-ff-"));
    const out = path.join(dir, "spans");
    runCli(["record", path.join(examples, "measure-span.mjs"), "--bench", "--target", "firefox", "--iterations", "5", "--out", out]);

    const spans = JSON.parse(runCli(["query", "spans", out, "--json"]));
    assert.equal(spans.target, "firefox", "spans records the firefox target");
    assert.ok(Array.isArray(spans.spans) && spans.spans.length > 0, "spans present");
    const runSpan = spans.spans.find((span) => span.kind === "run");
    assert.ok(runSpan, "the run span is present");
    const measure = spans.spans.find((span) => span.kind === "measure" && span.label === "work");
    assert.ok(measure, "the user performance.measure 'work' surfaces as a labeled span on firefox");
    // Same superset shape as chrome: every slice key present, style/layout measured on firefox.
    for (const key of ["js", "style", "layout", "paint", "gc", "other", "idle"])
      assert.ok(key in measure.slices, `slice '${key}' present in the unified shape`);
    assert.notEqual(measure.slices.style, null, "firefox splits style");
    assert.notEqual(measure.slices.layout, null, "firefox splits layout");
    // The aggregation contract crosses the engine unchanged: run = a total over the loop, a repeated
    // measure = the median of its per-iteration occurrences, with identical spread disclosure to chrome.
    assert.equal(runSpan.aggregation, "sum", "the run span is a total across iterations");
    assert.equal(measure.aggregation, "median", "a repeated measure span reports its median sample");
    assert.equal(measure.samples, 5, "samples == iterations (recorded with --iterations 5)");
    assert.ok(measure.wallMinMs <= measure.wallMs && measure.wallMs <= measure.wallMaxMs, "wall within the disclosed spread");
    assert.equal(runSpan.samples, undefined, "the run span carries no merge disclosure fields");
    assert.equal(runSpan.iterations, 5, "the run span carries the recording's iteration count");
    assert.equal(measure.iterations, 5, "the measure span carries the recording's iteration count");

    // The convergence hint: `query cpu --json` points firefox consumers at this surface.
    const cpu = JSON.parse(runCli(["query", "cpu", out, "--json"]));
    assert.ok(cpu.hints.some((hint) => /query spans/.test(hint)), "query cpu points at the spans surface");
  },
);
