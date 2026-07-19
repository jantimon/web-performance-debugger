import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serialize, deserialize } from "../../dist/output/format.js";
import { diffCmd } from "../../dist/commands/diff.js";
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

test("diff: an iterations mismatch WARNS but still compares (F31)", async () => {
  const base = writeRecMeta("f31-iter-base.json", { iterations: 5 }, { layoutCount: 1 });
  const current = writeRecMeta("f31-iter-cur.json", { iterations: 50 }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.ok(logs.some((line) => /captured differently/.test(line)), "the iterations mismatch is disclosed");
  assert.ok(logs.some((line) => /iterations: 5 → 50/.test(line)));
  assert.equal(code, undefined, "iterations alone does not refuse the gate (counts do not scale with it)");
});

test("diff: --fail-on-regression REFUSES across a mismatched rung/browser (F31)", async () => {
  const base = writeRecMeta("f31-refuse-base.json", { passes: ["deep"], browser: undefined }, { layoutCount: 1 });
  const current = writeRecMeta("f31-refuse-cur.json", { passes: ["gecko"], browser: "firefox" }, { layoutCount: 1 });
  const { code, logs } = await runDiffCapture(base, current, { failOnRegression: true });
  assert.equal(code, 1, "gating across an incompatible browser/rung refuses");
  assert.ok(logs.some((line) => /Refusing to gate/.test(line)));
  assert.ok(logs.some((line) => /browser/.test(line) && /rung/.test(line)));
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
