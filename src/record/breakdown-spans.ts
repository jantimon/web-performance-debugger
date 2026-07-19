import {
  packagesByProfileNode,
  functionIdByNode,
  type RawCpuProfile,
} from "../profile/cpuprofile.js";
import { computeSpanBreakdown, type BreakdownSample } from "../trace/breakdown.js";
import { tallySpanHot, type SpanHotSample, type SpanHotWindow } from "../profile/span-hot.js";
import { parseFrames, windowFrames, summarizeFrames } from "../trace/frames.js";
import type { MergedStep } from "../trace/steps.js";
import type { SourceMapResolver } from "../trace/sourcemap.js";
import { WPD_MARK_PREFIX } from "../model/marks.js";
import { usToMs } from "../model/time.js";
import { breakdownHeuristicMainThread, samplerCoverageGap } from "./notes.js";
import { mainThread } from "../trace/main-thread.js";
import { mergeSpanOccurrences } from "../model/span-merge.js";
import type { NormalizedEvent, SpanBreakdown, SpanHot } from "../model/recording.js";

/** Pair user `performance.measure` async begin/end trace events (blink.user_timing, ph b/e) into
 * named windows. wpd's own `wpd:*` measures are excluded -- the run/step spans come from marks, not
 * here. EVERY in-window occurrence is returned, including a label repeated across --iterations and
 * sequentially within one iteration: those repetitions are the label's samples, merged per label
 * downstream (see model/span-merge.ts). Pairing is FIFO per label, so NESTED or overlapping
 * same-label measures cross-pair into wrong windows; sequential repeats only. Order is by end
 * event, so the first occurrence of each label comes first. */
export function userMeasureSpans(
  events: NormalizedEvent[],
  runStart: number,
  runEnd: number,
): { label: string; startTs: number; endTs: number }[] {
  const begins = new Map<string, number[]>();
  const out: { label: string; startTs: number; endTs: number }[] = [];
  for (const event of events) {
    if (event.kind !== "usertiming" || event.name.startsWith(WPD_MARK_PREFIX)) continue;
    if (event.ph === "b") {
      const list = begins.get(event.name) ?? [];
      list.push(event.ts);
      begins.set(event.name, list);
    } else if (event.ph === "e") {
      const startTs = begins.get(event.name)?.shift();
      if (startTs == null) continue;
      const endTs = event.ts;
      if (startTs < runStart || endTs > runEnd || endTs <= startTs) continue;
      out.push({ label: event.name, startTs, endTs });
    }
  }
  return out;
}

/**
 * Build one seven-slice breakdown per span (--breakdown mode). Spans are the run window, each driver
 * step window, and every user `performance.measure` inside the run window. Durations come from the
 * main-thread trace events; the js slice is subdivided from the CPU samples projected onto the same
 * trace clock (they share Chrome's base::TimeTicks). Returns [] if no run window was found.
 */
