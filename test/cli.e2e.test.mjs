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

// --runtime node profiles in-process via node's V8 inspector, so it needs no browser and
// runs everywhere (not gated on Chrome).
test("record --runtime node resolves hot functions to source without a browser", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "nodecpu");
  runCli(["record", path.join(examples, "cpu-busywork.mjs"), "--runtime", "node", "--iterations", "3", "--out", out]);
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

e2e("record --cpu-profile resolves hot functions to source", { timeout: TIMEOUT_MS }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-e2e-"));
  const out = path.join(dir, "cpu");
  runCli(["record", path.join(examples, "cpu-busywork.mjs"), "--bench", "--cpu-profile", "--iterations", "3", "--out", out]);
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
