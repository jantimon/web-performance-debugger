import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySoftNavAgreement } from "../../dist/model/soft-nav.js";
import { shapeEngineSoftNav } from "../../dist/browser/driver.js";

// classifySoftNavAgreement reconciles the two independent navigation verdicts for a step: the
// always-available url+timeOrigin classifier and Chrome's own soft-navigation heuristic. It is a pure
// function, so the four cells of {engine fired?} x {classifier soft?} are unit-tested without a browser.

const engineFired = (navigationType = "push") => ({ count: 1, navigationTypes: [navigationType] });

test("engine fired + classifier soft -> agree (engine confirms the classifier)", () => {
  const verdict = classifySoftNavAgreement("soft", engineFired("push"));
  assert.equal(verdict.agreement, "agree");
  assert.match(verdict.note, /agrees/);
  assert.match(verdict.note, /push/, "the note names the navigationType");
  // soft-hash is a soft change too.
  assert.equal(classifySoftNavAgreement("soft-hash", engineFired()).agreement, "agree");
});

test("classifier soft + NO engine entry -> classifier-only (the false-negative class)", () => {
  const verdict = classifySoftNavAgreement("soft", undefined);
  assert.equal(verdict.agreement, "classifier-only");
  // The note states BOTH verdicts and names the known cause classes, without picking a winner.
  assert.match(verdict.note, /url\+timeOrigin/);
  assert.match(verdict.note, /soft-navigation heuristic/);
  assert.match(verdict.note, /trusted interaction/);
  assert.match(verdict.note, /programmatic history change|untrusted synthetic click/);
  assert.match(verdict.note, /both facts/i);
  // An engineSoftNav present but with count 0 is treated as "not fired".
  assert.equal(
    classifySoftNavAgreement("soft", { count: 0, navigationTypes: [] }).agreement,
    "classifier-only",
  );
});

test("engine fired + classifier none/hard -> engine-only (unexpected; both recorded)", () => {
  const none = classifySoftNavAgreement("none", engineFired("push"));
  assert.equal(none.agreement, "engine-only");
  assert.match(none.note, /soft-navigation heuristic fired/);
  assert.match(none.note, /"none"/, "the note names the classifier verdict");
  assert.equal(classifySoftNavAgreement("hard", engineFired()).agreement, "engine-only");
});

test("neither soft -> none (nothing to reconcile, no note)", () => {
  const verdict = classifySoftNavAgreement("none", undefined);
  assert.equal(verdict.agreement, "none");
  assert.equal(verdict.note, undefined);
  // A hard navigation with no engine entry is also "none" (nothing to disclose).
  assert.equal(classifySoftNavAgreement("hard", undefined).agreement, "none");
  // An undefined classifier (a non-step span) with no engine entry too.
  assert.equal(classifySoftNavAgreement(undefined, undefined).agreement, "none");
});

// shapeEngineSoftNav folds the raw in-page entries into the stored EngineSoftNav, keeping only the
// fields per-soft-step metrics slice by, and returns null (not a fabricated 0) when none fired.

test("shapeEngineSoftNav returns null when no entry fired (absence stays absence)", () => {
  assert.equal(shapeEngineSoftNav([]), null);
});

test("shapeEngineSoftNav keeps count, navigationTypes, and the id arrays", () => {
  const shaped = shapeEngineSoftNav([
    { url: "http://x/route-b", navigationType: "push", navigationId: 748, interactionId: 9759 },
  ]);
  assert.equal(shaped.count, 1);
  assert.deepEqual(shaped.navigationTypes, ["push"]);
  assert.deepEqual(shaped.navigationIds, [748]);
  assert.deepEqual(shaped.interactionIds, [9759]);
});

test("shapeEngineSoftNav drops id arrays a build did not populate (NaN/0), keeps count", () => {
  const shaped = shapeEngineSoftNav([
    { url: "http://x/b", navigationType: "replace", navigationId: NaN, interactionId: 0 },
  ]);
  assert.equal(shaped.count, 1);
  assert.deepEqual(shaped.navigationTypes, ["replace"]);
  assert.ok(!("navigationIds" in shaped), "a non-finite navigationId is dropped");
  assert.ok(!("interactionIds" in shaped), "a zero interactionId is dropped");
});
