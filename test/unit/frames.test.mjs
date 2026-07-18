import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFrames, windowFrames, summarizeFrames } from "../../dist/trace/frames.js";
import { diffCmd } from "../../dist/commands/diff.js";

// The frame track is a single nestable-async track (id2.local "0x1"): PipelineReporter wraps its
// stage slices in strict LIFO order. These fixtures are built from the real shapes measured on a
// 20-box paint (FP-1): `args.frame_reporter.{state,frame_sequence,affects_smoothness}` on the "b",
// stages nested between. Timestamps are microseconds (usToMs divides by 1000).
const pr = (ph, ts, asyncId, reporter) => ({
  id: ts,
  name: "PipelineReporter",
  ts,
  dur: 0,
  ph,
  kind: "other",
  asyncId,
  ...(reporter ? { args: { frame_reporter: reporter } } : { args: {} }),
});
const stage = (name, ph, ts, asyncId) => ({
  id: ts,
  name,
  ts,
  dur: 0,
  ph,
  kind: "other",
  asyncId,
});

// One frame each of the four states, on the same async track, properly nested, ts-ordered.
const FRAME_EVENTS = [
  // seq 5: no update desired (a vsync tick with nothing to draw), one stage
  pr("b", 1000, "0x1", { state: "STATE_NO_UPDATE_DESIRED", frame_sequence: 5, affects_smoothness: false }),
  stage("BeginImplFrameToSendBeginMainFrame", "b", 1005, "0x1"),
  stage("BeginImplFrameToSendBeginMainFrame", "e", 1080, "0x1"),
  pr("e", 1080, "0x1"),
  // seq 8: presented, three stages of different b/e durations (40us / 10us / 40us in trace order)
  pr("b", 2000, "0x1", { state: "STATE_PRESENTED_ALL", frame_sequence: 8, affects_smoothness: false }),
  stage("SendBeginMainFrameToCommit", "b", 2010, "0x1"),
  stage("SendBeginMainFrameToCommit", "e", 2050, "0x1"),
  stage("Commit", "b", 2050, "0x1"),
  stage("Commit", "e", 2060, "0x1"),
  stage("SubmitCompositorFrameToPresentationCompositorFrame", "b", 2060, "0x1"),
  stage("SubmitCompositorFrameToPresentationCompositorFrame", "e", 2100, "0x1"),
  pr("e", 2100, "0x1"),
  // seq 9: dropped, and on the smoothness path
  pr("b", 3000, "0x1", { state: "STATE_DROPPED", frame_sequence: 9, affects_smoothness: true }),
  pr("e", 3050, "0x1"),
];

test("parseFrames pairs PipelineReporter b/e, maps state, and captures direct stages", () => {
  const frames = parseFrames(FRAME_EVENTS);
  assert.equal(frames.length, 3);

  const bySeq = new Map(frames.map((frame) => [frame.sequence, frame]));
  assert.equal(bySeq.get(5).state, "noUpdate");
  assert.equal(bySeq.get(8).state, "presented");
  assert.equal(bySeq.get(9).state, "dropped");
  assert.equal(bySeq.get(9).affectsSmoothness, true);
  assert.equal(bySeq.get(8).affectsSmoothness, false);

  // durMs = (e.ts - b.ts) / 1000
  assert.ok(Math.abs(bySeq.get(8).durMs - 0.1) < 1e-9);
  assert.equal(bySeq.get(8).startTs, 2000);

  // the presented frame carries its three direct stages
  const stageNames = bySeq.get(8).stages.map((entry) => entry.name);
  assert.deepEqual(stageNames, ["SendBeginMainFrameToCommit", "Commit", "SubmitCompositorFrameToPresentationCompositorFrame"]);
});

test("parseFrames ignores events with no asyncId (byte-identical non-breakdown modes) and unknown states", () => {
  // Without asyncId (the id parseTrace keeps only in --breakdown mode) there is nothing to pair.
  const noId = FRAME_EVENTS.map((event) => ({ ...event, asyncId: undefined }));
  assert.deepEqual(parseFrames(noId), []);

  // An unrecognized state is dropped rather than bucketed as a fake verdict.
  const unknown = [
    pr("b", 10, "0x2", { state: "STATE_SOMETHING_NEW", frame_sequence: 1, affects_smoothness: false }),
    pr("e", 20, "0x2"),
  ];
  assert.deepEqual(parseFrames(unknown), []);
});

