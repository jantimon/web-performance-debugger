import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The `assert --format json|toon` CONTRACT: assert.ts serializes an AssertView so a CI script renders
// a PR comment from structure instead of scraping the ASCII table. Nothing else parses that shape, so
// these tests do -- browser-free, driving the built CLI against hand-written recordings. They assert
// the SHAPE, the VALUES, and above all that the EXIT CODE is identical to the human report: a
// not-measured metric is a loud n/a-fail (value null, exit 1), never a silent pass

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");

const baseMeta = (overrides = {}) => ({
  tool: "wpd",
  version: "0.0.0",
  schemaVersion: "5",
  createdAt: new Date().toISOString(),
  mode: "module",
  target: "probe",
  fn: "default",
  iterations: 1,
  warmup: 0,
  headless: true,
  userDataDir: null,
  lifecycle: [],
  capture: "deep",
  notes: [],
  driver: false,
  ...overrides,
});

const defaultCounts = {
  layoutCount: 300,
  styleCount: 300,
  paintCount: 5,
  forcedLayoutCount: 2,
  layoutInvalidations: 0,
  styleInvalidations: 0,
  longTaskCount: 0,
};

// A minimal schema-5 recording: the run span is the sole count/timing store assert reads
function recording({ counts = {}, wallMs = 10, meta = {} } = {}) {
  return {
    meta: baseMeta(meta),
    events: [],
    spans: [
      {
        label: "run",
        kind: "run",
        aggregation: "sum",
        wallMs,
        inpMs: null,
        counts: { ...defaultCounts, ...counts },
      },
    ],
  };
}

function makeDir() {
  return mkdtempSync(path.join(tmpdir(), "wpd-assert-"));
}
function writeRec(dir, name, opts) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(recording(opts)));
  return file;
}
const run = (args, fmt) => {
  const withFmt = fmt ? [...args, "--format", fmt] : args;
  return spawnSync(process.execPath, [cli, "assert", ...withFmt], { cwd: root, encoding: "utf8" });
};
const runJson = (args) => {
  const result = run(args, "json");
  assert.ok(result.stdout.trim().length, `assert produced no stdout:\n${result.stderr}`);
  return { view: JSON.parse(result.stdout), status: result.status };
};
const rowFor = (view, metric) => view.thresholds.find((row) => row.metric === metric);

test("assert --format json emits the AssertView shape: a passing count and a failing count", () => {
  const dir = makeDir();
  const rec = writeRec(dir, "rec.json", { counts: { forcedLayoutCount: 5, layoutCount: 300 } });
  const { view, status } = runJson([rec, "--max-forced", "10", "--max-layouts", "100"]);

  assert.equal(view.kind, "recording");
  assert.equal(view.target, rec);
  assert.ok(Array.isArray(view.thresholds));
  assert.deepEqual(view.notes, [], "a plain recording carries no group notes");

  // Every row carries the documented keys
  for (const row of view.thresholds)
    for (const field of ["target", "metric", "axis", "budget", "value", "verdict"])
      assert.ok(field in row, `row ${row.metric} is missing ${field}`);

  const forced = rowFor(view, "forced layout/style");
  assert.equal(forced.target, "run");
  assert.equal(forced.axis, "count");
  assert.equal(forced.budget, 10);
  assert.equal(forced.value, 5);
  assert.equal(forced.verdict, "pass", "5 <= 10 passes");

  const layouts = rowFor(view, "layouts");
  assert.equal(layouts.value, 300);
  assert.equal(layouts.budget, 100);
  assert.equal(layouts.verdict, "fail", "300 > 100 fails");

  assert.equal(view.passed, false, "one failing threshold means the gate failed");
  assert.equal(status, 1, "the exit code matches the verdict");
  assert.ok(
    view.violations.some((line) => line.includes("layouts") && line.includes("300")),
    "the violation is worded on the view",
  );
});

// THE CONTRACT THAT MATTERS: a metric the capture mode did not measure is a loud n/a-fail (value null,
// exit 1), never a silent pass. Dropping the Measured gate would show value 0 and pass.
test("assert --format json: a not-measured metric is a value-null n/a-fail, exit 1", () => {
  const dir = makeDir();
  const rec = writeRec(dir, "rec.json", { counts: { forcedLayoutCount: null } });
  const { view, status } = runJson([rec, "--max-forced", "0"]);

  const forced = rowFor(view, "forced layout/style");
  assert.equal(forced.value, null, "not measured is null, never a fabricated 0");
  assert.equal(forced.verdict, "n/a-fail");
  assert.equal(forced.reason, "not measured");
  assert.equal(view.passed, false);
  assert.equal(status, 1, "an n/a metric FAILs the gate, it does not silently pass");
});

