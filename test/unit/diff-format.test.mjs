import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The `diff --format json|toon` CONTRACT: diff.ts serializes a DiffView (two recordings) or a
// GroupDiffView (two run-groups), and a consumer reads the verdict off the view rather than scraping
// the human table. Nothing else parses that shape, so these tests do -- browser-free, driving the
// built CLI against hand-written recordings (the gate-integrity harness). They assert the SHAPE and the
// VALUES, above all the not-measured case: a null on one side must yield delta null / regression false,
// never a fabricated 0 -> 45 regression (the mutant that drops diff.ts's null guard)

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

// A minimal schema-5 recording: the run span is the sole count/timing store diffMetrics reads
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
  return mkdtempSync(path.join(tmpdir(), "wpd-diff-"));
}
function writeRec(dir, name, opts) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(recording(opts)));
  return file;
}
const run = (args) => spawnSync(process.execPath, [cli, "diff", ...args], { cwd: root, encoding: "utf8" });
const runJson = (args) => {
  const result = run([...args, "--format", "json"]);
  assert.ok(result.stdout.trim().length, `diff produced no stdout:\n${result.stderr}`);
  return { view: JSON.parse(result.stdout), status: result.status, stdout: result.stdout };
};
const metricRow = (view, key) => view.metrics.find((metric) => metric.key === key);

test("diff --format json emits the DiffView shape: metric rows keyed/labeled/gated, empty comparability", () => {
  const dir = makeDir();
  const base = writeRec(dir, "base.json", { counts: { layoutCount: 300 } });
  const current = writeRec(dir, "cur.json", { counts: { layoutCount: 350 } });
  const { view, status } = runJson([base, current]);

  assert.equal(status, 0, "an advisory diff exits 0");
  assert.equal(view.baseline, base);
  assert.equal(view.current, current);
  assert.ok(Array.isArray(view.metrics), "metrics is an array");
  assert.deepEqual(view.comparability, [], "identical captures differ on no axis");
  assert.equal(view.failOnRegression, false);
  assert.equal(view.failed, false, "no gate requested, so no failure");

  // Every row carries the documented keys
  for (const metric of view.metrics)
    for (const field of ["key", "label", "gated", "base", "current", "delta", "regression"])
      assert.ok(field in metric, `metric ${metric.key} is missing ${field}`);

  const layout = metricRow(view, "layoutCount");
  assert.equal(layout.label, "layout", "the human label rides the row");
  assert.equal(layout.gated, true, "an exact count gates");
  assert.equal(layout.base, 300);
  assert.equal(layout.current, 350);
  assert.equal(layout.delta, 50, "current - base");
  assert.equal(layout.regression, true, "300 -> 350 worsens a higher-is-worse count");
  assert.ok(
    view.regressions.some((line) => line.includes("layout") && line.includes("350")),
    "the regression is worded on the view",
  );

  // The advisory rows (wall/INP/JS self) never gate and never regress
  for (const key of ["inpMs", "wallMs", "jsSelfMs"]) {
    const advisory = metricRow(view, key);
    assert.equal(advisory.gated, false, `${key} is advisory`);
    assert.equal(advisory.regression, false, `${key} never regresses the build`);
  }
});

// THE MUTANT GUARD: a metric not measured on one side (null) must produce delta null and regression
// false. Dropping diff.ts's null guard would coerce null to 0 and fabricate a 0 -> 45 regression that a
// --fail-on-regression gate would then fail on. base layout is null, current 45
test("diff --format json: a null-on-one-side metric yields delta null, regression false (no fabricated regression)", () => {
  const dir = makeDir();
  const base = writeRec(dir, "base.json", { counts: { layoutCount: null } });
  const current = writeRec(dir, "cur.json", { counts: { layoutCount: 45 } });

  const { view, status } = runJson([base, current]);
  assert.equal(status, 0);
  const layout = metricRow(view, "layoutCount");
  assert.equal(layout.base, null, "base did not measure layout");
  assert.equal(layout.current, 45);
  assert.equal(layout.delta, null, "a null side means no delta, never 45 - 0");
  assert.equal(layout.regression, false, "a not-measured side cannot be a regression");
  assert.ok(
    !view.regressions.some((line) => line.includes("layout")),
    "layout is absent from the regression list",
  );

  // And under the gate it must NOT fail: the guard holds all the way to the exit code
  const gated = runJson([base, current, "--fail-on-regression"]);
  assert.equal(gated.status, 0, "a fabricated regression would exit 1 here; the guard keeps it 0");
  assert.equal(gated.view.failed, false, "the view agrees the gate passed");
  assert.equal(metricRow(gated.view, "layoutCount").regression, false);
});

