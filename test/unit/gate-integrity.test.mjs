import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countIntegrityRefusal } from "../../dist/model/count-integrity.js";

// F2c / F3: trace-derived counts are known-incomplete on a cross-process split (they cover only the
// busiest thread) or a trace-buffer overflow (dropped events). record() records each as a typed meta
// field; assert/diff read it and REFUSE count thresholds rather than gate an undercount. These tests
// inject the flag through a hand-written recording (no browser, no real overflow needed).

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");

const baseMeta = () => ({
  tool: "wpd",
  version: "0.0.0",
  schemaVersion: "4",
  createdAt: new Date().toISOString(),
  mode: "module",
  target: "probe",
  fn: "default",
  iterations: 1,
  warmup: 0,
  headless: true,
  userDataDir: null,
  lifecycle: [],
  passes: ["deep"],
  notes: [],
  driver: false,
});

// A minimal schema-current recording with a measured layout count, optionally flagged split/dataLoss.
function recording({ split = false, dataLoss = false, layoutCount = 300, wallMs = 10 } = {}) {
  const meta = baseMeta();
  if (split) meta.mainThread = { via: "reanchored", split: true };
  if (dataLoss) meta.dataLoss = { trace: true };
  const counts = {
    layoutCount,
    styleCount: layoutCount,
    paintCount: 5,
    forcedLayoutCount: 2,
    layoutInvalidations: 0,
    styleInvalidations: 0,
    longTaskCount: 0,
  };
  return {
    meta,
    window: { measure: "wpd:run", startTs: 0, endTs: 100, wallMs },
    marks: [],
    events: [],
    summary: {
      wallMs,
      inpMs: null,
      layoutCount,
      layoutMs: null,
      styleCount: layoutCount,
      styleMs: null,
      paintCount: 5,
      paintMs: null,
      layoutInvalidations: 0,
      paintInvalidations: 0,
      styleInvalidations: 0,
      forcedLayoutCount: 2,
      forcedLayoutMs: null,
      longTaskCount: 0,
      longestTaskMs: null,
      jsSelfMs: null,
      totalEvents: 0,
      perIteration: [],
      stats: null,
      perStep: [],
    },
    spans: [{ label: "run", kind: "run", aggregation: "sum", wallMs, counts }],
  };
}

function writeRecording(dir, name, opts) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(recording(opts)));
  return file;
}

const run = (verb, args) =>
  spawnSync(process.execPath, [cli, verb, ...args], { cwd: root, encoding: "utf8" });

test("countIntegrityRefusal: split, dataLoss, and a whole recording", () => {
  assert.match(
    countIntegrityRefusal({ mainThread: { via: "reanchored", split: true } }),
    /split across renderer processes/,
    "a split run's counts are known-incomplete",
  );
  assert.match(
    countIntegrityRefusal({ dataLoss: { trace: true } }),
    /trace buffer overflowed/,
    "a data-loss run's counts are known-incomplete",
  );
  assert.equal(countIntegrityRefusal({}), null, "a whole recording has nothing to refuse");
  assert.equal(
    countIntegrityRefusal({ mainThread: { via: "marker", split: false } }),
    null,
    "a single-process run is whole",
  );
});

test("assert refuses a count threshold on a split recording, loudly (F2c)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-gate-"));
  const file = writeRecording(dir, "split.json", { split: true, layoutCount: 300 });
  const result = run("assert", [file, "--max-layouts", "200"]);
  assert.equal(result.status, 1, `a not-gateable count must fail:\n${result.stdout}`);
  assert.match(result.stdout, /not gateable/, "the row is a loud refusal");
  assert.match(result.stdout, /split across renderer processes/, "and names why");
});

test("assert still gates a timing threshold on a split recording (counts-only refusal)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-gate-"));
  const file = writeRecording(dir, "split.json", { split: true, wallMs: 10 });
  const result = run("assert", [file, "--max-wall", "100"]);
  assert.equal(result.status, 0, `wall rides performance.now, not the trace counts:\n${result.stdout}`);
  assert.doesNotMatch(result.stdout, /not gateable/, "no count refusal when only timing is gated");
});

test("assert refuses a count threshold on a trace-data-loss recording (F3)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-gate-"));
  const file = writeRecording(dir, "loss.json", { dataLoss: true, layoutCount: 300 });
  const result = run("assert", [file, "--max-layouts", "200"]);
  assert.equal(result.status, 1, "dropped events make the count not gateable");
  assert.match(result.stdout, /not gateable/);
  assert.match(result.stdout, /trace buffer overflowed/);
});

test("assert gates counts normally on a whole recording (the refusal is not universal)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-gate-"));
  const file = writeRecording(dir, "clean.json", { layoutCount: 300 });
  const over = run("assert", [file, "--max-layouts", "200"]);
  assert.equal(over.status, 1, "300 > 200 is a normal fail");
  assert.doesNotMatch(over.stdout, /not gateable/, "a whole recording's count is gated, not refused");
  const under = run("assert", [file, "--max-layouts", "500"]);
  assert.equal(under.status, 0, "300 <= 500 passes");
});

test("diff --fail-on-regression refuses when a side has known-incomplete counts (F2c/F3)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-gate-"));
  const base = writeRecording(dir, "base.json", { layoutCount: 300 });
  const split = writeRecording(dir, "cur-split.json", { split: true, layoutCount: 300 });
  const gated = run("diff", [base, split, "--fail-on-regression"]);
  assert.equal(gated.status, 1, "a gate over an undercount must refuse, not fabricate a verdict");
  assert.match(gated.stdout, /known-incomplete counts/);

  // Without the gate, the diff stays advisory: no refusal, no non-zero exit.
  const advisory = run("diff", [base, split]);
  assert.equal(advisory.status, 0, "an advisory diff does not refuse");
  assert.doesNotMatch(advisory.stdout, /Refusing to gate/);
});
