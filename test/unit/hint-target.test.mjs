import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writePointer, hintTarget, displayPath } from "../../dist/commands/resolve.js";

// Drill-in hints must not paste an absolute home/scratch path into terminals. hintTarget returns the
// literal `latest` when the path IS the cwd's latest pointer target, else displayPath (cwd-relative
// when shorter, absolute only when relativizing would be worse). Single test: it mutates cwd + env.
test("hintTarget: prefers `latest`, else a cwd-relative display path, never a leaked absolute", async () => {
  const stateHome = mkdtempSync(path.join(tmpdir(), "wpd-hint-state-"));
  const workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "wpd-hint-cwd-")));
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevCwd = process.cwd();
  process.env.XDG_STATE_HOME = stateHome;
  try {
    process.chdir(workDir);
    const recording = path.join(workDir, "runs", "boot-default.json");
    await writePointer({ recording });

    assert.equal(
      await hintTarget(recording),
      "latest",
      "the current latest target collapses to the literal `latest`",
    );

    // A different recording under cwd is shown relative and quoted (so a spaced path stays one arg).
    const other = path.join(workDir, "runs", "other.json");
    assert.equal(await hintTarget(other), '"runs/other.json"', "a non-latest cwd path is relativized + quoted");
    assert.equal(displayPath(other), "runs/other.json");

    // A path outside cwd where relativizing only makes it worse stays absolute (displayPath's rule).
    const outside = path.join(tmpdir(), "elsewhere", "x.json");
    assert.equal(await hintTarget(outside), `"${outside}"`, "an outside path is left absolute, not ../../");
  } finally {
    process.chdir(prevCwd);
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
});

test("hintTarget: with no pointer for this cwd, falls back to displayPath (no throw)", async () => {
  const stateHome = mkdtempSync(path.join(tmpdir(), "wpd-hint-empty-"));
  const workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "wpd-hint-empty-cwd-")));
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevCwd = process.cwd();
  process.env.XDG_STATE_HOME = stateHome;
  try {
    process.chdir(workDir);
    const recording = path.join(workDir, "run.json");
    assert.equal(await hintTarget(recording), '"run.json"', "no pointer => quoted displayPath, never an error");
  } finally {
    process.chdir(prevCwd);
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
});
