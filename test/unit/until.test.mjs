import { test } from "node:test";
import assert from "node:assert/strict";
import { isDestroyedContextError, neverQuietError } from "../../dist/browser/until.js";

// waitForStable retries the quiet check when a HARD navigation destroys its execution context mid-wait
// (a window.location swap, a meta refresh, a redirect the step lands on). The pure part is the
// classifier: a navigation-destroyed context is retryable, a real failure is not
test("isDestroyedContextError matches the navigation-destroyed-context family, not real failures", () => {
  assert.equal(
    isDestroyedContextError(new Error("Execution context was destroyed, most likely because of a navigation.")),
    true,
  );
  assert.equal(isDestroyedContextError(new Error("Execution context is not available in detached frame")), true);
  assert.equal(isDestroyedContextError(new Error("Cannot find context with specified id")), true);
  // A closed target or a genuine evaluate bug must NOT be swallowed as a navigation
  assert.equal(isDestroyedContextError(new Error("Target closed")), false);
  assert.equal(isDestroyedContextError(new Error("selector '#x' did not resolve")), false);
  assert.equal(isDestroyedContextError("Execution context was destroyed"), true, "a thrown string is matched too");
  assert.equal(isDestroyedContextError(undefined), false);
});

// A page that never goes quiet within the cap fails loudly and specifically: the message names both
// quietMs and timeoutMs and offers the three ways forward, so it never reads as a protocol timeout
test("neverQuietError names both knobs and the ways forward, with quietMs in the right direction", () => {
  const error = neverQuietError(200, 30000);
  assert.match(error.message, /waitForStable/);
  assert.match(error.message, /200ms/, "names quietMs");
  assert.match(error.message, /30000ms/, "names the timeout cap");
  // A never-quiet page never opens a quietMs-long lull, so relaxing the requirement means a SHORTER
  // lull: lower quietMs. Raising it lengthens the required lull and makes settling harder, so the
  // guidance must say lower, never raise
  assert.match(error.message, /lower quietMs/i, "relaxing the lull requirement means lowering quietMs");
  assert.doesNotMatch(error.message, /raise quietMs/i, "raising quietMs is stricter, never the remedy");
  assert.match(error.message, /raise timeoutMs/i, "a merely-slow transition is the timeoutMs case");
  assert.match(error.message, /selector-based until/i);
});
