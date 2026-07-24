import { test } from "node:test";
import assert from "node:assert/strict";
import { hasBlameEventLog } from "../../dist/model/capture-mode.js";

// Whether a recording actually carries a read-site blame / event log a reader can answer from. --deep
// and firefox always store it. --breakdown stores a SAMPLED read-site log ONLY when the trace emitted
// per-sample lines, recorded as blameSemantic === "flush-site"; an old --breakdown recording or one
// whose browser emitted no lines has an EMPTY log that must degrade to unavailable, never read as clean.

test("hasBlameEventLog: deep and firefox always carry the event log", () => {
  assert.equal(hasBlameEventLog(["deep"], "flush-site"), true, "--deep stores the full log");
  assert.equal(hasBlameEventLog(["deep"], undefined), true, "--deep, semantic aside, has the log");
  assert.equal(hasBlameEventLog(["gecko"], "flush-site"), true, "firefox default stores it");
  assert.equal(hasBlameEventLog(["gecko-deep"], "flush-site"), true, "firefox --deep stores it");
});

test("hasBlameEventLog: --breakdown carries blame only with the flush-site capability flag", () => {
  assert.equal(
    hasBlameEventLog(["breakdown"], "flush-site"),
    true,
    "a --breakdown run whose trace emitted per-sample lines carries sampled blame",
  );
});

test("hasBlameEventLog: --breakdown WITHOUT the capability degrades to unavailable", () => {
  // The no-data.lines case (record cleared blameSemantic) and an old --breakdown recording (never set
  // it): both hold an empty log, so blame is unavailable, not a clean/miss result.
  assert.equal(
    hasBlameEventLog(["breakdown"], undefined),
    false,
    "no sampled lines => no blame log, never empty-as-clean",
  );
});

test("hasBlameEventLog: sampler-only capture modes carry no event log", () => {
  assert.equal(hasBlameEventLog(["default"], undefined), false, "default capture has no event log");
  assert.equal(hasBlameEventLog(["precise-wall"], undefined), false, "--precise-wall has none");
  assert.equal(hasBlameEventLog(["node-cpu"], undefined), false, "the node lane has none");
});
