import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The serial MEASUREMENT lane (browser-free --target node; records a real CPU profile, so it runs
// alone). This exercises the `react` addon's node-lane server-phase rollup end-to-end through the
// built CLI, plus the `--framework off` guarantee, on a self-contained fixture (no install, no browser).
// Browser-lane detection/commit-count and the react-dev TimeStamp classifier are covered at unit level
// (test/unit/react-addon.test.mjs): a real React browser bundle cannot be produced without a network
// install, which a test must never do.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "test", "fixtures", "react-addon", "ssr.mjs");
const examples = path.join(repoRoot, "examples");

const CLI_KILL_MS = 150_000;

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: CLI_KILL_MS,
    killSignal: "SIGKILL",
  });
  if (result.error && result.error.code === "ETIMEDOUT")
    throw new Error(`cli ${args.join(" ")} killed after ${CLI_KILL_MS}ms\n${result.stderr ?? ""}`);
  if (result.status !== 0)
    throw new Error(`cli ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
  return result.stdout;
}

const runSpanOf = (recordingPath) => {
  const recording = JSON.parse(readFileSync(recordingPath, "utf8"));
  return recording.spans.find((span) => span.kind === "run");
};

test("react addon (node lane): server-phase self-time rolls onto the react-dom anchors", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-react-"));
  const out = path.join(dir, "rec.json");
  runCli(["record", fixture, "--target", "node", "--iterations", "20", "--out", out]);

  const react = runSpanOf(out).addons?.react;
  assert.ok(react, "the run span carries react addon facts");
  assert.ok(react.phases, "the node lane attaches a server-phase rollup");
  assert.ok(react.phases.totalMs > 0, `phases.totalMs is non-zero, got ${react.phases.totalMs}`);
  const names = react.phases.anchors.map((anchor) => anchor.name);
  assert.ok(names.includes("renderWithHooks"), `anchors include renderWithHooks, got ${names}`);
  // Detection is honestly absent on node (no page hook), never a fabricated zero.
  assert.equal(react.detected, undefined, "node lane reports no detection (no page hook)");
});

test("--framework off runs zero addon code: no addons slot even on a react-dom workload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-react-off-"));
  const out = path.join(dir, "rec.json");
  runCli([
    "record",
    fixture,
    "--target",
    "node",
    "--framework",
    "off",
    "--iterations",
    "20",
    "--out",
    out,
  ]);
  assert.equal(
    runSpanOf(out).addons,
    undefined,
    "off leaves no addons slot, even though react-dom anchors are hot",
  );
});

test("--framework auto is honest on a non-React workload: no addons slot", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-react-none-"));
  const out = path.join(dir, "rec.json");
  runCli([
    "record",
    path.join(examples, "probes", "cpu-busywork.mjs"),
    "--target",
    "node",
    "--iterations",
    "5",
    "--out",
    out,
  ]);
  assert.equal(runSpanOf(out).addons, undefined, "no framework detected -> no addon vocabulary");
});
