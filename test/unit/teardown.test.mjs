import { test } from "node:test";
import assert from "node:assert/strict";
import { attachTeardownFailure } from "../../dist/model/teardown.js";
import { finishLaunchOrClose } from "../../dist/browser/launch.js";

// A teardown failure must never replace the primary error the caller is debugging: it is attached as
// the primary's `cause` so the primary keeps propagating and the secondary stays recoverable.
test("attachTeardownFailure: attaches the teardown failure as the primary error's cause", () => {
  const primary = new Error("primary run failure");
  const teardown = new Error("cleanup failure");
  attachTeardownFailure(primary, teardown);
  assert.equal(primary.message, "primary run failure", "the primary is untouched");
  assert.equal(primary.cause, teardown, "the teardown failure is the cause");
});

test("attachTeardownFailure: never overwrites a cause the primary error already carries", () => {
  const existingCause = new Error("original cause");
  const primary = new Error("primary", { cause: existingCause });
  attachTeardownFailure(primary, new Error("late teardown failure"));
  assert.equal(primary.cause, existingCause, "the first cause wins");
});

test("attachTeardownFailure: a non-Error primary is left alone (nothing to attach to)", () => {
  // A thrown string has no `cause` slot; the helper must not throw trying to set one.
  assert.doesNotThrow(() => attachTeardownFailure("string primary", new Error("teardown")));
});

// B-11: a launch that half-succeeds (browser up) and then fails setup (newPage / CDP session) must
// close the browser so nothing is left running, and the setup error is the one that surfaces.
test("finishLaunchOrClose: a setup failure closes the browser and re-throws the setup error", async () => {
  let closed = false;
  const browser = {
    close: async () => {
      closed = true;
    },
  };
  await assert.rejects(
    finishLaunchOrClose(browser, async () => {
      throw new Error("newPage failed");
    }),
    /newPage failed/,
  );
  assert.ok(closed, "the browser was closed on the setup failure");
});

test("finishLaunchOrClose: a close that also throws does not replace the setup error", async () => {
  let closeAttempted = false;
  const browser = {
    close: async () => {
      closeAttempted = true;
      throw new Error("close failed");
    },
  };
  await assert.rejects(
    finishLaunchOrClose(browser, async () => {
      throw new Error("cdp session failed");
    }),
    (error) => {
      assert.match(error.message, /cdp session failed/, "the setup error surfaces, not the close error");
      assert.match(error.cause?.message ?? "", /close failed/, "the close failure is the cause");
      return true;
    },
  );
  assert.ok(closeAttempted, "the close was still attempted");
});

test("finishLaunchOrClose: a successful setup returns its handle and never closes the browser", async () => {
  let closed = false;
  const browser = {
    close: async () => {
      closed = true;
    },
  };
  const handle = await finishLaunchOrClose(browser, async () => ({ page: "p", client: null }));
  assert.deepEqual(handle, { page: "p", client: null });
  assert.ok(!closed, "a successful launch is left running for the run");
});
