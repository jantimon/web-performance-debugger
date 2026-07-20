import { test } from "node:test";
import assert from "node:assert/strict";
import { isDestroyedContextError } from "../../dist/browser/until.js";

// waitForStable retries the quiet check when a HARD navigation destroys its execution context mid-wait
// (a window.location swap, a meta refresh, a redirect the step lands on). The pure part is the
// classifier: a navigation-destroyed context is retryable, a real failure is not.
test("isDestroyedContextError matches the navigation-destroyed-context family, not real failures", () => {
  assert.equal(
    isDestroyedContextError(new Error("Execution context was destroyed, most likely because of a navigation.")),
    true,
  );
  assert.equal(isDestroyedContextError(new Error("Execution context is not available in detached frame")), true);
  assert.equal(isDestroyedContextError(new Error("Cannot find context with specified id")), true);
  // A closed target or a genuine evaluate bug must NOT be swallowed as a navigation.
  assert.equal(isDestroyedContextError(new Error("Target closed")), false);
  assert.equal(isDestroyedContextError(new Error("selector '#x' did not resolve")), false);
  assert.equal(isDestroyedContextError("Execution context was destroyed"), true, "a thrown string is matched too");
  assert.equal(isDestroyedContextError(undefined), false);
});
