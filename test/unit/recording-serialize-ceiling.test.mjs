import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { writeRecording } from "../../dist/record/artifacts.js";

// The trace now parses past the ~512MB single-string ceiling event by event, but a --deep/firefox
// recording stores the full event log, so a heavy enough journey grows that log past the same limit
// JSON.stringify can produce. writeRecording must name that failure (the deep event log, the remedy),
// not surface a bare "Invalid string length" RangeError.
test("writeRecording names the event-log serialization ceiling instead of a bare RangeError", async () => {
  // One event whose args string is the longest a JS string can be; JSON.stringify wraps it in quotes,
  // which tips it past the ceiling and throws exactly as a real oversized event log would.
  const maxString = "a".repeat(0x1fffffe8);
  const recording = { events: [{ id: 0, args: maxString }] };
  const outPath = path.join(os.tmpdir(), `wpd-serialize-ceiling-${process.pid}.json`);

  await assert.rejects(writeRecording(outPath, recording, "json"), (error) => {
    assert.match(error.message, /trace events whose JSON is larger than the ~512MB/, "names the ceiling");
    assert.match(error.message, /--deep stores the full event log/, "names the deep event log");
    assert.match(error.message, /--breakdown/, "offers the lighter-trace remedy");
    assert.doesNotMatch(error.message, /Invalid string length/, "not the bare RangeError text");
    return true;
  });
});
