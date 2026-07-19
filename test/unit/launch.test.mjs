import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chromeArgs,
  isSandboxLaunchError,
  sandboxLaunchError,
} from "../../dist/browser/launch.js";
import { browserSandboxDisabled } from "../../dist/record/notes.js";

// S11: Chrome must launch sandboxed by DEFAULT. Neither sandbox-disabling flag may appear unless
// --disable-browser-sandbox was explicitly requested.
test("chromeArgs: the default launch carries neither sandbox-disabling flag", () => {
  const args = chromeArgs(false);
  assert.ok(!args.includes("--no-sandbox"), "no --no-sandbox by default");
  assert.ok(!args.includes("--disable-setuid-sandbox"), "no --disable-setuid-sandbox by default");
  // The unrelated perf/backgrounding flags stay.
  assert.ok(args.includes("--enable-precise-memory-info"));
});

test("chromeArgs: --disable-browser-sandbox adds both sandbox-disabling flags", () => {
  const args = chromeArgs(true);
  assert.ok(args.includes("--no-sandbox"), "opt-in adds --no-sandbox");
  assert.ok(args.includes("--disable-setuid-sandbox"), "opt-in adds --disable-setuid-sandbox");
});

// A sandbox launch failure is detected by its known message shapes and re-thrown as guidance that
// names the opt-in flag -- never a silent unsandboxed retry.
test("isSandboxLaunchError: recognizes the known Chrome sandbox failure shapes", () => {
  for (const message of [
    "No usable sandbox! Update your kernel or see https://...",
    "The SUID sandbox helper binary was found, but is not configured correctly",
    "Running as root without --no-sandbox is not supported",
    "Failed to move to new namespace: setuid sandbox",
  ]) {
    assert.ok(isSandboxLaunchError(new Error(message)), `should match: ${message}`);
  }
  assert.ok(!isSandboxLaunchError(new Error("Could not find Chrome (ver. 140)")), "unrelated error");
});

test("sandboxLaunchError names the opt-in flag and does not suggest an unsandboxed retry", () => {
  const rethrown = sandboxLaunchError(new Error("No usable sandbox!"));
  assert.match(rethrown.message, /--disable-browser-sandbox/, "names the opt-in flag");
  assert.match(rethrown.message, /No usable sandbox!/, "preserves the original cause");
});

test("browserSandboxDisabled note warns about reduced containment", () => {
  const note = browserSandboxDisabled();
  assert.match(note, /WARNING/);
  assert.match(note, /--no-sandbox/);
});
