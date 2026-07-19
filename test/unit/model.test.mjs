import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serialize, deserialize } from "../../dist/output/format.js";
import { stableWorkloadPath } from "../../dist/model/compat.js";
import { diffCmd } from "../../dist/commands/diff.js";
import { cpuDiffCmd } from "../../dist/commands/cpudiff.js";
import { assertCmd } from "../../dist/commands/assert.js";
import { countProvenance } from "../../dist/commands/summaryView.js";
import * as notesCatalog from "../../dist/record/notes.js";
import { assertSchemaVersion } from "../../dist/model/artifact.js";
import { resolveHeadless } from "../../dist/browser/launch.js";
import { SCHEMA_VERSION } from "../../dist/index.js";
import { writeRecording, writeSchemaArtifact, captureExitCode, tmpDir } from "./helpers.mjs";

test("serialize/deserialize round-trips json and toon", () => {
  const obj = { a: 1, b: [{ x: 1 }, { x: 2 }], c: "hi" };
  assert.deepEqual(deserialize(serialize(obj, "json"), ".json"), obj);
  assert.deepEqual(deserialize(serialize(obj, "toon"), ".toon"), obj);
});

test("public entrypoint exposes the schema version anchor", () => {
  assert.equal(SCHEMA_VERSION, "3");
});

// Write-first (§17.13.9 item 5): an artifact stamped with an older schema epoch is REJECTED, loudly,
// with the re-record message -- never mis-parsed against a shape it was not written to.
test("schema reject: an artifact recorded by an older wpd is refused with the re-record message", () => {
  assert.throws(
    () => assertSchemaVersion("2", "/tmp/old.json"),
    /re-record with this version/,
    "a schema-2 artifact is rejected, not silently read as the current shape",
  );
  assert.throws(() => assertSchemaVersion(undefined, "/tmp/nometa.json"), /re-record/);
  // The current epoch passes through untouched.
  assert.doesNotThrow(() => assertSchemaVersion(SCHEMA_VERSION, "/tmp/current.json"));
});

// The reject reaches through the verbs, not only the pure guard: `assert` on a schema-2 recording
// refuses rather than gating a mis-parsed (all-null) summary green.
test("schema reject: `assert` on an older-schema recording refuses instead of mis-gating", async () => {
  const old = writeSchemaArtifact("assert-old-schema.json", "2", { forcedLayoutCount: 0 });
  await assert.rejects(() => assertCmd(old, { forced: 0 }), /re-record with this version/);
});

test("package exports map points at files that exist", () => {
  const pkgUrl = new URL("../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
  const root = pkg.exports["."];
  for (const target of [root.types, root.import]) {
    const resolved = fileURLToPath(new URL(target, pkgUrl));
    assert.doesNotThrow(() => readFileSync(resolved), `missing exports target ${target}`);
  }
});

// S09: `changeset version` bumps package.json, but `npm ci` never rewrites the lockfile, so the
// lock's own version field drifts behind the manifest until someone runs a plain `npm install`. A
// published tarball whose lock says an old version is confusing at best. Guard the two together.
test("package-lock version tracks package.json version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.version, pkg.version, "package-lock.json root version is stale; run `npm install`");
  assert.equal(
    lock.packages[""].version,
    pkg.version,
    'package-lock.json packages[""] version is stale; run `npm install`',
  );
});

test("published types declare the documented public shapes", () => {
  const dts = readFileSync(new URL("../../dist/index.d.ts", import.meta.url), "utf8");
  // StepTiming is the element type of the public RecordingSummary.perStep: without it a consumer
  // cannot name the shape without importing from dist/model/, which this package calls internal.
  for (const name of ["CpuModel", "CpuOverview", "BlameEntry", "CpuDiffResult", "RawCpuProfile", "LastPointer", "StepTiming"]) {
    assert.match(dts, new RegExp(`\\b${name}\\b`), `index.d.ts should re-export ${name}`);
  }
});

// --- Count provenance (the same number means different things per target) ---

