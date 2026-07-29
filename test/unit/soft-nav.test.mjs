import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySoftNavAgreement } from "../../dist/model/soft-nav.js";
import { shapeEngineSoftNav, shapeSoftNavRoute } from "../../dist/browser/driver.js";

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

// shapeSoftNavRoute folds a soft-navigating step's raw entries into the stored route metrics, slicing
// CLS/INP strictly by the soft nav's navigationId and anchoring the route LCP to its startTime. Pure, so
// the slicing (and the triggering-interaction exclusion) is unit-tested with synthetic entries.

const softNavEntry = (over = {}) => ({
  url: "http://x/route-b",
  navigationType: "push",
  navigationId: 200,
  interactionId: 11,
  startTimeMs: 1000,
  lcpUrl: "http://x/hero.png",
  lcpSize: 187800,
  lcpTag: "IMG",
  lcpRenderTimeMs: 1428,
  ...over,
});
// A layout-shift entry carrying a navigationId (500ms apart -> one session window unless > gap).
const shiftEntry = (navigationId, value, startTimeMs, over = {}) => ({
  value,
  hadRecentInput: false,
  startTimeMs,
  navigationId,
  sources: [
    {
      tag: "DIV",
      id: "banner",
      className: "",
      previousRect: { x: 0, y: 0, width: 100, height: 10 },
      currentRect: { x: 0, y: 40, width: 100, height: 10 },
    },
  ],
  ...over,
});
const eventEntry = (navigationId, duration, over = {}) => ({
  startTime: 1500,
  processingStart: 1510,
  processingEnd: 1540,
  duration,
  interactionId: 21,
  navigationId,
  ...over,
});

test("shapeSoftNavRoute returns null when no engine soft-nav fired (keys on the engine's verdict)", () => {
  // Even with shifts and interactions present, no soft-nav entry means no navigationId to slice by.
  assert.equal(shapeSoftNavRoute([], [shiftEntry(200, 0.1, 1600)], [eventEntry(200, 48)]), null);
});

test("shapeSoftNavRoute anchors the route LCP to the soft nav's startTime (the route clock)", () => {
  const route = shapeSoftNavRoute([softNavEntry()], [], []);
  assert.equal(route.navigationId, 200);
  assert.equal(route.navigationType, "push");
  assert.equal(route.url, "http://x/route-b");
  // routeMs is renderTime - startTime (1428 - 1000), NOT the absolute document-clock renderTime.
  assert.equal(route.routeLcp.routeMs, 428);
  assert.equal(route.routeLcp.tag, "IMG");
  assert.equal(route.routeLcp.url, "http://x/hero.png");
  assert.equal(route.routeLcp.size, 187800);
});

test("shapeSoftNavRoute keeps a TAO-gated route LCP's identity but drops routeMs (renderTime reads 0)", () => {
  const route = shapeSoftNavRoute([softNavEntry({ lcpRenderTimeMs: 0 })], [], []);
  assert.ok(!("routeMs" in route.routeLcp), "no usable render time -> no routeMs, never a fake 0");
  assert.equal(route.routeLcp.tag, "IMG");
  assert.equal(route.routeLcp.size, 187800);
});

test("shapeSoftNavRoute omits routeLcp entirely when the entry carried no paint at all", () => {
  const bare = softNavEntry({ lcpUrl: "", lcpSize: 0, lcpTag: "", lcpRenderTimeMs: 0 });
  const route = shapeSoftNavRoute([bare], [], []);
  assert.ok(!("routeLcp" in route), "no identity and no timing -> no routeLcp");
  assert.equal(route.navigationId, 200, "the route is still reported for CLS/INP slicing");
});

test("shapeSoftNavRoute slices route CLS by navigationId (post-route shifts only)", () => {
  // Two shifts carry the route id 200 (post-route) and land <1s apart -> one session window scored 0.30.
  // A third shift carries the PRE-nav id 199 and must be excluded from the route's CLS.
  const shifts = [
    shiftEntry(199, 0.9, 1050), // pre-nav: excluded
    shiftEntry(200, 0.2, 1600),
    shiftEntry(200, 0.1, 1900),
  ];
  const route = shapeSoftNavRoute([softNavEntry()], shifts, []);
  assert.ok(route.routeCls, "a post-route shift produced a route CLS");
  // Only the two id-200 shifts count: session-window max = 0.2 + 0.1, not the 0.9 pre-nav shift.
  assert.ok(Math.abs(route.routeCls.cls - 0.3) < 1e-9, `route CLS is the id-200 window (${route.routeCls.cls})`);
  assert.equal(route.routeCls.shiftCount, 2, "the pre-nav shift is not in the window");
});

test("shapeSoftNavRoute's route INP excludes the triggering interaction (it carries the pre-nav id)", () => {
  // The triggering click carries the PRE-nav id 199 with a big 320ms latency; the post-route interaction
  // carries the route id 200 at 48ms. Route INP is the post-route one only -- the triggering click stays
  // in the step's main INP, never double-counted here.
  const events = [eventEntry(199, 320, { interactionId: 9 }), eventEntry(200, 48)];
  const route = shapeSoftNavRoute([softNavEntry()], [], events);
  assert.equal(route.routeInpMs, 48, "the 320ms triggering click (pre-nav id) is excluded");
  assert.ok(route.routeInteraction, "the post-route interaction carries a CWV split");
  assert.equal(route.routeInteraction.inputDelayMs, 10);
  assert.equal(route.routeInteraction.processingMs, 30);
});

test("shapeSoftNavRoute leaves route CLS/INP absent when the navigationId is non-finite (nothing to slice by)", () => {
  const route = shapeSoftNavRoute(
    [softNavEntry({ navigationId: NaN })],
    [shiftEntry(NaN, 0.2, 1600)],
    [eventEntry(NaN, 48)],
  );
  assert.ok(!("routeCls" in route), "a non-finite id matches nothing, so no route CLS is fabricated");
  assert.ok(!("routeInpMs" in route), "no route INP either");
});

test("shapeSoftNavRoute reports the FIRST soft nav and counts the rest (additionalSoftNavs)", () => {
  const route = shapeSoftNavRoute(
    [softNavEntry({ navigationId: 200 }), softNavEntry({ navigationId: 201, navigationType: "replace" })],
    [],
    [],
  );
  assert.equal(route.navigationId, 200, "the first soft nav is the one reported");
  assert.equal(route.navigationType, "push");
  assert.equal(route.additionalSoftNavs, 1, "the second is counted, not aggregated");
});
