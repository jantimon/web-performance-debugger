import { promises as fs } from "node:fs";
import path from "node:path";
import { buildSummary } from "../metrics/summarize.js";
import { buildDigest } from "../commands/digest.js";
import { serialize, extFor, type Format } from "../output/format.js";
import { stepMark } from "../model/marks.js";
import type { MergedStep } from "../trace/steps.js";
import type {
  CpuModel,
  NormalizedEvent,
  Recording,
  RecordingMeta,
  StepIndex,
  StepIndexEntry,
} from "../model/recording.js";

// Pure artifact writers: they take already-built model objects and put them on disk. No browser
// handles, no meta mutation, so a fixture test can drive them directly. The ORDER these run in
// (and the meta mutation they must come after) is the orchestrator's concern, kept in record.ts.

function slug(label: string): string {
  return (
    label
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 40) || "step"
  );
}

function indexPathHint(outDir: string, base: string, ext: string): string {
  return path.join(outDir, `${base}.index${ext}`);
}

/** Serialize a recording to `outPath`. */
export async function writeRecording(
  outPath: string,
  recording: Recording,
  format: Format,
): Promise<void> {
  await fs.writeFile(outPath, serialize(recording, format), "utf8");
}

/** Build and serialize the small, context-friendly digest that points back into `sourcePath`. */
export async function writeDigest(
  digestPath: string,
  recording: Recording,
  sourcePath: string,
  format: Format,
  limit = 20,
): Promise<void> {
  await fs.writeFile(
    digestPath,
    serialize(buildDigest(recording, sourcePath, limit), format),
    "utf8",
  );
}

/** Serialize the resolved CPU model to `cpuModelPath`. */
export async function writeCpuModel(
  cpuModelPath: string,
  cpuModel: CpuModel,
  format: Format,
): Promise<void> {
  await fs.writeFile(cpuModelPath, serialize(cpuModel, format), "utf8");
}

/**
 * Driver/stepped runs: split the report into one recording + digest per step, plus an index that
 * lists them. Pure: `meta` is read (never mutated), events are sliced per step window, and every
 * file is serialized from the model. Returns the index path.
 */
export async function writeStepIndex(params: {
  outDir: string;
  base: string;
  format: Format;
  meta: RecordingMeta;
  recordingPath: string;
  detailEvents: NormalizedEvent[];
  mergedSteps: MergedStep[];
  /** false in --breakdown mode: forced layout was not measured, so steps report it as null */
  forcedMeasured: boolean;
}): Promise<string> {
  const { outDir, base, format, meta, recordingPath, detailEvents, mergedSteps, forcedMeasured } =
    params;
  const ext = extFor(format);

  const entries: StepIndexEntry[] = [];
  for (const step of mergedSteps) {
    const evs = detailEvents.filter(
      (event) =>
        step.startTs != null &&
        event.ts >= step.startTs &&
        (step.endTs == null || event.ts <= step.endTs),
    );
    const stepRec: Recording = {
      meta: { ...meta, step: { index: step.index, label: step.label } },
      window: {
        measure: stepMark(step.index),
        startTs: step.startTs,
        endTs: step.endTs,
        wallMs: step.wallMs,
      },
      marks: [],
      metrics: { before: {}, after: {}, delta: step.cdpDelta },
      events: evs,
      summary: buildSummary({
        wallMs: step.wallMs,
        inpMs: step.inpMs,
        interaction: step.interaction,
        detailEvents: evs,
        detailWindowStart: step.startTs,
        cdpDelta: step.cdpDelta,
        // This step's own repetitions, so a per-step recording carries the same samples+stats
        // contract as a bench one: `wallMs` is their median, `stats` their spread.
        perIteration: step.perIteration,
        forcedMeasured,
      }),
    };
    const stepBase = `${base}.step-${step.index}-${slug(step.label)}`;
    const stepRecPath = path.join(outDir, `${stepBase}${ext}`);
    const stepDigestPath = path.join(outDir, `${stepBase}.digest${ext}`);
    await fs.writeFile(stepRecPath, serialize(stepRec, format), "utf8");
    await fs.writeFile(
      stepDigestPath,
      serialize(buildDigest(stepRec, stepRecPath, 10), format),
      "utf8",
    );
    const summary = stepRec.summary;
    entries.push({
      index: step.index,
      label: step.label,
      wallMs: step.wallMs,
      stats: summary.stats,
      inpMs: step.inpMs,
      interaction: step.interaction,
      headline: {
        layoutCount: summary.layoutCount,
        forcedLayoutCount: summary.forcedLayoutCount,
        paintCount: summary.paintCount,
        layoutInvalidations: summary.layoutInvalidations,
        styleInvalidations: summary.styleInvalidations,
        longTaskCount: summary.longTaskCount,
      },
      recording: stepRecPath,
      digest: stepDigestPath,
    });
  }

  const index: StepIndex = {
    meta,
    recording: recordingPath,
    steps: entries,
    hints: [
      "Entry point for a stepped run. Inspect a step's digest, then drill into its recording.",
      `Per-step digest: wpd query digest "${entries[0]?.recording ?? "<step file>"}"`,
      `Layout thrashing in a step: wpd query blame --forced "${entries[0]?.recording ?? "<step file>"}"`,
      `Gate in CI: wpd assert "${indexPathHint(outDir, base, ext)}" --max-forced 0`,
    ],
  };
  const indexPath = path.join(outDir, `${base}.index${ext}`);
  await fs.writeFile(indexPath, serialize(index, format), "utf8");
  return indexPath;
}