test("countProvenance distinguishes exact trace counts, Gecko markers, and a rung that measured none", () => {
  const recording = (meta, summary = {}) => ({ meta: { passes: ["default"], ...meta }, summary });

  // Chrome with a trace (breakdown/deep): counts come from the trace, main-thread windowed, exact.
  const exact = countProvenance(recording({ passes: ["deep"] }, { layoutCount: 5 }));
  assert.match(exact, /exact/);
  assert.doesNotMatch(exact, /NOT measured/);

  // Firefox + gecko pass: counts from Reflow/Styles markers -- real, but batched by a different
  // engine, so they must not read as comparable to Chrome.
  const gecko = countProvenance(recording({ browser: "firefox", passes: ["gecko"] }, { layoutCount: 3 }));
  assert.match(gecko, /Gecko markers/);
  assert.match(gecko, /not comparable to Chrome/);

  // The default rung captures no trace: layoutCount is null, so the header says NOT measured, never 0.
  const none = countProvenance(recording({ passes: ["default"] }, { layoutCount: null }));
  assert.match(none, /NOT measured/);
});

// F26/F27: a lost run:end mark leaves the bar silently absent, and a lost step:end mark left counts
// running to trace end while the bar stopped at the run end. Both now push a disclosing note.
test("notes: a lost run-end / step-end mark is disclosed, not silent (F26/F27)", () => {
  const runEnd = notesCatalog.runEndMarkLost();
  assert.match(runEnd, /wpd:run:end was lost/);
  assert.match(runEnd, /Counts remain valid/);
  assert.match(runEnd, /bar/); // the bar is absent, not 0

  const stepEnd = notesCatalog.stepEndMarkLost();
  assert.match(stepEnd, /wpd:step:N:end/);
  assert.match(stepEnd, /window to the run end/);
  assert.match(stepEnd, /page-clock/); // the wall stayed page-clock, does not reconcile with the bar
});

// F4: on a no-trace --url boot, --iterations produces no wall and no median (the navigating load step
// resets the page clock, and the rung has no trace clock to span it). The note must say so plainly and
// point to --breakdown, rather than the warm/cold note promising a median (`stats`) that is not there.
test("notes: the no-median on-ramp note names iterations and steers to --breakdown (F4)", () => {
  const note = notesCatalog.onrampIterationsNoMedian(3);
  assert.match(note, /--iterations 3/);
  assert.match(note, /no per-iteration wall or median/);
  assert.match(note, /--breakdown/);
  // The warm/cold note, by contrast, DOES describe a wall median, so it must only fire where a wall
  // exists -- the two are mutually exclusive by rung (record.ts picks by pass.stepWallClock).
  assert.match(notesCatalog.onrampWarmVsCold(3), /median/);
});

// F31: a diff across incompatible captures subtracts numbers that do not describe the same thing.
// Write recordings with explicit meta (browser/passes/iterations) to exercise the comparability gate.
function writeRecMeta(name, metaOverrides, summaryOverrides = {}) {
  const summary = {
    wallMs: null, inpMs: null, scriptingMs: 0,
    layoutCount: 0, styleCount: 0, paintCount: 0,
    forcedLayoutCount: 0, layoutInvalidations: 0, paintInvalidations: 0, styleInvalidations: 0,
    longTaskCount: 0, totalEvents: 0, perIteration: [], stats: null,
    ...summaryOverrides,
  };
  const meta = { schemaVersion: "3", passes: ["deep"], driver: false, iterations: 5, ...metaOverrides };
  const file = path.join(tmpDir, name);
  writeFileSync(file, JSON.stringify({ meta, summary, spans: [] }), "utf8");
  return file;
}

// Run diffCmd capturing BOTH its exit code and its console output (captureExitCode silences logs).
async function runDiffCapture(base, current, opts) {
  const priorExit = process.exitCode;
  const priorLog = console.log;
  const logs = [];
  process.exitCode = undefined;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await diffCmd(base, current, opts);
    return { code: process.exitCode, logs };
  } finally {
    console.log = priorLog;
    process.exitCode = priorExit;
  }
}

