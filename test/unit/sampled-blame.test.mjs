import { test } from "node:test";
import assert from "node:assert/strict";
import { sampledForcedBlameEvents } from "../../dist/trace/sampled-blame.js";

// The pure join behind chrome --breakdown sampled read-site forced-layout blame: it pairs a
// main-thread layout/style flush window with an in-window CPU sample and emits a sampled blame event
// carrying the sample's executing line (docs/dev/blame-semantics.md). Raw output only (pre-resolution):
// runpass runs attachStacks + markForced on it afterward

const flush = (kind, ts, dur, extra = {}) => ({
  id: 0,
  name: kind === "style" ? "UpdateLayoutTree" : "Layout",
  ts,
  dur,
  ph: "X",
  kind,
  ...extra,
});

/** A stream with one sample per (nodeId, ts, line) triple, and a url per node */
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

test("sampledForcedBlameEvents: emits the leaf function's callFrame fallback (1-based) when frameByNode is present", () => {
  const events = [flush("layout", 1000, 500)];
  const stream = {
    ...streamOf([{ node: 1, ts: 1100, line: 42 }], 150, { 1: APP }),
    /** 0-based CDP callFrame position; the join shifts it +1 to the trace-stack convention */
    frameByNode: new Map([[1, { line: 7, column: 28454 }]]),
  };
  const out = sampledForcedBlameEvents(events, stream, null, null);
  const frame = out[0].args.data.stackTrace[0];
  assert.equal(frame.lineOnly, true);
  assert.equal(frame.fallbackLine, 8, "leaf callFrame line, shifted 0-based -> 1-based");
  assert.equal(frame.fallbackColumn, 28455, "leaf callFrame column, shifted 0-based -> 1-based");
});

test("sampledForcedBlameEvents: no fallback fields when a positionless (-1) leaf frame", () => {
  const events = [flush("layout", 1000, 500)];
  const stream = {
    ...streamOf([{ node: 1, ts: 1100, line: 42 }], 150, { 1: APP }),
    frameByNode: new Map([[1, { line: -1, column: -1 }]]),
  };
  const frame = sampledForcedBlameEvents(events, stream, null, null)[0].args.data.stackTrace[0];
  assert.ok(!("fallbackLine" in frame), "a positionless leaf frame carries no fallback");
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
  // samples sit before and after the window, none inside [5000, 5100]
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
  // First in-window sample is a puppeteer/harness frame; the join keeps scanning to the user frame
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

// The boundary of the "no position" guard is line <= 0, so line 0 is NOT a position and yields no
// blame -- 0 is the CDP no-line sentinel, not the first line. Pins the `<= 0` boundary (a `< 0`
// off-by-one would blame a definition-less sample on line 0)
test("sampledForcedBlameEvents: a sample line of exactly 0 is skipped, never blamed as line 0", () => {
  const events = [flush("layout", 1000, 500)];
  const stream = streamOf([{ node: 1, ts: 1100, line: 0 }], 150, { 1: APP });
  assert.deepEqual(sampledForcedBlameEvents(events, stream, null, null), [], "line 0 is no position, not the first line");
});

// The low-confidence flag is for a flush NARROWER than one sampler interval (docs/dev/blame-semantics.md):
// `dur < intervalUs`. A flush EXACTLY one interval wide is not narrower, so it is confident. Pins the
// strict `<` boundary (a `<=` would wrongly flag an interval-wide flush low-confidence)
test("sampledForcedBlameEvents: a flush exactly one interval wide is confident (not low-confidence)", () => {
  const events = [flush("layout", 1000, 150)]; // dur == intervalUs 150, not narrower
  const stream = streamOf([{ node: 1, ts: 1100, line: 42 }], 150, { 1: APP });
  const out = sampledForcedBlameEvents(events, stream, null, null);
  assert.equal(out.length, 1, "an interval-wide flush is still blamed");
  assert.ok(!("lowConfidence" in out[0].args.data), "dur == interval is not narrower than the interval, so it is confident");
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

// The merged CPU stream interleaves every isolate (a navigation swaps renderer, a worker/OOPIF runs in
// parallel). A main-thread flush must be blamed only on a sample that ran on THAT thread: a worker
// sample that overlaps the flush window carries an unrelated source line and must be skipped, even when
// it is the FIRST in-window sample. Without the per-sample thread guard the worker's line would be
// attributed to the main-thread flush
test("sampledForcedBlameEvents: a same-timestamp worker sample is not attributed to a main-thread flush", () => {
  const events = [{ ...flush("layout", 1000, 500), pid: 1, tid: 1 }]; // main thread pid1/tid1
  const WORKER = "http://127.0.0.1:5000/worker.js";
  const stream = {
    urlByNode: new Map([
      [1, APP],
      [2, WORKER],
    ]),
    /** The worker sample lands FIRST inside the window; the main-thread sample follows */
    samples: [2, 1],
    timestampsUs: [1100, 1300],
    lines: [99, 42],
    threads: [
      { pid: 1, tid: 7 }, // a worker thread
      { pid: 1, tid: 1 }, // the main thread
    ],
    intervalUs: 150,
  };
  const out = sampledForcedBlameEvents(events, stream, null, { pid: 1, tid: 1 });
  assert.equal(out.length, 1, "the flush is still blamed, from a same-thread sample");
  assert.equal(
    out[0].args.data.stackTrace[0].lineNumber,
    42,
    "the main-thread sample's line, never the earlier worker sample's",
  );
  assert.equal(out[0].args.data.stackTrace[0].url, APP, "the worker url is skipped");
});

// A flush whose ONLY in-window sample ran on another thread yields no blame (the same cheap-read miss
// as no sample at all), never a fabricated cross-thread line
test("sampledForcedBlameEvents: a flush with only an off-thread sample yields nothing", () => {
  const events = [{ ...flush("layout", 1000, 500), pid: 1, tid: 1 }];
  const stream = {
    urlByNode: new Map([[2, "http://127.0.0.1:5000/worker.js"]]),
    samples: [2],
    timestampsUs: [1100],
    lines: [99],
    threads: [{ pid: 1, tid: 7 }],
    intervalUs: 150,
  };
  assert.deepEqual(sampledForcedBlameEvents(events, stream, null, { pid: 1, tid: 1 }), []);
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