test("windowFrames: run span is start-onward (keeps the settle-tail frame); a sub-span is bounded", () => {
  const frames = parseFrames(FRAME_EVENTS);
  // run window [500, 2500]: start-onward keeps every frame from 500 on, INCLUDING seq 9 at 3000
  // (its presentation lands after run:end, the reason the rule has no upper bound).
  const run = windowFrames(frames, 500, 2500, true);
  assert.deepEqual(run.map((frame) => frame.sequence).sort(), [5, 8, 9]);
  // a bounded step window [1900, 2500) claims only frames whose START falls inside it
  const step = windowFrames(frames, 1900, 2500, false);
  assert.deepEqual(step.map((frame) => frame.sequence), [8]);
});

test("summarizeFrames: tallies verdicts, keeps per-frame records, ranks the slowest presented frame's stages", () => {
  const track = summarizeFrames(parseFrames(FRAME_EVENTS));
  assert.equal(track.presented, 1);
  assert.equal(track.presentedPartial, 0);
  assert.equal(track.dropped, 1);
  assert.equal(track.noUpdate, 1);
  assert.equal(track.total, 3);
  assert.equal(track.frames.length, 3);
  // per-frame record is stripped to the display shape (no startTs / stages)
  const record = track.frames.find((frame) => frame.sequence === 9);
  assert.deepEqual(Object.keys(record).sort(), ["affectsSmoothness", "durMs", "sequence", "state"]);
  // worstStages = the presented frame's stages, sorted by ms desc, capped
  assert.equal(track.worstStages[0].name, "SendBeginMainFrameToCommit");
  assert.ok(track.worstStages[0].ms >= track.worstStages[1].ms);
});

test("summarizeFrames: an empty window returns null so the span leaves `frames` absent", () => {
  assert.equal(summarizeFrames([]), null);
  // a window with only a dropped/noUpdate frame has no worstStages (nothing presented to decompose)
  const track = summarizeFrames(parseFrames([
    pr("b", 1, "0x9", { state: "STATE_DROPPED", frame_sequence: 1, affects_smoothness: false }),
    pr("e", 2, "0x9"),
  ]));
  assert.equal(track.total, 1);
  assert.equal(track.worstStages, undefined);
});

// Guard rail: the side track is DISPLAY-ONLY. It lives on SpanBreakdown.frames, NOT on the summary
// `diff` reads, so two recordings that differ ONLY in their frame side track must produce no
// regression -- the structural enforcement of "frame counts (scheduler noise, 1->28 on unchanged
// code) never gate". A future edit that fed frames into diff would fail here.
test("diff does not regress on the frame side track (display-only invariant)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpd-frames-"));
  const summary = {
    wallMs: 10, inpMs: null, layoutCount: 5, layoutMs: 1, styleCount: 5, styleMs: 1,
    paintCount: 2, paintMs: 1, layoutInvalidations: 0, paintInvalidations: 0, styleInvalidations: 0,
    forcedLayoutCount: 0, forcedLayoutMs: 0, longTaskCount: 0, longestTaskMs: 0,
    scriptingMs: 1, totalEvents: 10, perIteration: [10], stats: null, perStep: [],
  };
  const withFrames = (dropped) => ({
    meta: { schemaVersion: "1", driver: false },
    window: { measure: "wpd:run", startTs: 0, endTs: 10, wallMs: 10 },
    marks: [], metrics: { before: {}, after: {}, delta: {} }, events: [],
    summary,
    breakdowns: [{
      label: "run", kind: "run",
      breakdown: { wallMs: 10, slices: {} },
      frames: { presented: 1, presentedPartial: 0, dropped, noUpdate: 0, total: 1 + dropped, frames: [] },
    }],
  });
  const base = path.join(dir, "base.json");
  const cur = path.join(dir, "cur.json");
  // Identical summaries; only the frame side track differs (0 vs 28 dropped, the measured swing).
  writeFileSync(base, JSON.stringify(withFrames(0)));
  writeFileSync(cur, JSON.stringify(withFrames(28)));

  const savedExit = process.exitCode;
  const savedLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await diffCmd(base, cur, { failOnRegression: true });
  } finally {
    console.log = savedLog;
    const exit = process.exitCode;
    process.exitCode = savedExit;
    assert.notEqual(exit, 1, "a frame-only difference must not fail the diff");
  }
  assert.match(lines.join("\n"), /No regressions/);
});
