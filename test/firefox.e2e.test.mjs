import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

// End-to-end for the Firefox lane: drives the built CLI with --browser firefox, which launches
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

e2e(
  "record --browser firefox (timing only) writes a recording with honest notes",
  { timeout: TIMEOUT_MS },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wpd-ff-"));
    const out = path.join(dir, "timing");
    runCli(["record", path.join(examples, "cpu-busywork.mjs"), "--bench", "--browser", "firefox", "--iterations", "3", "--out", out]);
    assert.ok(existsSync(out), "recording file written");

    const recording = JSON.parse(runCli(["query", "digest", out, "--json"]));
    assert.equal(recording.meta.browser, "firefox", "meta records the firefox backend");
    assert.deepEqual(recording.meta.passes, ["timing"], "timing-only lane");
    // Honest about what Firefox cannot measure without a Gecko pass.
    assert.ok(
      recording.meta.notes.some((note) => /Firefox backend/.test(note)),
      "notes disclose the Firefox capability limits",
    );
    assert.ok(recording.summary.wallMs != null && recording.summary.wallMs >= 0, "wall time reported");
  },
);

e2e(
  "record --browser firefox --cpu-profile resolves hot functions to source",
  { timeout: TIMEOUT_MS },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wpd-ff-"));
    const out = path.join(dir, "cpu");
    runCli(["record", path.join(examples, "cpu-busywork.mjs"), "--bench", "--browser", "firefox", "--cpu-profile", "--iterations", "20", "--out", out]);
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
  "record --browser firefox --cpu-profile attributes forced layout to source (Reflow/Styles markers)",
  { timeout: TIMEOUT_MS },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wpd-ff-"));
    const out = path.join(dir, "blame");
    runCli(["record", path.join(examples, "forces-layout.mjs"), "--bench", "--browser", "firefox", "--cpu-profile", "--iterations", "3", "--out", out]);

    const blame = JSON.parse(runCli(["query", "blame", out, "--forced", "--json"]));
    assert.ok(Array.isArray(blame) && blame.length > 0, "at least one forced layout/style source group");
    const fromExample = blame.filter((row) => row.at?.includes("forces-layout.mjs"));
    assert.ok(fromExample.length > 0, "forced layout/style attributed to forces-layout.mjs");
    assert.ok(fromExample[0].forced > 0, "forced count is positive");
    const kinds = new Set(fromExample.flatMap((row) => row.kinds ?? []));
    assert.ok(kinds.has("layout") || kinds.has("style"), "kinds include layout or style");
  },
);
