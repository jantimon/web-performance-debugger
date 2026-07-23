import { test } from "node:test";
import assert from "node:assert/strict";
import { sampledForcedBlameEvents } from "../../dist/trace/sampled-blame.js";

// The pure join behind chrome --breakdown sampled read-site forced-layout blame: it pairs a
// main-thread layout/style flush window with an in-window CPU sample and emits a sampled blame event
// carrying the sample's executing line (docs/dev/blame-semantics.md). Raw output only (pre-resolution):
// runpass runs attachStacks + markForced on it afterward.

const flush = (kind, ts, dur, extra = {}) => ({
  id: 0,
  name: kind === "style" ? "UpdateLayoutTree" : "Layout",
  ts,
  dur,
  ph: "X",
  kind,
  ...extra,
});

/** A stream with one sample per (nodeId, ts, line) triple, and a url per node. */
const streamOf = (rows, intervalUs, urls) => ({
  urlByNode: new Map(Object.entries(urls).map(([id, url]) => [Number(id), url])),
  samples: rows.map((row) => row.node),
  timestampsUs: rows.map((row) => row.ts),
  lines: rows.map((row) => row.line),
  intervalUs,
});

const APP = "http://127.0.0.1:5000/app.js";

test("sampledForcedBlameEvents: exact executing line on a flush wider than one interval (confident)", () => {
  const events = [flush("layout", 1000, 500)]; // 500us > 150us interval => confident
  const stream = streamOf([{ node: 1, ts: 1100, line: 42 }], 150, { 1: APP });
  const out = sampledForcedBlameEvents(events, stream, null, null);
  assert.equal(out.length, 1, "one sampled blame event for the flush");
  const event = out[0];
  assert.equal(event.kind, "layout");
  assert.equal(event.name, "Layout");
  assert.equal(event.sampled, true, "marked sampled so summarize never counts it as a flush");
  const frame = event.args.data.stackTrace[0];
  assert.equal(frame.url, APP);
  assert.equal(frame.lineNumber, 42, "the sample's executing line, not a function-definition line");
  assert.ok(!("lowConfidence" in event.args.data), "a wide flush is not low-confidence");
});

test("sampledForcedBlameEvents: style flush emits a RecalcStyles event", () => {
  const events = [flush("style", 1000, 500)];
  const stream = streamOf([{ node: 1, ts: 1100, line: 7 }], 150, { 1: APP });
  const out = sampledForcedBlameEvents(events, stream, null, null);
  assert.equal(out[0].name, "RecalcStyles");
  assert.equal(out[0].kind, "style");
});

test("sampledForcedBlameEvents: no event when no sample lands in the flush window", () => {
  const events = [flush("layout", 5000, 100)];
  // samples sit before and after the window, none inside [5000, 5100].
  const stream = streamOf(
    [
      { node: 1, ts: 4000, line: 10 },
      { node: 1, ts: 9000, line: 10 },
    ],
    150,
    { 1: APP },
  );
  assert.deepEqual(sampledForcedBlameEvents(events, stream, null, null), []);
});

test("sampledForcedBlameEvents: a sub-interval flush is marked low-confidence", () => {
  const events = [flush("layout", 1000, 50)]; // 50us < 150us interval
  const stream = streamOf([{ node: 1, ts: 1010, line: 42 }], 150, { 1: APP });
  const out = sampledForcedBlameEvents(events, stream, null, null);
  assert.equal(out.length, 1);
  assert.equal(out[0].args.data.lowConfidence, true, "a flush narrower than the interval is low-confidence");
});

test("sampledForcedBlameEvents: a tool-frame leaf is skipped, a later user sample is picked", () => {
  const events = [flush("layout", 1000, 500)];
  // First in-window sample is a puppeteer/harness frame; the join keeps scanning to the user frame.
  const stream = streamOf(
    [
      { node: 2, ts: 1050, line: 99 }, // tool frame (debugger://) -> skipped
      { node: 1, ts: 1100, line: 42 }, // user frame -> picked
    ],
    150,
    { 1: APP, 2: "debugger://internal" },
  );
  const out = sampledForcedBlameEvents(events, stream, null, null);
  assert.equal(out.length, 1, "the tool frame did not blank the flush");
  assert.equal(out[0].args.data.stackTrace[0].lineNumber, 42, "the user frame's line is blamed");
});

test("sampledForcedBlameEvents: a flush whose only sample is a tool frame emits nothing", () => {
  const events = [flush("layout", 1000, 500)];
  const stream = streamOf([{ node: 2, ts: 1100, line: 99 }], 150, { 2: "debugger://internal" });
  assert.deepEqual(sampledForcedBlameEvents(events, stream, null, null), []);
});

test("sampledForcedBlameEvents: an empty-url (native accessor) leaf is skipped", () => {
  const events = [flush("layout", 1000, 500)];
  const stream = streamOf([{ node: 3, ts: 1100, line: 5 }], 150, { 3: "" });
  assert.deepEqual(sampledForcedBlameEvents(events, stream, null, null), []);
});

test("sampledForcedBlameEvents: no lines array => no sampled events at all (never a definition line)", () => {
  const events = [flush("layout", 1000, 500)];
  const stream = { urlByNode: new Map([[1, APP]]), samples: [1], timestampsUs: [1100], lines: [], intervalUs: 150 };
  assert.deepEqual(sampledForcedBlameEvents(events, stream, null, null), [], "empty lines degrades to unavailable");
});

test("sampledForcedBlameEvents: a sample line <= 0 (no position) is skipped", () => {
  const events = [flush("layout", 1000, 500)];
  const stream = streamOf([{ node: 1, ts: 1100, line: -1 }], 150, { 1: APP });
  assert.deepEqual(sampledForcedBlameEvents(events, stream, null, null), []);
});

test("sampledForcedBlameEvents: windows to the run start and the main thread", () => {
  const events = [
    { ...flush("layout", 500, 200), pid: 1, tid: 1 }, // before windowStart 1000 -> excluded
    { ...flush("layout", 2000, 200), pid: 1, tid: 1 }, // main thread, in window -> kept
    { ...flush("layout", 3000, 200), pid: 1, tid: 9 }, // off-thread -> excluded
  ];
  const stream = streamOf(
    [
      { node: 1, ts: 600, line: 1 },
      { node: 1, ts: 2100, line: 2 },
      { node: 1, ts: 3100, line: 3 },
    ],
    150,
    { 1: APP },
  );
  const out = sampledForcedBlameEvents(events, stream, 1000, { pid: 1, tid: 1 });
  assert.equal(out.length, 1, "only the in-window main-thread flush is blamed");
  assert.equal(out[0].args.data.stackTrace[0].lineNumber, 2);
});

test("sampledForcedBlameEvents: an already-sampled event is never re-blamed (no double annotation)", () => {
  const events = [{ ...flush("layout", 1000, 500), sampled: true }];
  const stream = streamOf([{ node: 1, ts: 1100, line: 42 }], 150, { 1: APP });
  assert.deepEqual(sampledForcedBlameEvents(events, stream, null, null), []);
});

test("sampledForcedBlameEvents: every emitted event carries sampled:true", () => {
  const events = [flush("layout", 1000, 500), flush("style", 2000, 500)];
  const stream = streamOf(
    [
      { node: 1, ts: 1100, line: 42 },
      { node: 1, ts: 2100, line: 7 },
    ],
    150,
    { 1: APP },
  );
  const out = sampledForcedBlameEvents(events, stream, null, null);
  assert.equal(out.length, 2);
  assert.ok(out.every((event) => event.sampled === true), "all sampled, so summarize skips them");
});
