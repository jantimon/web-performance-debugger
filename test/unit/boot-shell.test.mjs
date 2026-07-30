import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikePreAppShell } from "../../dist/model/boot-shell.js";

// The pre-app-shell heuristic (model/boot-shell.ts): the built-in --url load flow booted but did
// near-zero work, the tell of a consent/region shell measured in place of the app. Note-tier only.
// Anchored to a field case (~3ms JS self-time/iteration, near-zero layout/style/paint counts) versus
// a real SPA boot (~14ms JS self-time, hundreds of counts). Thresholds: 5ms JS / 20 counts per iter.

// A near-zero-work boot on a counting capture (both JS self-time and counts measured).
const shellCase = {
  isBuiltinLoad: true,
  jsSelfMs: 3,
  layoutCount: 2,
  styleCount: 2,
  paintCount: 1,
  iterations: 1,
};

test("fires on a counting-capture boot with near-zero JS and near-zero counts", () => {
  assert.equal(looksLikePreAppShell(shellCase), true);
});

test("does not fire when the boot ran real JS (a real app boot)", () => {
  // A react-counter-class boot spends ~14ms of its own scripting per iteration: above the 5ms floor.
  assert.equal(looksLikePreAppShell({ ...shellCase, jsSelfMs: 14 }), false);
});

test("does not fire when the boot committed real rendering work", () => {
  // Hundreds of layout/style operations is a real app rendering, not a static shell.
  assert.equal(looksLikePreAppShell({ ...shellCase, layoutCount: 300 }), false);
});

test("never fires outside the built-in load flow (a driver/bench module)", () => {
  assert.equal(looksLikePreAppShell({ ...shellCase, isBuiltinLoad: false }), false);
});

test("does not treat not-measured counts as near-zero (default capture leaves them null)", () => {
  // Default mode measures jsSelfMs but not the counts. A null count is not-measured, never 0, so the
  // heuristic needs a counting capture and refuses to read null as clean.
  assert.equal(looksLikePreAppShell({ ...shellCase, layoutCount: null }), false);
  assert.equal(looksLikePreAppShell({ ...shellCase, styleCount: null }), false);
});

test("does not fire when JS self-time was not measured (--deep has no sampler)", () => {
  assert.equal(looksLikePreAppShell({ ...shellCase, jsSelfMs: null }), false);
});

test("fires on firefox, where paint is off-main-thread (not-measured), summing only measured counts", () => {
  assert.equal(looksLikePreAppShell({ ...shellCase, paintCount: null }), true);
});

test("thresholds are per-iteration: counts and JS scale with --iterations", () => {
  // 10 iterations of the shell case: totals are 10x, but per-iteration they stay under the floors.
  const tenIter = {
    isBuiltinLoad: true,
    jsSelfMs: 30,
    layoutCount: 20,
    styleCount: 20,
    paintCount: 10,
    iterations: 10,
  };
  assert.equal(looksLikePreAppShell(tenIter), true);
  // A real boot at 10 iterations: 140ms JS total => 14ms/iter, above the floor.
  assert.equal(looksLikePreAppShell({ ...tenIter, jsSelfMs: 140 }), false);
});
