import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerDisposer,
  runDisposersForTest,
  activeDisposerCount,
} from "../../dist/browser/disposers.js";

// The signal-cleanup registry: acquisition sites register a synchronous disposer and deregister on
// clean release; a fatal signal runs whatever is still registered. These exercise the mechanics
// (register / release / run-once) without delivering a real signal -- runDisposersForTest stands in for
// the handler's body (no re-raise). The set is module-level, so each test cleans up after itself

test("registerDisposer adds one, its release removes it", () => {
  assert.equal(activeDisposerCount(), 0);
  const release = registerDisposer(() => {});
  assert.equal(activeDisposerCount(), 1);
  release();
  assert.equal(activeDisposerCount(), 0);
  // A second release is a harmless no-op, never a throw or a negative count
  release();
  assert.equal(activeDisposerCount(), 0);
});

test("a fatal signal runs every still-registered disposer, in registration order", () => {
  const order = [];
  registerDisposer(() => order.push("first"));
  registerDisposer(() => order.push("second"));
  registerDisposer(() => order.push("third"));
  runDisposersForTest();
  assert.deepEqual(order, ["first", "second", "third"]);
  // Running clears the set: nothing is left registered after a signal
  assert.equal(activeDisposerCount(), 0);
});

test("a released disposer does not run", () => {
  let ran = false;
  const release = registerDisposer(() => {
    ran = true;
  });
  release();
  runDisposersForTest();
  assert.equal(ran, false);
  assert.equal(activeDisposerCount(), 0);
});

test("each disposer runs at most once even if the handler fires twice", () => {
  let count = 0;
  registerDisposer(() => {
    count++;
  });
  runDisposersForTest();
  runDisposersForTest();
  assert.equal(count, 1, "a second signal must not double-run a disposer");
});

test("a throwing disposer does not block the others", () => {
  const ran = [];
  registerDisposer(() => {
    ran.push("before");
  });
  registerDisposer(() => {
    throw new Error("boom");
  });
  registerDisposer(() => {
    ran.push("after");
  });
  // Must not throw out of the run: one bad cleanup is swallowed, the rest still run
  assert.doesNotThrow(() => runDisposersForTest());
  assert.deepEqual(ran, ["before", "after"]);
  assert.equal(activeDisposerCount(), 0);
});
