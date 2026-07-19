import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chromeArgs,
  isSandboxLaunchError,
  sandboxLaunchError,
  isTransientNavError,
  retryTransientNav,
} from "../../dist/browser/launch.js";
import { browserSandboxDisabled, navRetried } from "../../dist/record/notes.js";

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

// F3: a cross-process --url boot can fail the top-level navigation transiently. Those errors earn a
// bounded retry; a permanent failure (bad host, refused connection) does not.
test("isTransientNavError: retries the swap-race shapes, not a permanent failure", () => {
  for (const message of [
    "net::ERR_INVALID_HANDLE at https://www.example.com",
    "net::ERR_ABORTED at https://www.example.com",
    "Navigation failed because browser has disconnected: net::ERR_NETWORK_CHANGED",
    "Navigating frame was detached",
    "Protocol error (Page.navigate): Target closed",
  ]) {
    assert.ok(isTransientNavError(new Error(message)), `should retry: ${message}`);
  }
  for (const message of [
    "net::ERR_NAME_NOT_RESOLVED at https://nope.invalid",
    "net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1",
    "net::ERR_CERT_AUTHORITY_INVALID",
  ]) {
    assert.ok(!isTransientNavError(new Error(message)), `must NOT retry: ${message}`);
  }
});

test("retryTransientNav: retries a transient failure then reports the retry count", async () => {
  let calls = 0;
  const { value, retries } = await retryTransientNav(async () => {
    calls++;
    if (calls < 3) throw new Error("net::ERR_INVALID_HANDLE at https://x");
    return "ok";
  }, 2);
  assert.equal(value, "ok");
  assert.equal(retries, 2, "two retries were needed (third attempt succeeded)");
  assert.equal(calls, 3);
});

test("retryTransientNav: exhausting the limit re-throws the transient error (no infinite loop)", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientNav(async () => {
      calls++;
      throw new Error("net::ERR_INVALID_HANDLE at https://x");
    }, 2),
    /ERR_INVALID_HANDLE/,
  );
  assert.equal(calls, 3, "one initial attempt + two retries, then it gives up");
});

test("retryTransientNav: a permanent error is re-thrown immediately, not retried", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientNav(async () => {
      calls++;
      throw new Error("net::ERR_NAME_NOT_RESOLVED at https://nope.invalid");
    }, 2),
    /ERR_NAME_NOT_RESOLVED/,
  );
  assert.equal(calls, 1, "a permanent failure surfaces on the first attempt");
});

test("navRetried note names the transient error and that a fresh browser recovered it", () => {
  const note = navRetried(1);
  assert.match(note, /net::ERR_INVALID_HANDLE/);
  assert.match(note, /fresh browser/);
  assert.match(note, /1 retry/);
  assert.match(navRetried(2), /2 retries/);
});
