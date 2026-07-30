import { test } from "node:test";
import assert from "node:assert/strict";
import {
  storesFullTraceEventLog,
  deepEventLogWouldOverflow,
  DEEP_EVENT_LOG_TRACE_BYTE_CEILING,
} from "../../dist/model/capture-mode.js";
import { deepEventLogOverflowError } from "../../dist/record/artifacts.js";

// The --deep preflight refuses a trace too heavy for its stored event log to serialize, at capture
// time (before the parse can OOM). It is pure over (mode, trace byte length), so it is unit-testable
// without a browser or a giant fixture

test("storesFullTraceEventLog: only chrome --deep stores the full trace event log", () => {
  assert.equal(storesFullTraceEventLog("deep"), true, "--deep stores every event for blame");
  for (const mode of ["breakdown", "default", "gecko", "gecko-deep", "node-cpu"]) {
    assert.equal(
      storesFullTraceEventLog(mode),
      false,
      `${mode} does not store the full chrome trace event log`,
    );
  }
});

test("DEEP_EVENT_LOG_TRACE_BYTE_CEILING is the 180MB floor", () => {
  assert.equal(DEEP_EVENT_LOG_TRACE_BYTE_CEILING, 180 * 1024 * 1024);
});

test("deepEventLogWouldOverflow: fires on a --deep trace above the floor only", () => {
  const ceiling = DEEP_EVENT_LOG_TRACE_BYTE_CEILING;
  assert.equal(deepEventLogWouldOverflow("deep", ceiling + 1), true, "one byte over refuses");
  assert.equal(deepEventLogWouldOverflow("deep", ceiling), false, "at the floor is allowed");
  assert.equal(deepEventLogWouldOverflow("deep", ceiling - 1), false, "under the floor is allowed");
  assert.equal(deepEventLogWouldOverflow("deep", 1024), false, "a small --deep trace is allowed");
});

test("deepEventLogWouldOverflow: never fires on a mode that stores no full event log", () => {
  const huge = DEEP_EVENT_LOG_TRACE_BYTE_CEILING * 4;
  for (const mode of ["breakdown", "default", "gecko", "gecko-deep"]) {
    assert.equal(
      deepEventLogWouldOverflow(mode, huge),
      false,
      `${mode} parses past the ceiling by design`,
    );
  }
});

test("deepEventLogOverflowError: names the trace size, the ~512MB ceiling and the remedy", () => {
  const message = deepEventLogOverflowError(200 * 1024 * 1024).message;
  assert.match(message, /~200MB/, "names the raw trace size");
  assert.match(message, /~512MB/, "names the single-JSON-string ceiling");
  assert.match(message, /fewer --iterations/, "the iteration reducer is in the remedy");
  assert.match(message, /--breakdown/, "the --breakdown remedy is named");
});
