import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
