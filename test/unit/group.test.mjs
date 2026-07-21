import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formationVerdict,
  pickMember,
  countDisagreements,
  partialGroupNotes,
} from "../../dist/model/group.js";
import { preflightGroup, appendMember } from "../../dist/record/group.js";
import { readFileSync } from "node:fs";
import {
  assertGroupArtifact,
  assertRecordingArtifact,
  assertSchemaVersion,
} from "../../dist/model/artifact.js";
import { resolveConsumption, writePointer } from "../../dist/commands/resolve.js";
import { SCHEMA_VERSION } from "../../dist/schema.js";

// A minimal RecordingMeta with the axes comparabilityMismatches reads; `over` tweaks one arm.
const meta = (over = {}) => ({
  tool: "wpd",
  version: "0",
  schemaVersion: SCHEMA_VERSION,
  createdAt: "",
  mode: "module",
  target: "a.mjs",
  workload: { lane: "bench", host: null, module: "a.mjs" },
  fn: "run",
  iterations: 5,
  warmup: 1,
  headless: true,
  headlessMode: "shell",
  cpuIntervalUs: 150,
  userDataDir: null,
  lifecycle: [],
  passes: ["breakdown"],
  notes: [],
  driver: false,
  ...over,
});

const group = (modes) => ({
  meta: { tool: "wpd", version: "0", schemaVersion: SCHEMA_VERSION, kind: "run-group", createdAt: "", name: "g" },
  iterations: 5,
  warmup: 1,
  headless: true,
  members: modes.map((mode) => ({ mode, recording: `${mode}.json`, createdAt: "", annotations: [] })),
  notes: [],
});

test("formationVerdict: a differing capture mode joins; a differing gating axis refuses", () => {
  // breakdown reference, deep joining: only the capture mode (and the sampler interval) differ. The
  // mode is the group's purpose, so it does not refuse; the interval annotates rather than blocks.
  const verdict = formationVerdict(meta(), meta({ passes: ["deep"], cpuIntervalUs: 200 }), [
    { mode: "breakdown" },
  ]);
  assert.deepEqual(verdict.refusals, [], "a capture-mode difference does not refuse");
  assert.ok(
    verdict.annotations.some((note) => note.includes("sampler-interval")),
    "a sampler-interval difference annotates",
  );

  // A differing gating axis (iterations) refuses.
  const refused = formationVerdict(meta(), meta({ passes: ["deep"], iterations: 3 }), [
    { mode: "breakdown" },
  ]);
  assert.ok(
    refused.refusals.some((reason) => reason.startsWith("iterations")),
    "a differing iterations refuses the join",
  );
});

test("formationVerdict: a duplicate (mode, variant) pair is refused", () => {
  const verdict = formationVerdict(meta(), meta({ passes: ["breakdown"] }), [{ mode: "breakdown" }]);
  assert.ok(
    verdict.refusals.some((reason) => reason.includes("duplicate member")),
    "a second breakdown member is a duplicate, not a second question",
  );
  // Same mode, DIFFERENT variant is allowed (future cross-variant groups stay legal).
  const distinct = formationVerdict(
    meta({ variant: "b" }),
    meta({ passes: ["breakdown"], variant: "b2" }),
    [{ mode: "breakdown", variant: "b" }],
  );
  // variant differs -> a gating refusal (variant blocks), but NOT the duplicate refusal.
  assert.ok(
    !distinct.refusals.some((reason) => reason.includes("duplicate member")),
    "a different variant is not a duplicate",
  );
});

