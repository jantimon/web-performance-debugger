import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formationVerdict,
  pickMember,
  countDisagreements,
} from "../../dist/model/group.js";
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
