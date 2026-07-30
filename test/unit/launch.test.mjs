import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chromeArgs,
  isSandboxLaunchError,
  sandboxLaunchError,
  isTransientNavError,
  isFrameStallError,
  frameStallError,
  retryTransientNav,
} from "../../dist/browser/launch.js";
import { browserSandboxDisabled, navRetried, frameStallRetried } from "../../dist/record/notes.js";

// S11: Chrome must launch sandboxed by DEFAULT. Neither sandbox-disabling flag may appear unless
// --disable-browser-sandbox was explicitly requested
test("chromeArgs: the default launch carries neither sandbox-disabling flag", () => {
  const args = chromeArgs(false, true);
  assert.ok(!args.includes("--no-sandbox"), "no --no-sandbox by default");
  assert.ok(!args.includes("--disable-setuid-sandbox"), "no --disable-setuid-sandbox by default");
  // The unrelated perf/backgrounding flags stay
  assert.ok(args.includes("--enable-precise-memory-info"));
});

test("chromeArgs: --disable-browser-sandbox adds both sandbox-disabling flags", () => {
  const args = chromeArgs(true, true);
  assert.ok(args.includes("--no-sandbox"), "opt-in adds --no-sandbox");
  assert.ok(args.includes("--disable-setuid-sandbox"), "opt-in adds --disable-setuid-sandbox");
});

// Headless launches software-composite (--disable-gpu) to dodge the intermittent GPU-process
// BeginFrame stall; headed keeps the GPU (it drives a real window off a real display)
test("chromeArgs: --disable-gpu is set headless, absent headed", () => {
  assert.ok(chromeArgs(false, true).includes("--disable-gpu"), "headless software-composites");
  assert.ok(!chromeArgs(false, false).includes("--disable-gpu"), "headed keeps the GPU");
});

// A sandbox launch failure is detected by its known message shapes and re-thrown as guidance that
// names the opt-in flag -- never a silent unsandboxed retry
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
// bounded retry; a permanent failure (bad host, refused connection) does not
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

// ERR_HTTP2_PROTOCOL_ERROR is a permanent navigation failure (a retry fails identically), so it is
// not in isTransientNavError; with chrome-headless-shell gone there is no mode remedy and it surfaces
// as itself
test("ERR_HTTP2_PROTOCOL_ERROR is not treated as a transient (retriable) navigation error", () => {
  const error = new Error("net::ERR_HTTP2_PROTOCOL_ERROR at https://cdn.example.com");
  assert.ok(!isTransientNavError(error), "must not be retried: it fails identically on a retry");
});

test("navRetried note names the transient error and that a fresh browser recovered it", () => {
  const note = navRetried(1);
  assert.match(note, /net::ERR_INVALID_HANDLE/);
  assert.match(note, /fresh browser/);
  assert.match(note, /1 retry/);
  assert.match(navRetried(2), /2 retries/);
});

// A headless frame-production stall is retryable (a fresh browser recovers it), and distinguished
// from a transient nav error so the caller notes the right cause
test("isFrameStallError recognizes the driver's frame-stall error, not a nav error", () => {
  assert.ok(isFrameStallError(frameStallError(3000)), "recognizes its own error");
  assert.ok(!isFrameStallError(new Error("net::ERR_INVALID_HANDLE at https://x")), "not a nav error");
  assert.ok(!isTransientNavError(frameStallError(3000)), "a frame stall is not a nav error");
});

test("retryTransientNav retries a frame stall and counts it separately", async () => {
  let calls = 0;
  const { value, retries, frameStallRetries } = await retryTransientNav(async () => {
    calls++;
    if (calls < 2) throw frameStallError(3000);
    return "ok";
  }, 2);
  assert.equal(value, "ok");
  assert.equal(retries, 1);
  assert.equal(frameStallRetries, 1, "the retry was a frame stall");
});

test("retryTransientNav: exhausting the limit on frame stalls re-throws the stall error", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientNav(async () => {
      calls++;
      throw frameStallError(3000);
    }, 2),
    /wpd:frame-stall/,
  );
  assert.equal(calls, 3, "one attempt + two retries, then it gives up");
});

test("frameStallRetried note names the headless stall and the fresh-browser recovery", () => {
  const note = frameStallRetried(1);
  assert.match(note, /headless/i);
  assert.match(note, /fresh browser/);
  assert.match(note, /1 retry/);
  assert.match(frameStallRetried(2), /2 retries/);
});