test("pickMember: routes each axis to the member that measures it", () => {
  const both = group(["breakdown", "deep"]);
  assert.equal(pickMember(both, "slice-bar").mode, "breakdown", "bar -> breakdown");
  assert.equal(pickMember(both, "cpu").mode, "breakdown", "cpu -> breakdown");
  assert.equal(pickMember(both, "forced").mode, "deep", "forced -> deep");
  assert.equal(pickMember(both, "blame").mode, "deep", "blame -> deep");
  assert.equal(pickMember(both, "counts").mode, "deep", "counts -> deep (preferred)");
  assert.ok(pickMember(both, "inp"), "inp -> any member");

  // A breakdown-only group has no deep member: forced/blame route to nobody (a loud gap upstream).
  const barOnly = group(["breakdown"]);
  assert.equal(pickMember(barOnly, "forced"), null, "no deep member -> no forced answer");
  assert.equal(pickMember(barOnly, "counts").mode, "breakdown", "counts fall back to breakdown");

  // A deep-only group has no CPU-bearing member: cpu/bar route to nobody.
  const deepOnly = group(["deep"]);
  assert.equal(pickMember(deepOnly, "cpu"), null, "deep runs no sampler -> no cpu answer");
  assert.equal(pickMember(deepOnly, "slice-bar"), null, "deep builds no bar");
  assert.equal(pickMember(deepOnly, "forced").mode, "deep", "forced -> deep");

  // A firefox gecko member carries the event log (markers + sampled read-site blame) AND CPU samples,
  // so a single-member gecko group answers blame, counts, cpu, and the bar from that one pass.
  const gecko = group(["gecko"]);
  assert.equal(pickMember(gecko, "blame").mode, "gecko", "a plain gecko member answers blame");
  assert.equal(pickMember(gecko, "forced").mode, "gecko", "and forced");
  assert.equal(pickMember(gecko, "counts").mode, "gecko", "and counts");
  assert.equal(pickMember(gecko, "cpu").mode, "gecko", "and cpu");
});

test("countDisagreements: surfaces both values when members disagree, silent when they agree", () => {
  const disagree = countDisagreements([
    { label: "breakdown", counts: { layoutCount: 41, styleCount: 42 } },
    { label: "deep", counts: { layoutCount: 43, styleCount: 42 } },
  ]);
  assert.equal(disagree.length, 1, "one disagreement (layout), style agrees");
  assert.ok(disagree[0].includes("breakdown=41"), "surfaces the breakdown value");
  assert.ok(disagree[0].includes("deep=43"), "surfaces the deep value, never one averaged number");

  assert.deepEqual(
    countDisagreements([
      { label: "breakdown", counts: { layoutCount: 41 } },
      { label: "deep", counts: { layoutCount: 41 } },
    ]),
    [],
    "agreement is silent",
  );
  assert.deepEqual(
    countDisagreements([
      { label: "breakdown", counts: { forcedLayoutCount: null } },
      { label: "deep", counts: { forcedLayoutCount: 7 } },
    ]),
    [],
    "a field only one member measured is not a disagreement",
  );
});

test("artifact gates keep group manifests and old recordings apart", () => {
  const validGroup = { meta: { schemaVersion: SCHEMA_VERSION, kind: "run-group" }, members: [] };
  const validRecording = { meta: { schemaVersion: SCHEMA_VERSION }, spans: [] };

  // assertGroupArtifact accepts a manifest, rejects a recording.
  assertGroupArtifact(validGroup, "g.group.json");
  assert.throws(() => assertGroupArtifact(validRecording, "r.json"), /not a run-group manifest/);

  // assertRecordingArtifact rejects a manifest with a helpful message, and keeps accepting a recording
  // (including an OLD one with no meta.kind).
  assert.throws(() => assertRecordingArtifact(validGroup, "g.group.json"), /is a run-group manifest/);
  assertRecordingArtifact(validRecording, "r.json");
  assertRecordingArtifact({ meta: { schemaVersion: SCHEMA_VERSION }, spans: [] }, "old.json");

  // A wrong schema still fails first, for both kinds.
  assert.throws(() => assertGroupArtifact({ meta: { schemaVersion: "2", kind: "run-group" }, members: [] }, "g"), /unreadable artifact/);
});

test("schema-epoch guidance points the right way: re-record vs upgrade vs neutral", () => {
  const older = String(Number.parseInt(SCHEMA_VERSION, 10) - 1);
  const newer = String(Number.parseInt(SCHEMA_VERSION, 10) + 1);

  // An OLDER artifact re-records under this build.
  assert.throws(
    () => assertSchemaVersion(older, "old.json"),
    (error) =>
      /recorded by an older wpd/.test(error.message) && /re-record/.test(error.message),
    "an older epoch says re-record",
  );

  // A NEWER artifact means the reader is behind: upgrade, never re-record (that discards evidence).
  assert.throws(
    () => assertSchemaVersion(newer, "new.json"),
    (error) =>
      /recorded by a newer wpd/.test(error.message) &&
      /upgrade wpd/.test(error.message) &&
      !/re-record/.test(error.message),
    "a newer epoch says upgrade, and never re-record",
  );

  // An absent or unparseable version cannot be ordered: neutral wording, no older/newer claim.
  for (const unorderable of [undefined, "draft"]) {
    assert.throws(
      () => assertSchemaVersion(unorderable, "weird.json"),
      (error) =>
        /different schema epoch/.test(error.message) &&
        !/older wpd/.test(error.message) &&
        !/newer wpd/.test(error.message),
      `an unorderable version (${unorderable}) is neutral`,
    );
  }
});

