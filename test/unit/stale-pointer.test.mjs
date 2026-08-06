import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writePointer, resolveTarget, resolveConsumption } from "../../dist/commands/resolve.js";
import { loadMemberRecording, resolveVerbTarget } from "../../dist/commands/group.js";
import { SCHEMA_VERSION } from "../../dist/schema.js";

// An artifact the pointer names can be gone by the time a verb reads it (a cleaned temp dir, a
// trashed recording). `latest` must then say what happened and how to recover, never hand the
// caller the filesystem's own errno
// The only test in this file that mutates cwd/env, so nothing races it
test("stale `latest` pointer: names the missing artifact and the fix, never a raw errno", async () => {
  const stateHome = mkdtempSync(path.join(tmpdir(), "wpd-state-"));
  const workDir = mkdtempSync(path.join(tmpdir(), "wpd-cwd-"));
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevCwd = process.cwd();
  process.env.XDG_STATE_HOME = stateHome;
  try {
    process.chdir(workDir);
    // The realpath of the temp cwd (macOS resolves /var -> /private/var), so the paths under test
    // are inside cwd and the report shows them relative, exactly as a real run does
    const cwd = process.cwd();
    const recording = path.join(cwd, "out", "run.json");
    const cpuModel = path.join(cwd, "out", "run.cpu.json");
    await writePointer({ recording, cpuModel });

    // The recording is gone: every consumer verb resolves through these two entry points. The path
    // is shown the way every other report shows one (relative to cwd when that is shorter)
    const staleMessage = (error) =>
      error.message ===
      "The last recording for this directory no longer exists at out/run.json. " +
        "Run `record` again, or pass an explicit file path.";
    await assert.rejects(
      () => resolveTarget("latest", "recording"),
      staleMessage,
      "resolveTarget names the missing recording and the fix",
    );
    await assert.rejects(
      () => resolveConsumption("latest"),
      staleMessage,
      "resolveConsumption gives the group-aware verbs the same message",
    );

    // A recording that IS there resolves as before, and its deleted CPU model names ITSELF, so
    // `query cpu latest` does not blame a recording that is sitting right there
    mkdirSync(path.join(cwd, "out"), { recursive: true });
    writeFileSync(recording, "{}", "utf8");
    assert.equal(await resolveTarget("latest", "recording"), recording);
    await assert.rejects(
      () => resolveTarget("latest", "cpu-model"),
      /The latest run's CPU model no longer exists at out\/run\.cpu\.json/,
      "the CPU model reports its own path",
    );

    // Same for the allocation lane's artifacts
    await writePointer({ recording, allocModel: path.join(cwd, "out", "run.alloc.json") });
    await assert.rejects(
      () => resolveTarget("latest", "alloc-model"),
      /The latest run's allocation model no longer exists at out\/run\.alloc\.json/,
      "the allocation model reports its own path",
    );

    // A pointer whose GROUP manifest is gone reports the manifest, not the member recording
    const manifest = path.join(cwd, "out", "perf.group.json");
    await writePointer({ recording, group: manifest });
    await assert.rejects(
      () => resolveConsumption("latest"),
      /The last run-group manifest for this directory no longer exists at out\/perf\.group\.json/,
      "a stale group pointer names the manifest",
    );

    // A path whose PARENT is a file (ENOTDIR, not ENOENT) is the same not-there case, worded the same
    writeFileSync(path.join(cwd, "afile"), "", "utf8");
    await writePointer({ recording: path.join(cwd, "afile", "run.json") });
    await assert.rejects(
      () => resolveTarget("latest", "recording"),
      /The last recording for this directory no longer exists at afile\/run\.json/,
      "a path under a file is not-there too, not a raw ENOTDIR",
    );

    // An EXPLICIT missing path resolves unchecked: it keeps the reader's own error
    assert.equal(
      await resolveTarget(path.join(cwd, "gone.json"), "recording"),
      path.join(cwd, "gone.json"),
      "an explicit path resolves without an existence check",
    );
  } finally {
    process.chdir(prevCwd);
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
});

// Write a manifest holding one member that points at a recording which is not there
const manifestWithMissingMember = (member) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-grp-"));
  const manifestPath = path.join(dir, "perf.group.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      meta: {
        tool: "wpd",
        version: "0",
        schemaVersion: SCHEMA_VERSION,
        kind: "run-group",
        createdAt: "",
        name: "perf",
      },
      iterations: 5,
      warmup: 1,
      headless: true,
      members: [member],
      notes: [],
    }),
  );
  return manifestPath;
};

// A manifest outlives a deleted member recording. Every member read goes through the one checked
// path helper, so the stitching verbs (query spans/span, assert, diff) and the routed single-member
// verbs (cpu/frame/blame/events/get) all get the member-named message
test("run-group member: a deleted member recording names the member, never a raw errno", async () => {
  const member = { mode: "breakdown", recording: "gone.json", createdAt: "", annotations: [] };
  const manifestPath = manifestWithMissingMember(member);
  const namesTheMember = (error) =>
    /The recording for run-group member 'breakdown' no longer exists at /.test(error.message) &&
    error.message.includes("Re-record the member");

  await assert.rejects(
    () => loadMemberRecording(manifestPath, member),
    namesTheMember,
    "a member load fails with the member label and the fix",
  );
  await assert.rejects(
    () => resolveVerbTarget(manifestPath, "cpu", "CPU sampling"),
    namesTheMember,
    "a routed single-member verb fails before it hands the path to its reader",
  );
});