export async function buildBreakdowns(
  events: NormalizedEvent[],
  raw: RawCpuProfile,
  runWindow: { startTs: number | null; endTs: number | null },
  mergedSteps: MergedStep[] | undefined,
  context: {
    serverUrl: string;
    root: string;
    maps: SourceMapResolver;
    notes: string[];
    /** sampler interval (us), so a per-span hot ref's selfMs = samples * interval */
    sampleIntervalUs: number;
  },
): Promise<SpanBreakdown[]> {
  if (runWindow.startTs == null || runWindow.endTs == null) return [];
  const main = mainThread(events);
  if (!main) return [];
  // The marker path names the page's own main thread; the heuristic only guesses from where the
  // rendering work landed, so another thread doing more layout/paint would steal the attribution.
  if (main.via === "heuristic") context.notes.push(breakdownHeuristicMainThread());
  const mainEvents = events.filter(
    (event) => event.pid === main.pid && event.tid === main.tid && event.dur > 0,
  );

  // Project every sample onto the trace clock: absolute ts = startTime + cumulative timeDeltas. The
  // same projection feeds the bar's js-by-package split (packagesByNode) and the per-span hot tally
  // (functionByNode -> the ranked CpuModel function id), so both read the identical sample clock.
  const packagesByNode = await packagesByProfileNode(raw, context);
  const functionByNode = functionIdByNode(raw);
  const samples: BreakdownSample[] = [];
  const hotSamples: SpanHotSample[] = [];
  let clock = raw.startTime;
  for (let index = 0; index < raw.samples.length; index++) {
    clock += raw.timeDeltas[index] ?? 0;
    const nodeId = raw.samples[index];
    samples.push({ traceTs: clock, package: packagesByNode.get(nodeId) ?? null });
    hotSamples.push({ ts: clock, functionId: functionByNode.get(nodeId) ?? null });
  }

  const spans: { label: string; kind: SpanBreakdown["kind"]; startTs: number; endTs: number }[] = [
    { label: "run", kind: "run", startTs: runWindow.startTs, endTs: runWindow.endTs },
  ];
  for (const step of mergedSteps ?? []) {
    // A step whose end marker was lost runs to the end of the run window rather than being dropped.
    if (step.startTs == null) continue;
    spans.push({
      label: step.label,
      kind: "step",
      startTs: step.startTs,
      endTs: step.endTs ?? runWindow.endTs,
    });
  }
  for (const measure of userMeasureSpans(events, runWindow.startTs, runWindow.endTs))
    spans.push({
      label: measure.label,
      kind: "measure",
      startTs: measure.startTs,
      endTs: measure.endTs,
    });

  // The off-thread compositor frame side track (display-only, never summed into a bar and never
  // gated; see trace/frames.ts). Parsed once from ALL events -- the frame track lives on
  // compositor/viz threads, not `mainEvents` -- then windowed per span below.
  const allFrames = parseFrames(events);

  const breakdowns: SpanBreakdown[] = [];
  for (const span of spans) {
    const windowEvents = mainEvents.filter(
      (event) => event.ts < span.endTs && event.ts + event.dur > span.startTs,
    );
    const windowSamples = samples.filter(
      (sample) => sample.traceTs >= span.startTs && sample.traceTs <= span.endTs,
    );
    // The run span is start-onward (its presented frame lands in the settle tail, after run:end);
    // a step/measure sub-span is bounded by its own window. See windowFrames.
    const frames = summarizeFrames(
      windowFrames(allFrames, span.startTs, span.endTs, span.kind === "run"),
    );
    breakdowns.push({
      label: span.label,
      kind: span.kind,
      breakdown: computeSpanBreakdown(windowEvents, windowSamples, {
        startTs: span.startTs,
        endTs: span.endTs,
      }),
      ...(frames ? { frames } : {}),
    });
  }
  // Per-span hot functions on the CPU-sampler scripting axis (a SEPARATE panel from the bar's js
  // slice; see SpanHot). A step tallies its single iteration-0 window; a measure label POOLS across
  // every occurrence's window (the merge below keeps only the lower-median occurrence's bar, but the
  // hot list wants all the samples). The run span is skipped: its hot list is the CpuModel at query
  // time. Keyed `${kind}:${label}` so it re-attaches after the merge collapses measure occurrences.
  const hotByKey = new Map<string, SpanHot>();
  const measureWindowsByLabel = new Map<string, SpanHotWindow[]>();
  for (const span of spans) {
    if (span.kind === "step") {
      hotByKey.set(
        `step:${span.label}`,
        tallySpanHot(
          hotSamples,
          [{ startTs: span.startTs, endTs: span.endTs }],
          "step-window",
          context.sampleIntervalUs,
        ),
      );
    } else if (span.kind === "measure") {
      const windows = measureWindowsByLabel.get(span.label) ?? [];
      windows.push({ startTs: span.startTs, endTs: span.endTs });
      measureWindowsByLabel.set(span.label, windows);
    }
  }
  for (const [label, windows] of measureWindowsByLabel)
    hotByKey.set(
      `measure:${label}`,
      tallySpanHot(hotSamples, windows, "measure-pooled", context.sampleIntervalUs),
    );

  // A `performance.measure` label repeated across --iterations produced one bar per occurrence above;
  // collapse each label to its lower-median-by-wall real sample. run/steps have unique labels and
  // pass through unchanged.
  const merged = mergeSpanOccurrences(breakdowns);
  for (const bar of merged) {
    const hot = hotByKey.get(`${bar.kind}:${bar.label}`);
    if (hot) bar.hot = hot;
  }

  // Disclose the navigation coverage gap. The V8 CPU profiler resets on each cross-document
  // navigation, so `Profiler.stop` returns only the samples since the run's LAST navigation: every
  // window before it (iteration-0 steps, early measure occurrences) gets zero samples even though the
  // trace-measured bar shows real JS there. Push ONE note when that symptom is present -- a step/
  // measure bar attributing JS the sampler never covered -- so an empty per-span package split and hot
  // list read as "the sampler could not reach this window", not as "no JS ran" or "raise --iterations".
  const intervalMs = usToMs(context.sampleIntervalUs);
  const uncoveredJsSpans = merged.filter(
    (bar) =>
      bar.kind !== "run" &&
      bar.hot?.suppressed === true &&
      bar.hot.pooledSamples === 0 &&
      intervalMs > 0 &&
      bar.breakdown.slices.js.ms / intervalMs >= 2,
  );
  if (uncoveredJsSpans.length > 0) {
    const firstSampleTs = samples.length > 0 ? samples[0].traceTs : runWindow.startTs;
    const gapMs = usToMs(Math.max(0, firstSampleTs - runWindow.startTs));
    context.notes.push(samplerCoverageGap(uncoveredJsSpans.length, gapMs));
  }
  return merged;
}