test("resolveConsumption: filename detection for explicit paths, pointer.group for latest", async () => {
  // Explicit paths: a .group.json is a group, anything else is a recording (so a member path always
  // resolves to the recording, per the maintainer-locked rule).
  assert.equal((await resolveConsumption("out/perf.group.json")).kind, "group");
  assert.equal((await resolveConsumption("out/run.json")).kind, "recording");

  // `latest` resolves to the group iff the pointer carries one; a subsequent non-group pointer clears it.
  const stateHome = mkdtempSync(path.join(tmpdir(), "wpd-state-"));
  const workDir = mkdtempSync(path.join(tmpdir(), "wpd-cwd-"));
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevCwd = process.cwd();
  process.env.XDG_STATE_HOME = stateHome;
  try {
    process.chdir(workDir);
    const recording = path.join(workDir, "out", "run.json");
    const manifest = path.join(workDir, "out", "perf.group.json");
    await writePointer({ recording, group: manifest });
    const group = await resolveConsumption("latest");
    assert.equal(group.kind, "group", "latest -> group when the pointer has one");
    assert.equal(group.path, manifest);

    // A later non-group record writes a pointer WITHOUT group, which clears it.
    await writePointer({ recording });
    const rec = await resolveConsumption("latest");
    assert.equal(rec.kind, "recording", "a non-group record clears the group pointer");
    assert.equal(rec.path, recording);
  } finally {
    process.chdir(prevCwd);
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
});

test("partialGroupNotes: reflects current counts while incomplete, silent once complete", () => {
  // Requested breakdown+deep, only breakdown present: one loud note naming the gap AND the recovery.
  const incomplete = partialGroupNotes("perf", ["breakdown", "deep"], ["breakdown"]);
  assert.equal(incomplete.length, 1, "an incomplete group carries one partial note");
  assert.ok(incomplete[0].includes("1 of 2"), "the note reflects the CURRENT counts");
  assert.ok(incomplete[0].includes("missing: deep"), "it names the missing member");
  assert.ok(
    incomplete[0].includes("--members deep --group perf"),
    "and the exact recovery command",
  );

  // Once the missing member records, the note is GONE -- state, never a stored failure narrative.
  assert.deepEqual(
    partialGroupNotes("perf", ["breakdown", "deep"], ["breakdown", "deep"]),
    [],
    "a complete group carries no partial note",
  );
  // An ad-hoc --group group requested nothing, so it is complete-by-construction: never partial.
  assert.deepEqual(partialGroupNotes("perf", [], ["breakdown"]), [], "no requested set => no note");
});

// Write a manifest to a fresh temp dir and return its path, for the preflight tests.
const writeManifest = (over = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-grp-"));
  const manifest = {
    meta: {
      tool: "wpd",
      version: "0",
      schemaVersion: SCHEMA_VERSION,
      kind: "run-group",
      createdAt: "",
      name: "perf",
      ...over.meta,
    },
    iterations: 5,
    warmup: 1,
    headless: true,
    requested: over.requested,
    members: (over.modes ?? ["breakdown"]).map((mode) => ({
      mode,
      recording: `${mode}.json`,
      createdAt: "",
      annotations: [],
    })),
    notes: [],
  };
  const manifestPath = path.join(dir, "perf.group.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return manifestPath;
};

test("preflightGroup: a name that only sanitize-collides refuses with BOTH names", async () => {
  // Stored "perf app", requested "perf-app": both fold to perf-app.group.json, so a join would merge
  // two distinct groups. Refuse, naming both so the collision is legible.
  const manifestPath = writeManifest({ meta: { name: "perf app" }, modes: ["breakdown"] });
  await assert.rejects(
    preflightGroup(manifestPath, "json", "perf-app", [{ mode: "deep" }]),
    (error) =>
      error.message.includes("perf app") &&
      error.message.includes("perf-app") &&
      /merge/.test(error.message),
    "the name-mismatch refusal carries both the stored and requested names",
  );
});

test("preflightGroup: a duplicate on a COMPLETE group refuses, naming the rename/remove recovery", async () => {
  const manifestPath = writeManifest({
    requested: ["breakdown", "deep"],
    modes: ["breakdown", "deep"],
  });
  await assert.rejects(
    preflightGroup(manifestPath, "json", "perf", [{ mode: "breakdown" }, { mode: "deep" }]),
    (error) =>
      /already holds/.test(error.message) &&
      /complete/.test(error.message) &&
      /new --group name/.test(error.message) &&
      error.message.includes("perf"),
    "a complete-group duplicate names the rename-or-remove recovery, not a --members command",
  );
});

test("preflightGroup: a duplicate on a PARTIAL group names the exact missing-members command", async () => {
  // breakdown present, deep still missing (requested both). Re-running breakdown is a duplicate, but
  // the recovery must point at the member that is actually missing.
  const manifestPath = writeManifest({ requested: ["breakdown", "deep"], modes: ["breakdown"] });
  await assert.rejects(
    preflightGroup(manifestPath, "json", "perf", [{ mode: "breakdown" }]),
    (error) => error.message.includes("record --members deep --group perf"),
    "a partial-group duplicate names the missing member's exact command",
  );
});

test("preflightGroup: no manifest and a non-duplicate member both pass silently", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-grp-"));
  // No manifest yet (first formation): nothing to conflict with.
  await preflightGroup(path.join(dir, "perf.group.json"), "json", "perf", [{ mode: "breakdown" }]);
  // An existing group, a genuinely new member: no refusal.
  const manifestPath = writeManifest({ requested: ["breakdown"], modes: ["breakdown"] });
  await preflightGroup(manifestPath, "json", "perf", [{ mode: "deep" }]);
});

// A minimal on-disk recording for a member, so appendMember can read its meta + summary.
const recordingFor = (mode) => ({
  meta: meta({ passes: [mode] }),
  window: { measure: "wpd:run", startTs: null, endTs: null, wallMs: null },
  marks: [],
  events: [],
  spans: [],
  summary: {},
});

test("appendMember: a partial group's stale note is GONE once the missing member records (D3)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-grp-"));
  const manifestPath = path.join(dir, "perf.group.json");
  const format = "json";
  const requested = ["breakdown", "deep"];
  const writeMember = (mode) =>
    writeFileSync(path.join(dir, `${mode}.json`), JSON.stringify(recordingFor(mode)));
  const append = (mode) =>
    appendMember({
      name: "perf",
      manifestPath,
      format,
      recordingPath: path.join(dir, `${mode}.json`),
      meta: meta({ passes: [mode] }),
      summary: {},
      requested,
    });

  // First member: the group is partial (deep still missing), so it carries the structural note.
  writeMember("breakdown");
  await append("breakdown");
  let manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.members.length, 1, "one member so far");
  assert.deepEqual(manifest.requested.sort(), ["breakdown", "deep"], "the requested set is persisted");
  assert.ok(
    manifest.notes.some((note) => note.includes("1 of 2") && note.includes("missing: deep")),
    "while incomplete the note reflects the current counts and names the gap",
  );

  // Recovery: the missing member records. The partial note is REMOVED (present state, not history).
  writeMember("deep");
  await append("deep");
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.members.length, 2, "members 2/2 after recovery");
  assert.ok(
    !manifest.notes.some((note) => note.includes("partial group")),
    "a recovered group carries no stale 'partial group ... failed' note",
  );
});

test("appendMember: a name that only sanitize-collides is refused, naming both names (D2)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-grp-"));
  const manifestPath = path.join(dir, "perf-app.group.json");
  writeFileSync(path.join(dir, "breakdown.json"), JSON.stringify(recordingFor("breakdown")));
  // Form the group under the stored name "perf app".
  await appendMember({
    name: "perf app",
    manifestPath,
    format: "json",
    recordingPath: path.join(dir, "breakdown.json"),
    meta: meta({ passes: ["breakdown"] }),
    summary: {},
  });
  writeFileSync(path.join(dir, "deep.json"), JSON.stringify(recordingFor("deep")));
  // A second record whose --group "perf-app" folds to the same filename must refuse, not silently join.
  await assert.rejects(
    appendMember({
      name: "perf-app",
      manifestPath,
      format: "json",
      recordingPath: path.join(dir, "deep.json"),
      meta: meta({ passes: ["deep"] }),
      summary: {},
    }),
    (error) => error.message.includes("perf app") && error.message.includes("perf-app"),
    "the append refuses a name-collision, naming both the stored and requested names",
  );
});
