import { test } from "node:test";
import assert from "node:assert/strict";
import { mainThread, REANCHOR_MAX_MARKER_SHARE } from "../../dist/trace/main-thread.js";
import { RUN_START_MARK } from "../../dist/model/marks.js";

// mainThread() picks the renderer main thread the counts and the bar scope to, and flags a
// successive cross-process navigation (meta.mainThread.split) that leaves the counts covering only
// the busiest thread. split feeds countIntegrityRefusal, so its floor decides which second
// navigation's rendering is silently dropped from an assert/diff count gate. The floor is the SAME
// husk share the re-anchor uses (REANCHOR_MAX_MARKER_SHARE): a disjoint thread at or above it is a
// real second navigation; below it is a husk or stray flush. [measured, docs/dev/rendering-counts.md]
// a genuine second navigation of 41 flushes against a 201-flush first page (~20%) trips split; a floor
// above the husk share left those flushes silently uncounted.

/** Layout events on one renderer thread, ts running from startTs. mainThread reads name/ts/pid/tid/kind. */
function layoutEvents(pid, tid, count, startTs) {
  const events = [];
  for (let index = 0; index < count; index++)
    events.push({ name: "Layout", kind: "layout", ts: startTs + index, pid, tid });
  return events;
}

function marker(pid, tid, ts = 1000) {
  return { name: RUN_START_MARK, kind: "usertiming", ts, pid, tid };
}

test("REANCHOR_MAX_MARKER_SHARE is the shared husk share (5%)", () => {
  assert.equal(REANCHOR_MAX_MARKER_SHARE, 0.05);
});

test("single-process run: marker thread did the work, no split", () => {
  const events = [marker(10, 1), ...layoutEvents(10, 1, 200, 1001)];
  const selection = mainThread(events);
  assert.deepEqual(selection, { pid: 10, tid: 1, via: "marker", split: false });
});

test("a second navigation at ~20% of the busiest trips split (the flip the floor pins)", () => {
  // busiest = marker thread A (200 flushes); a disjoint thread B renders 41 (20%) AFTER A.
  const events = [
    marker(10, 1),
    ...layoutEvents(10, 1, 200, 1001), // A: [1001, 1200]
    ...layoutEvents(11, 1, 41, 5000), // B: [5000, 5040], disjoint after A
  ];
  const selection = mainThread(events);
  assert.equal(selection.split, true, "20% second navigation is a real split, counts are incomplete");
  assert.equal(selection.pid, 10, "the busiest (first) thread stays selected");
});

test("a sub-husk-share disjoint thread is noise, not a split", () => {
  // B renders 8 flushes (4%), below the 5% husk share of a 200-flush busiest -> not a split.
  const events = [
    marker(10, 1),
    ...layoutEvents(10, 1, 200, 1001),
    ...layoutEvents(11, 1, 8, 5000),
  ];
  assert.equal(mainThread(events).split, false);
});

test("a concurrent (overlapping) heavy thread is an OOPIF, not a split", () => {
  // B is as busy as A but its window OVERLAPS A's: a same-page out-of-process iframe, never a split.
  const events = [
    marker(10, 1),
    ...layoutEvents(10, 1, 200, 1001), // A: [1001, 1200]
    ...layoutEvents(11, 1, 200, 1100), // B: [1100, 1299], overlaps A
  ];
  assert.equal(mainThread(events).split, false);
});

test("a re-anchored blank-host husk does not also read as a split", () => {
  // marker thread M is a pre-nav husk (5 flushes) disjoint before the target T (200): re-anchor to T,
  // and the husk sits below the husk-share floor so it is not a second-navigation split.
  const events = [
    marker(9, 1),
    ...layoutEvents(9, 1, 5, 1001), // M husk: [1001, 1005]
    ...layoutEvents(12, 1, 200, 5000), // T target: [5000, 5199]
  ];
  const selection = mainThread(events);
  assert.equal(selection.via, "reanchored", "the husk marker re-anchors to the target");
  assert.deepEqual({ pid: selection.pid, tid: selection.tid }, { pid: 12, tid: 1 });
  assert.equal(selection.split, false, "the husk is not a second navigation");
});

test("the Math.max(3, ...) noise floor guards a near-empty busiest thread", () => {
  // busiest is tiny (20 flushes); 5% of it is 1, so the absolute floor of 3 governs: a 2-flush
  // neighbour is noise, not a split.
  const events = [
    marker(10, 1),
    ...layoutEvents(10, 1, 20, 1001),
    ...layoutEvents(11, 1, 2, 5000),
  ];
  assert.equal(mainThread(events).split, false, "2 flushes stays under the absolute noise floor");
});
