import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { writePointer, resolveTarget } from "../../dist/commands/resolve.js";

// The `latest` pointer must resolve from the cwd it was recorded in WITHOUT dropping a recordings/
// dir into that cwd -- recording with --out somewhere else should leave the working tree untouched.
// Single top-level test so the chdir/env mutation below never races another test in this file.
test("latest pointer: cwd-keyed under XDG_STATE_HOME, no recordings/ in cwd, legacy read fallback", async () => {
  const stateHome = mkdtempSync(path.join(tmpdir(), "wpd-state-"));
  const workDir = mkdtempSync(path.join(tmpdir(), "wpd-cwd-"));
  const legacyDir = mkdtempSync(path.join(tmpdir(), "wpd-legacy-"));
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevCwd = process.cwd();
  process.env.XDG_STATE_HOME = stateHome;
  try {
    // Record into a temp --out from workDir: the pointer lands in the state dir, not the cwd.
    process.chdir(workDir);
    const recording = path.join(workDir, "out", "run.json");
    await writePointer({ recording, digest: path.join(workDir, "out", "run.digest.json") });

    assert.ok(!existsSync(path.join(workDir, "recordings")), "no recordings/ dir written into cwd");
    assert.ok(existsSync(path.join(stateHome, "wpd", "pointers")), "pointer written under state dir");
    assert.equal(await resolveTarget("latest", "recording"), recording, "latest resolves from state");

    // A stale legacy in-cwd pointer must NEVER shadow the state file: when both exist, the state
    // file wins. This is the change's central invariant.
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
      "state file wins over a stale legacy recordings/.wpd-last.json",
    );

    // A different cwd is keyed separately, so it does not see workDir's pointer.
    process.chdir(legacyDir);
    // Legacy in-cwd pointer (left by an older record) still resolves via the read-only fallback.
    const legacyRecording = path.join(legacyDir, "runs", "old.json");
    mkdirSync(path.join(legacyDir, "recordings"), { recursive: true });
    writeFileSync(
      path.join(legacyDir, "recordings", ".wpd-last.json"),
      JSON.stringify({ recording: legacyRecording, digest: legacyRecording }),
      "utf8",
    );
    assert.equal(
      await resolveTarget("latest", "recording"),
      legacyRecording,
      "legacy recordings/.wpd-last.json still resolves when no state entry exists",
    );

    // A corrupt state pointer (bad JSON) must THROW, never fall back to a legacy pointer that also
    // exists: resolving a stale legacy recording to answer `latest` is a quiet wrong answer.
    const corruptDir = mkdtempSync(path.join(tmpdir(), "wpd-corrupt-"));
    process.chdir(corruptDir);
    // Key by the canonical cwd the resolver sees (tmpdir may be a symlink, e.g. /var -> /private/var).
    const corruptStateFile = path.join(
      stateHome,
      "wpd",
      "pointers",
      `${createHash("sha256").update(path.resolve(process.cwd())).digest("hex").slice(0, 16)}.json`,
    );
    mkdirSync(path.dirname(corruptStateFile), { recursive: true });
    writeFileSync(corruptStateFile, "{ not valid json", "utf8");
    // A legacy pointer that WOULD resolve if the corrupt state file were ignored.
    mkdirSync(path.join(corruptDir, "recordings"), { recursive: true });
    writeFileSync(
      path.join(corruptDir, "recordings", ".wpd-last.json"),
      JSON.stringify({
        recording: path.join(corruptDir, "runs", "legacy.json"),
        digest: path.join(corruptDir, "runs", "legacy.json"),
      }),
      "utf8",
    );
    await assert.rejects(
      () => resolveTarget("latest", "recording"),
      /Failed to read the 'latest' pointer/,
      "a corrupt state pointer throws instead of falling back to the legacy pointer",
    );
  } finally {
    process.chdir(prevCwd);
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
});