test("assert --format json: an all-pass gate reports passed true and exits 0", () => {
  const dir = makeDir();
  const rec = writeRec(dir, "rec.json", { counts: { forcedLayoutCount: 0 }, wallMs: 5 });
  const { view, status } = runJson([rec, "--max-forced", "0", "--max-wall", "100"]);
  assert.equal(view.passed, true);
  assert.deepEqual(view.violations, []);
  assert.equal(status, 0);
  assert.equal(rowFor(view, "wall ms").axis, "timing", "wall is a timing axis");
  assert.equal(rowFor(view, "wall ms").value, 5);
});

// A slice budget on a recording with no reconciling bar is the slice axis and an n/a-fail
test("assert --format json: a slice budget on a bar-less recording is a slice-axis n/a-fail", () => {
  const dir = makeDir();
  const rec = writeRec(dir, "rec.json");
  const { view, status } = runJson([rec, "--max-slice", "js=5"]);
  const js = rowFor(view, "js");
  assert.equal(js.axis, "slice");
  assert.equal(js.budget, 5);
  assert.equal(js.value, null, "an unmeasured slice cannot satisfy a budget");
  assert.equal(js.verdict, "n/a-fail");
  assert.equal(view.passed, false);
  assert.equal(status, 1);
});

// The JSON `passed` flag and the process exit code must agree with the human report on the SAME input
test("assert: the json `passed` flag matches the human exit code", () => {
  const dir = makeDir();
  const rec = writeRec(dir, "rec.json", { counts: { forcedLayoutCount: 3 } });
  const human = run([rec, "--max-forced", "0"]);
  const { view, status } = runJson([rec, "--max-forced", "0"]);
  assert.equal(human.status, 1, "the human report exits 1 on a failing gate");
  assert.equal(status, human.status, "the json exit code matches the human one");
  assert.equal(view.passed, false, "the view agrees the gate failed");
});

test("assert --format toon: parses to the same verdict", () => {
  const dir = makeDir();
  const rec = writeRec(dir, "rec.json", { counts: { forcedLayoutCount: 0 }, wallMs: 5 });
  const result = run([rec, "--max-forced", "0"], "toon");
  assert.equal(result.status, 0, "an all-pass TOON gate exits 0");
  assert.match(result.stdout, /kind: recording/, "the TOON output carries the view kind");
  assert.match(result.stdout, /passed: true/, "the TOON output carries the verdict");
});

// A run-group gate: kind "group", the routed member named on each row, group notes carried through
const groupMeta = (name) => ({
  tool: "wpd",
  version: "0.0.0",
  schemaVersion: "5",
  kind: "run-group",
  createdAt: new Date().toISOString(),
  name,
});
function writeGroup(dir, base, name, counts) {
  const memberRel = `${base}-deep.json`;
  writeFileSync(path.join(dir, memberRel), JSON.stringify(recording({ counts })));
  const manifest = {
    meta: groupMeta(name),
    iterations: 1,
    warmup: 0,
    headless: true,
    members: [{ mode: "deep", recording: memberRel, createdAt: new Date().toISOString(), annotations: [] }],
    notes: [],
  };
  const manifestPath = path.join(dir, `${base}.group.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

test("assert --format json on a run-group: kind group, the routed member on each row", () => {
  const dir = makeDir();
  const manifest = writeGroup(dir, "grp", "perf-group", { forcedLayoutCount: 4 });
  const { view, status } = runJson([manifest, "--max-forced", "0"]);
  assert.equal(view.kind, "group", "a run-group gate is kind group");
  assert.equal(view.target, "perf-group", "the group name, not a file path");
  assert.ok(Array.isArray(view.notes), "group notes are an array");
  const forced = rowFor(view, "forced layout/style");
  assert.equal(forced.member, "deep", "the row names the member that measured the axis");
  assert.equal(forced.value, 4);
  assert.equal(forced.verdict, "fail", "4 > 0 fails");
  assert.equal(view.passed, false);
  assert.equal(status, 1);
});