test("diff: matched captures compare cleanly and gate a real count regression (F31)", async () => {
  const base = writeRecMeta("f31-match-base.json", {}, { layoutCount: 1 });
  const current = writeRecMeta("f31-match-cur.json", {}, { layoutCount: 9 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.equal(code, 1, "a real layout regression on matched captures still gates");
  assert.ok(!logs.some((line) => /captured differently/.test(line)), "no comparability warning when matched");
});

// R04: run counts TOTAL across iterations (one pass runs every iteration), so iters 1 vs 5 makes
// every count differ by the iteration factor. Gating across that fabricates "regressions", so an
// iterations mismatch now REFUSES the gate rather than warning-and-comparing.
test("diff: an iterations mismatch REFUSES the gate (R04)", async () => {
  const base = writeRecMeta("r04-iter-base.json", { iterations: 5 }, { layoutCount: 1 });
  const current = writeRecMeta("r04-iter-cur.json", { iterations: 50 }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.ok(logs.some((line) => /iterations: 5 → 50/.test(line)), "the iterations mismatch is disclosed");
  assert.ok(logs.some((line) => /Refusing to gate/.test(line)));
  assert.equal(code, 1, "counts total across iterations, so gating across a count mismatch refuses");
});

// R05: the compat signature also covers workload (the recorded module/page), headless flavour, and
// cpu-throttle, all of which shift the numbers the gate reads.
test("diff: a workload (target) mismatch REFUSES the gate (R05)", async () => {
  const base = writeRecMeta("r05-work-base.json", { target: "a.mjs" }, { layoutCount: 1 });
  const current = writeRecMeta("r05-work-cur.json", { target: "b.mjs" }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.ok(logs.some((line) => /workload: a\.mjs → b\.mjs/.test(line)), "the workload mismatch is disclosed");
  assert.ok(logs.some((line) => /Refusing to gate/.test(line)));
  assert.equal(code, 1, "diffing two different flows must not gate silently");
});

// T02: `target` collapses host and module (a host page overwrites the module), so a structured
// workload identity {lane,host,module} is the axis the gate compares. Different flow = different
// workload, even against the same host page.
const workload = (lane, host, module) => ({ workload: { lane, host, module } });

test("diff: the built-in load flow and a driver module on ONE host REFUSE the gate (T02)", async () => {
  const base = writeRecMeta("t02-onramp.json", { target: "host.html", driver: true, ...workload("builtin-load", "host.html", null) }, { layoutCount: 1 });
  const current = writeRecMeta("t02-driver.json", { target: "host.html", driver: true, ...workload("driver", "host.html", "flow.mjs") }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.ok(logs.some((line) => /workload: builtin-load .* module=null → driver .* module="flow\.mjs"/.test(line)), "the lane+module mismatch is disclosed, not hidden behind a shared target");
  assert.ok(logs.some((line) => /Refusing to gate/.test(line)));
  assert.equal(code, 1, "two different programs against one host must not gate silently");
});

test("diff: a host-only difference (same lane+module) REFUSES the gate (T02)", async () => {
  const base = writeRecMeta("t02-host-a.json", { target: "one.html", driver: true, ...workload("driver", "one.html", "flow.mjs") }, { layoutCount: 1 });
  const current = writeRecMeta("t02-host-b.json", { target: "two.html", driver: true, ...workload("driver", "two.html", "flow.mjs") }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.ok(logs.some((line) => /host="one\.html" .* → .*host="two\.html"/.test(line)), "the host page is a gated axis in its own right");
  assert.equal(code, 1, "the same module against a different host is a different workload");
});

test("diff: the node lane (blank host) gates two different modules (T02)", async () => {
  const base = writeRecMeta("t02-node-a.json", { target: "a.mjs", runtime: "node", passes: ["node-cpu"], ...workload("node", null, "a.mjs") }, { layoutCount: 1 });
  const current = writeRecMeta("t02-node-b.json", { target: "b.mjs", runtime: "node", passes: ["node-cpu"], ...workload("node", null, "b.mjs") }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.ok(logs.some((line) => /workload: node host=null module="a\.mjs" → node host=null module="b\.mjs"/.test(line)), "a null host prints as bare null, distinct from a file named 'null'");
  assert.equal(code, 1);
});

test("diff: two DIFFERENT driver modules on ONE host REFUSE the gate (T02)", async () => {
  const base = writeRecMeta("t02-modA.json", { target: "host.html", driver: true, ...workload("driver", "host.html", "a.mjs") }, { layoutCount: 1 });
  const current = writeRecMeta("t02-modB.json", { target: "host.html", driver: true, ...workload("driver", "host.html", "b.mjs") }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.ok(logs.some((line) => /module="a\.mjs" → .*module="b\.mjs"/.test(line)));
  assert.equal(code, 1, "a different module against the same host is a different workload");
});

test("diff: driver vs --bench of ONE module+host REFUSE the gate (T02, different lane)", async () => {
  const base = writeRecMeta("t02-drv.json", { target: "host.html", driver: true, ...workload("driver", "host.html", "flow.mjs") }, { layoutCount: 1 });
  const current = writeRecMeta("t02-bench.json", { target: "host.html", driver: false, ...workload("bench", "host.html", "flow.mjs") }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.ok(logs.some((line) => /workload: driver .* → bench /.test(line)), "the lane change is disclosed");
  assert.equal(code, 1, "the same module driven vs import()'d in-page measures different work");
});

test("diff: the SAME structured workload gates a real regression, not the workload (T02)", async () => {
  const base = writeRecMeta("t02-same-base.json", { target: "host.html", driver: true, ...workload("driver", "host.html", "flow.mjs") }, { layoutCount: 1 });
  const regressed = writeRecMeta("t02-same-cur.json", { target: "host.html", driver: true, ...workload("driver", "host.html", "flow.mjs") }, { layoutCount: 9 });
  const regression = await runDiffCapture(base, regressed, { failOnRegression: true });
  assert.ok(!regression.logs.some((line) => /workload/.test(line)), "no workload warning when lane+host+module match");
  assert.equal(regression.code, 1, "a real count regression on the same workload still gates");

  const clean = writeRecMeta("t02-same-clean.json", { target: "host.html", driver: true, ...workload("driver", "host.html", "flow.mjs") }, { layoutCount: 1 });
  const pass = await runDiffCapture(base, clean, { failOnRegression: true });
  assert.equal(pass.code, undefined, "an identical workload with no count change passes the gate");
});

// T02 backward compat: two pre-identity recordings (no `workload`) still compare on `target`; a
// structured-vs-absent pair cannot verify the flow, so it WARNS under "workload-identity" rather than
// blocking (refusing every gate against a pre-upgrade baseline would be heavier than the risk).
test("diff: two pre-identity recordings fall back to the target comparison (T02)", async () => {
  const base = writeRecMeta("t02-old-a.json", { target: "a.mjs" }, { layoutCount: 1 });
  const current = writeRecMeta("t02-old-b.json", { target: "b.mjs" }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.ok(logs.some((line) => /workload: a\.mjs → b\.mjs/.test(line)), "old artifacts still compare on target");
  assert.equal(code, 1, "a target mismatch on old artifacts still refuses");
});

test("diff: a structured-vs-absent pair WARNS but does not block (T02)", async () => {
  const structured = writeRecMeta("t02-mixed-new.json", { target: "host.html", driver: true, ...workload("driver", "host.html", "flow.mjs") }, { layoutCount: 1 });
  const old = writeRecMeta("t02-mixed-old.json", { target: "host.html" }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(structured, old, { failOnRegression: true });
  assert.ok(logs.some((line) => /workload-identity: .* → pre-identity\(host\.html\)/.test(line)), "the unverifiable identity is disclosed honestly");
  assert.ok(!logs.some((line) => /Refusing to gate/.test(line)), "a pre-upgrade baseline is not blocked on a provenance technicality");
  assert.equal(code, undefined, "the mixed pair warns but still compares");
});

test("diff: headless-flavour and cpu-throttle mismatches REFUSE the gate (R05)", async () => {
  const headlessBase = writeRecMeta("r05-hl-base.json", { headless: true, headlessMode: "shell" }, { layoutCount: 1 });
  const headlessCur = writeRecMeta("r05-hl-cur.json", { headless: true, headlessMode: "new" }, { layoutCount: 1 });
  const headless = await runDiffCapture(headlessBase, headlessCur, { failOnRegression: true });
  assert.ok(headless.logs.some((line) => /headless: shell → new/.test(line)));
  assert.equal(headless.code, 1, "a frame-cadence flavour change refuses (frame-floor)");

  const throttleBase = writeRecMeta("r05-thr-base.json", { throttle: { cpuRate: 1 } }, { layoutCount: 1 });
  const throttleCur = writeRecMeta("r05-thr-cur.json", { throttle: { cpuRate: 4 } }, { layoutCount: 1 });
  const throttle = await runDiffCapture(throttleBase, throttleCur, { failOnRegression: true });
  assert.ok(throttle.logs.some((line) => /cpu-throttle: 1x → 4x/.test(line)));
  assert.equal(throttle.code, 1, "an artificial slowdown change refuses");
});

// R05: warmup and the sampler interval move sampling noise / steady-state, not the gated exact
// counts, so they WARN but still compare.
test("diff: warmup and sampler-interval mismatches WARN but still compare (R05)", async () => {
  const warmupBase = writeRecMeta("r05-warm-base.json", { warmup: 0 }, { layoutCount: 1 });
  const warmupCur = writeRecMeta("r05-warm-cur.json", { warmup: 3 }, { layoutCount: 1 });
  const warmup = await runDiffCapture(warmupBase, warmupCur, { failOnRegression: true });
  assert.ok(warmup.logs.some((line) => /warmup: 0 → 3/.test(line)), "the warmup mismatch is disclosed");
  assert.equal(warmup.code, undefined, "warmup alone does not refuse the gate");

  const intervalBase = writeRecMeta("r05-int-base.json", { cpuIntervalUs: 200 }, { layoutCount: 1 });
  const intervalCur = writeRecMeta("r05-int-cur.json", { cpuIntervalUs: 50 }, { layoutCount: 1 });
  const interval = await runDiffCapture(intervalBase, intervalCur, { failOnRegression: true });
  assert.ok(interval.logs.some((line) => /sampler-interval: 200us → 50us/.test(line)));
  assert.equal(interval.code, undefined, "the sampler interval alone does not refuse the gate");
});

test("diff: --fail-on-regression REFUSES across a mismatched rung/browser (F31)", async () => {
  const base = writeRecMeta("f31-refuse-base.json", { passes: ["deep"], browser: undefined }, { layoutCount: 1 });
  const current = writeRecMeta("f31-refuse-cur.json", { passes: ["gecko"], browser: "firefox" }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.equal(code, 1, "gating across an incompatible browser/rung refuses");
  assert.ok(logs.some((line) => /Refusing to gate/.test(line)));
  assert.ok(logs.some((line) => /browser/.test(line) && /rung/.test(line)));
});

// R05: cpu-diff had NO comparability check. It joins per-function self-time across two models as if
// they measured the same JS; a workload/lane mismatch makes that a fabricated delta. It now warns
// always and REFUSES a --fail-on-regression gate across browser/runtime/workload.
function writeCpuModel(name, metaOverrides, scriptingMs) {
  const meta = { schemaVersion: "3", passes: ["default"], iterations: 1, target: "a.mjs", ...metaOverrides };
  const model = {
    profile: "x.cpuprofile", meta, scriptingMs, totalMs: scriptingMs,
    sampleCount: 1, sampleIntervalUs: 200, system: { idleMs: 0, gcMs: 0, programMs: 0 },
    functions: [{ id: 0, fn: "run", source: "a.mjs:1", file: "a.mjs", package: "app", selfMs: scriptingMs, totalMs: scriptingMs, selfPct: 100 }],
    edges: [],
  };
  const file = path.join(tmpDir, name);
  writeFileSync(file, JSON.stringify(model), "utf8");
  return file;
}

async function runCpuDiffCapture(base, current, opts) {
  const priorExit = process.exitCode;
  const priorLog = console.log;
  const priorErr = console.error;
  const logs = [];
  const errs = [];
  process.exitCode = undefined;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errs.push(args.join(" "));
  try {
    await cpuDiffCmd(base, current, opts);
    return { code: process.exitCode, logs, errs };
  } finally {
    console.log = priorLog;
    console.error = priorErr;
    process.exitCode = priorExit;
  }
}

test("cpu-diff: --fail-on-regression REFUSES across a workload/browser/runtime mismatch (R05)", async () => {
  const base = writeCpuModel("cpudiff-work-base.cpu.json", { target: "a.mjs" }, 10);
  const current = writeCpuModel("cpudiff-work-cur.cpu.json", { target: "b.mjs" }, 10);
  const { code, errs } = await runCpuDiffCapture(base, current, { failOnRegression: true });
  assert.equal(code, 1, "gating two different workloads refuses");
  assert.ok(errs.some((line) => /Refusing to gate/.test(line)));
  assert.ok(errs.some((line) => /workload: a\.mjs → b\.mjs/.test(line)));
});

test("cpu-diff: two different structured workloads on one host REFUSE the gate (T02)", async () => {
  const base = writeCpuModel("cpudiff-t02-base.cpu.json", { target: "host.html", ...workload("driver", "host.html", "a.mjs") }, 10);
  const current = writeCpuModel("cpudiff-t02-cur.cpu.json", { target: "host.html", ...workload("driver", "host.html", "b.mjs") }, 10);
  const { code, errs } = await runCpuDiffCapture(base, current, { failOnRegression: true });
  assert.ok(errs.some((line) => /module="a\.mjs" → .*module="b\.mjs"/.test(line)));
  assert.equal(code, 1, "self-time joined across two different modules is a fabricated delta");
});

test("cpu-diff: a structured-vs-absent pair WARNS but does not block (T02)", async () => {
  const structured = writeCpuModel("cpudiff-t02-mixed-new.cpu.json", { target: "host.html", ...workload("driver", "host.html", "a.mjs") }, 10);
  const old = writeCpuModel("cpudiff-t02-mixed-old.cpu.json", { target: "host.html" }, 10);
  const { code, errs } = await runCpuDiffCapture(structured, old, { failOnRegression: true });
  assert.ok(errs.some((line) => /workload-identity/.test(line)), "the unverifiable identity is disclosed");
  assert.ok(!errs.some((line) => /Refusing to gate/.test(line)), "a pre-upgrade baseline is not blocked");
  assert.equal(code, undefined, "the mixed pair warns but still compares");
});

test("cpu-diff: a rung mismatch WARNS but still compares (not a cpu-diff blocker) (R05)", async () => {
  const base = writeCpuModel("cpudiff-warn-base.cpu.json", { passes: ["default"] }, 10);
  const current = writeCpuModel("cpudiff-warn-cur.cpu.json", { passes: ["breakdown"] }, 10);
  const { code, errs } = await runCpuDiffCapture(base, current, { failOnRegression: true });
  assert.ok(errs.some((line) => /captured differently/.test(line)), "the mismatch is disclosed");
  assert.ok(!errs.some((line) => /Refusing to gate/.test(line)), "the rung does not block cpu-diff");
  assert.equal(code, undefined, "equal self-time, and the rung does not refuse the gate");
});

// F02: CPU self-time TOTALS across every sampled iteration and STRETCHES under cpu-throttle, so a
// same-workload pair differing only on those axes would fabricate a self-time "regression". Both
// must REFUSE a cpu-diff gate, not merely warn.
test("cpu-diff: an iterations mismatch REFUSES the gate (F02)", async () => {
  const base = writeCpuModel("cpudiff-iter-base.cpu.json", { iterations: 1 }, 58);
  const current = writeCpuModel("cpudiff-iter-cur.cpu.json", { iterations: 4 }, 165);
  const { code, errs } = await runCpuDiffCapture(base, current, { failOnRegression: true });
  assert.equal(code, 1, "self-time totals across iterations, so gating across a mismatch refuses");
  assert.ok(errs.some((line) => /Refusing to gate/.test(line)));
  assert.ok(errs.some((line) => /iterations: 1 → 4/.test(line)), "the iterations mismatch is disclosed");
});

test("cpu-diff: a cpu-throttle mismatch REFUSES the gate (F02)", async () => {
  const base = writeCpuModel("cpudiff-thr-base.cpu.json", { throttle: { cpuRate: 1 } }, 10);
  const current = writeCpuModel("cpudiff-thr-cur.cpu.json", { throttle: { cpuRate: 4 } }, 30);
  const { code, errs } = await runCpuDiffCapture(base, current, { failOnRegression: true });
  assert.equal(code, 1, "throttling stretches the self-time clock, so gating across it refuses");
  assert.ok(errs.some((line) => /Refusing to gate/.test(line)));
  assert.ok(errs.some((line) => /cpu-throttle: 1x → 4x/.test(line)), "the throttle mismatch is disclosed");
});

test("cpu-diff: an iterations/throttle mismatch WARNS but exits 0 without the gate flag (F02)", async () => {
  const base = writeCpuModel("cpudiff-nogate-base.cpu.json", { iterations: 1, throttle: { cpuRate: 1 } }, 58);
  const current = writeCpuModel("cpudiff-nogate-cur.cpu.json", { iterations: 4, throttle: { cpuRate: 4 } }, 165);
  const { code, errs } = await runCpuDiffCapture(base, current, {});
  assert.ok(errs.some((line) => /captured differently/.test(line)), "the mismatch is still disclosed");
  assert.ok(!errs.some((line) => /Refusing to gate/.test(line)), "no gate flag, so nothing to refuse");
  assert.equal(code, undefined, "without --fail-on-regression the mismatch only warns");
});

test("diff: advisory wall/INP/scripting deltas do NOT fail the gate (H1)", async () => {
  const baseline = writeRecording("base-advisory.json", { wallMs: 10, inpMs: 5, scriptingMs: 20 });
  const current = writeRecording("cur-advisory.json", { wallMs: 99, inpMs: 88, scriptingMs: 77 });
  const code = await captureExitCode(() => diffCmd(baseline, current, { failOnRegression: true }));
  assert.equal(code, undefined); // coarse metrics regressed, but they are advisory-only
});

test("diff: a real CDP count regression DOES fail the gate", async () => {
  const baseline = writeRecording("base-count.json", { layoutCount: 1 });
  const current = writeRecording("cur-count.json", { layoutCount: 9 });
  const code = await captureExitCode(() => diffCmd(baseline, current, { failOnRegression: true }));
  assert.equal(code, 1);
});

test("assert: a threshold on a not-measured metric FAILS (does not silently pass)", async () => {
  const rec = writeRecording("assert-null-inp.json", { inpMs: null });
  const code = await captureExitCode(() => assertCmd(rec, { inp: 100 }));
  assert.equal(code, 1);
});

test("assert: a satisfied threshold on a measured metric passes", async () => {
  const rec = writeRecording("assert-ok.json", { forcedLayoutCount: 0 });
  const code = await captureExitCode(() => assertCmd(rec, { forced: 0 }));
  assert.equal(code, undefined);
});

// --breakdown reports forced as null (not measured). A gate on it must FAIL loudly, exactly like
// --max-inp on a run with no interaction, never silently pass on a fake 0.
test("assert: --max-forced on a breakdown recording (forced null) FAILS, not silently passes", async () => {
  const rec = writeRecording("assert-null-forced.json", { forcedLayoutCount: null });
  const code = await captureExitCode(() => assertCmd(rec, { forced: 0 }));
  assert.equal(code, 1);
});

// browser/harness.ts and browser/driver.ts serialize into page.evaluate and run in the browser, so
// they CANNOT import model/marks.ts -- nothing from Node's module graph exists there. Their wpd:*
// literals are duplicated out of necessity; this pins those copies to the canonical constants, so a
// rename of a constant fails here until the serialized literals follow.
test("page-serialized mark literals match the canonical constants (the serialization boundary forces the copy)", async () => {
  const marks = await import("../../dist/model/marks.js");
  const harness = await readFile(new URL("../../src/browser/harness.ts", import.meta.url), "utf8");
  const driver = await readFile(new URL("../../src/browser/driver.ts", import.meta.url), "utf8");

  // Run-level marks: both serialized files emit them verbatim.
  for (const [name, source] of [["harness", harness], ["driver", driver]]) {
    assert.ok(source.includes(`"${marks.RUN_START_MARK}"`), `${name} emits ${marks.RUN_START_MARK}`);
    assert.ok(source.includes(`"${marks.RUN_END_MARK}"`), `${name} emits ${marks.RUN_END_MARK}`);
  }
  // The run measure spans [start,end] and lives in the harness.
  assert.ok(harness.includes(`"${marks.RUN_MEASURE}"`), "harness measures the run window");

  // Step edge marks: the driver builds them off the canonical wpd:step: base (stepMark(index)).
  const stepBase = marks.stepMark("${stepMark}"); // "wpd:step:${stepMark}", the driver's template
  assert.ok(driver.includes(`\`${stepBase}:start\``), "driver's step start edge is the canonical base");
  assert.ok(driver.includes(`\`${stepBase}:end\``), "driver's step end edge is the canonical base");
});

// The docs/dev/facts.md ledger pins each load-bearing measured number to the files that cite it.
// This reads the table and asserts every listed file still contains the fact's distinctive string,
// so changing a number in one place and not the others fails here. Match distinctive strings scoped
// to the listed files, which catches drift without spurious failures.
test("facts.md ledger: every cited file still agrees with the ledger value", async () => {
  const ledger = await readFile(new URL("../../docs/dev/facts.md", import.meta.url), "utf8");
  const rows = ledger
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    // a table row splits to ["", fact, value, testString, anchor, citedIn, ""]
    .filter((cells) => cells.length >= 7)
    // drop the header row and the "--- | ---" separator
    .filter((cells) => cells[1] !== "Fact" && !/^-+$/.test(cells[1]));

  assert.ok(rows.length >= 10, `expected the ledger's facts, parsed ${rows.length}`);

  const fileCache = new Map();
  const readCited = async (relPath) => {
    if (!fileCache.has(relPath))
      fileCache.set(relPath, await readFile(new URL(`../../${relPath}`, import.meta.url), "utf8"));
    return fileCache.get(relPath);
  };

  for (const cells of rows) {
    const fact = cells[1];
    const testString = cells[3].replace(/`/g, "");
    const citedIn = cells[5]
      .split(",")
      .map((path) => path.replace(/`/g, "").trim())
      .filter(Boolean);
    assert.ok(citedIn.length > 0, `fact "${fact}" lists no cited files`);
    for (const relPath of citedIn) {
      const source = await readCited(relPath);
      assert.ok(
        source.includes(testString),
        `fact "${fact}": ${relPath} no longer contains "${testString}" (ledger and code disagree)`,
      );
    }
  }
});

test("resolveHeadless: defaults to chrome-headless-shell, new-headless is opt-in, headed wins", () => {
  // No flavour passed => shell (the ~120Hz default); explicit "shell" too.
  assert.equal(resolveHeadless(true, undefined), "shell", "default headless flavour is shell");
  assert.equal(resolveHeadless(true, "shell"), "shell");
  // "new" opts back into full-Chrome new-headless (puppeteer's `headless: true`).
  assert.equal(resolveHeadless(true, "new"), true);
  // Headed (--no-headless) wins regardless of the flavour.
  assert.equal(resolveHeadless(false, undefined), false);
  assert.equal(resolveHeadless(false, "shell"), false);
  assert.equal(resolveHeadless(false, "new"), false);
});

test("stableWorkloadPath: spelling and cwd variants of one module join as one workload", () => {
  const root = "/repo";
  assert.equal(stableWorkloadPath(root, "examples/foo.mjs"), "examples/foo.mjs");
  assert.equal(stableWorkloadPath(root, "./examples/foo.mjs"), "examples/foo.mjs");
  assert.equal(stableWorkloadPath(root, "/repo/examples/foo.mjs"), "examples/foo.mjs");
  assert.equal(
    stableWorkloadPath(root, "/elsewhere/foo.mjs"),
    "/elsewhere/foo.mjs",
    "outside the root stays absolute",
  );
});
