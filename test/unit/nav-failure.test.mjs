import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinFlowFailureGuidance } from "../../dist/record/nav-failure.js";

// The built-in --url load flow, failing on a SITE-BEHAVIOR class, names the class and points at the
// driver-module escape hatch (no --nav-timeout / no site-level retry: a retry is a measurement
// decision). A non-site-behavior error gets no guidance (a retry only makes those fail slower).

test("navigation timeout gets the escape-hatch guidance", () => {
  const guidance = builtinFlowFailureGuidance(new Error("Navigation timeout of 30000 ms exceeded"));
  assert.ok(guidance);
  assert.ok(/never reached the load event/.test(guidance));
  assert.ok(/driver module/.test(guidance));
  assert.ok(/page\.goto/.test(guidance), "carries a runnable skeleton");
});

test("HTTP/2 stream reset gets the guidance", () => {
  const guidance = builtinFlowFailureGuidance(new Error("net::ERR_HTTP2_PROTOCOL_ERROR at https://x"));
  assert.ok(guidance);
  assert.ok(/HTTP\/2/.test(guidance));
});

test("execution-context-destroyed gets the guidance", () => {
  const guidance = builtinFlowFailureGuidance(
    new Error("Execution context was destroyed, most likely because of a navigation."),
  );
  assert.ok(guidance);
  assert.ok(/self-navigated/.test(guidance));
});

test("a plain bad-host error gets NO guidance (a retry only makes it fail slower)", () => {
  assert.equal(builtinFlowFailureGuidance(new Error("net::ERR_NAME_NOT_RESOLVED")), null);
  assert.equal(builtinFlowFailureGuidance(new Error("some unrelated crash")), null);
});
