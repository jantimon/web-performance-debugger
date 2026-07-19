import { promises as fs } from "node:fs";
import path from "node:path";
import { deserialize } from "../output/format.js";
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
 * all (an older recording, or a `--no-cpu-profile` run), which the caller treats as "no slice data".
 */
export async function loadSpanEntries(file: string): Promise<SpanEntry[] | null> {
  const abs = await resolveTarget(file, "recording");
  const rec = deserialize(
    await fs.readFile(abs, "utf8"),
    path.extname(abs).toLowerCase(),
  ) as Recording;
  let cpuBreakdown: CpuBreakdown | undefined;
  if (!rec.breakdowns?.length) {
    try {
      cpuBreakdown = (await loadCpuModel(abs)).breakdown;
    } catch {
      // No sibling CPU model: buildSpans falls back to null, reported as "no slice data".
    }
  }
  // An older recording may predate `meta`; it also has no bar, so buildSpans returns null anyway.
  const meta = rec.meta ?? {};
  const result = buildSpans(
    rec.breakdowns,
    cpuBreakdown,
    recordingLane(meta),
    meta.iterations ?? 1,
  );
  return result?.spans ?? null;
}