test("diff --fail-on-regression: the json `failed` flag and exit code match the human report", () => {
  const dir = makeDir();
  const base = writeRec(dir, "base.json", { counts: { layoutCount: 300 } });
  const worse = writeRec(dir, "worse.json", { counts: { layoutCount: 350 } });
  const same = writeRec(dir, "same.json", { counts: { layoutCount: 300 } });

  // A real regression: human and json both exit 1, and the view says failed
  const human = run([base, worse, "--fail-on-regression"]);
  const json = runJson([base, worse, "--fail-on-regression"]);
  assert.equal(human.status, 1, "the human gate fails");
  assert.equal(json.status, 1, "the json gate fails with the same code");
  assert.equal(json.view.failed, true, "the view carries the process verdict");
  assert.equal(metricRow(json.view, "layoutCount").regression, true);

  // No regression: both exit 0, the view says not failed
  const humanOk = run([base, same, "--fail-on-regression"]);
  const jsonOk = runJson([base, same, "--fail-on-regression"]);
  assert.equal(humanOk.status, 0, "no regression, human passes");
  assert.equal(jsonOk.status, 0);
  assert.equal(jsonOk.view.failed, false);
});

test("diff --format json: comparability axes ride the view, and a blocking axis refuses the gate", () => {
  const dir = makeDir();
  const base = writeRec(dir, "base.json", { meta: { capture: "deep" } });
  const current = writeRec(dir, "cur.json", { meta: { capture: "breakdown" } });

  // No gate: the differing capture mode is surfaced as a comparability axis, still exit 0
  const { view, status } = runJson([base, current]);
  assert.equal(status, 0, "cross-capture exploration stays advisory without the gate");
  const axis = view.comparability.find((entry) => entry.axis === "capture-mode");
  assert.ok(axis, "the capture-mode difference is on the view");
  assert.equal(axis.base, "deep");
  assert.equal(axis.current, "breakdown");
  assert.equal(axis.blocksGating, true);

  // With the gate: a blocking axis is a refusal (gateRefusal set, failed true, exit 1), not a verdict
  const gated = runJson([base, current, "--fail-on-regression"]);
  assert.equal(gated.status, 1, "gating across an incompatible capture refuses");
  assert.equal(gated.view.failed, true);
  assert.ok(
    gated.view.gateRefusal && gated.view.gateRefusal.includes("incompatible capture"),
    "the refusal reason rides the view",
  );
});

test("diff --format toon serializes the same view (a non-JSON, key-addressable body)", () => {
  const dir = makeDir();
  const base = writeRec(dir, "base.json", { counts: { layoutCount: 300 } });
  const current = writeRec(dir, "cur.json", { counts: { layoutCount: 350 } });
  const result = run([base, current, "--format", "toon"]);
  assert.equal(result.status, 0);
  assert.throws(() => JSON.parse(result.stdout), "toon is not JSON");
  assert.match(result.stdout, /metrics/, "the metric rows are present");
  assert.match(result.stdout, /layoutCount/, "keyed by the metric key, same data as json");
});


const groupMeta = (name) => ({
  tool: "wpd",
  version: "0.0.0",
  schemaVersion: "5",
  kind: "run-group",
  createdAt: new Date().toISOString(),
  name,
});

// Write a one-member group: a `.group.json` manifest plus its sibling member recording (mode "deep",
// so member.mode matches the recording's meta.capture)
function writeGroup(dir, base, name, layoutCount) {
  const memberRel = `${base}-deep.json`;
  writeFileSync(path.join(dir, memberRel), JSON.stringify(recording({ counts: { layoutCount } })));
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

test("diff --format json on two run-groups emits GroupDiffView: members discriminator + per-pair DiffView", () => {
  const dir = makeDir();
  const baseGroup = writeGroup(dir, "base", "baseline-group", 300);
  const currentGroup = writeGroup(dir, "cur", "current-group", 350);
  const { view, status } = runJson([baseGroup, currentGroup]);

  assert.equal(status, 0, "an advisory group diff exits 0");
  // The `members` field is the discriminator between GroupDiffView and a plain DiffView
  assert.ok(Array.isArray(view.members), "a group diff carries members[]");
  assert.ok(!("metrics" in view), "the top level is a GroupDiffView, not a DiffView");
  assert.equal(view.baseline, "baseline-group", "the group names, not file paths");
  assert.equal(view.current, "current-group");
  assert.equal(view.failOnRegression, false);
  assert.equal(view.failed, false);

  assert.equal(view.members.length, 1, "the single deep member paired");
  const member = view.members[0];
  assert.equal(member.member, "deep", "labeled by capture mode + variant");
  assert.ok(member.diff, "a paired member carries the per-pair DiffView");
  assert.ok(!member.onlyIn, "a paired member is not one-sided");
  // The nested per-pair diff is a full DiffView
  const layout = member.diff.metrics.find((metric) => metric.key === "layoutCount");
  assert.equal(layout.base, 300);
  assert.equal(layout.current, 350);
  assert.equal(layout.delta, 50);
  assert.equal(layout.regression, true);
});
