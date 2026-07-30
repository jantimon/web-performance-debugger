import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { writePointer, resolveTarget } from "../../dist/commands/resolve.js";

// The `latest` pointer must resolve from the cwd it was recorded in WITHOUT dropping a recordings/
// dir into that cwd -- recording with --out somewhere else should leave the working tree untouched
// Single top-level test so the chdir/env mutation below never races another test in this file
test("latest pointer: cwd-keyed under XDG_STATE_HOME, no recordings/ in cwd, legacy file ignored", async () => {
  const stateHome = mkdtempSync(path.join(tmpdir(), "wpd-state-"));
  const workDir = mkdtempSync(path.join(tmpdir(), "wpd-cwd-"));
  const legacyDir = mkdtempSync(path.join(tmpdir(), "wpd-legacy-"));
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevCwd = process.cwd();
  process.env.XDG_STATE_HOME = stateHome;
  try {
    // Record into a temp --out from workDir: the pointer lands in the state dir, not the cwd
    process.chdir(workDir);
    const recording = path.join(workDir, "out", "run.json");
    await writePointer({ recording, digest: path.join(workDir, "out", "run.digest.json") });

    assert.ok(!existsSync(path.join(workDir, "recordings")), "no recordings/ dir written into cwd");
    assert.ok(existsSync(path.join(stateHome, "wpd", "pointers")), "pointer written under state dir");
    assert.equal(await resolveTarget("latest", "recording"), recording, "latest resolves from state");

    // A stale legacy in-cwd pointer must NEVER shadow the state file: only the state file resolves
    const staleRecording = path.join(workDir, "recordings", "stale.json");
    mkdirSync(path.join(workDir, "recordings"), { recursive: true });
    writeFileSync(
      path.join(workDir, "recordings", ".wpd-last.json"),
      JSON.stringify({ recording: staleRecording, digest: staleRecording }),
      "utf8",
    );
    assert.equal(
      await resolveTarget("latest", "recording"),
      recording,
      "state file resolves, a stale legacy recordings/.wpd-last.json is ignored",
    );

    // A different cwd is keyed separately, so it does not see workDir's pointer. A legacy in-cwd
    // pointer left by an old record is NOT read: `latest` fails cleanly, naming the remedy
    process.chdir(legacyDir);
    const legacyRecording = path.join(legacyDir, "runs", "old.json");
    mkdirSync(path.join(legacyDir, "recordings"), { recursive: true });
    writeFileSync(
      path.join(legacyDir, "recordings", ".wpd-last.json"),
      JSON.stringify({ recording: legacyRecording, digest: legacyRecording }),
      "utf8",
    );
    await assert.rejects(
      () => resolveTarget("latest", "recording"),
      /No previous recording found for 'latest'.*Run `record` first/s,
      "a legacy recordings/.wpd-last.json is ignored: latest fails cleanly with the remedy",
    );

    // A corrupt state pointer (bad JSON) must THROW, naming the state file, never resolve anything
    const corruptDir = mkdtempSync(path.join(tmpdir(), "wpd-corrupt-"));
    process.chdir(corruptDir);
    // Key by the canonical cwd the resolver sees (tmpdir may be a symlink, e.g. /var -> /private/var)
    const corruptStateFile = path.join(
      stateHome,
      "wpd",
      "pointers",
      `${createHash("sha256").update(path.resolve(process.cwd())).digest("hex").slice(0, 16)}.json`,
    );
    mkdirSync(path.dirname(corruptStateFile), { recursive: true });
    writeFileSync(corruptStateFile, "{ not valid json", "utf8");
    await assert.rejects(
      () => resolveTarget("latest", "recording"),
      /Failed to read the 'latest' pointer/,
      "a corrupt state pointer throws",
    );
  } finally {
    process.chdir(prevCwd);
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
});
