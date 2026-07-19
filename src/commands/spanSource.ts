import { promises as fs } from "node:fs";
import path from "node:path";
import { deserialize } from "../output/format.js";
import { assertRecordingArtifact } from "../model/artifact.js";
import { resolveTarget } from "./resolve.js";
import { loadCpuModel } from "../profile/cpuprofile.js";
import { buildSpans, recordingLane } from "../model/spans.js";
import type { CpuBreakdown, Recording } from "../model/recording.js";
import type { SpanEntry } from "../model/query.js";

/**
 * Resolve a recording and fold its stored per-span bars (chrome --breakdown / firefox measures) or
 * its sibling CpuModel run bar onto the unified `SpanEntry[]` shape `query spans` produces. This is
 * the SAME slice-reading path as `query spans` (`buildSpans`), so `assert --max-slice` and `diff`
 * never grow a second interpretation of a slice. Returns null when the recording carries no bar at
 * all (an older recording, or a sampler-off rung like --deep/--precise-wall), which the caller
 * treats as "no slice data".
 */
export async function loadSpanEntries(file: string): Promise<SpanEntry[] | null> {
  const abs = await resolveTarget(file, "recording");
  const rec = deserialize(
    await fs.readFile(abs, "utf8"),
    path.extname(abs).toLowerCase(),
  ) as Recording;
  assertRecordingArtifact(rec, abs);
  const hasBar = rec.spans?.some((span) => span.breakdown);
  let cpuBreakdown: CpuBreakdown | undefined;
  if (!hasBar) {
    try {
      cpuBreakdown = (await loadCpuModel(abs)).breakdown;
    } catch (error) {
      // No CPU model beside the recording means "no bar", which buildSpans reports as no
      // slice data. Anything else (corrupt JSON, unreadable file) surfaces: swallowing it
      // would report real slice data as absent.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOCPUMODEL") throw error;
    }
  }
  const meta = rec.meta ?? {};
  const result = buildSpans(rec.spans, cpuBreakdown, recordingLane(meta), meta.iterations ?? 1);
  return result?.spans ?? null;
}
