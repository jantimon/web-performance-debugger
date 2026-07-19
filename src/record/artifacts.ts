import { promises as fs } from "node:fs";
import { serialize, type Format } from "../output/format.js";
import type { CpuModel, Recording } from "../model/recording.js";

// Pure artifact writers: they take already-built model objects and put them on disk. No browser
// handles, no meta mutation, so a fixture test can drive them directly. The collapse leaves two
// writers: the one default artifact (Span[] + summary + meta, with the deep event log under --deep)
// and the resolved CPU model. The `query spans`/`query span <label>` views are derived from the
// recording at read time, so there is no separate step-index file to write.

/** Serialize a recording to `outPath`. */
export async function writeRecording(
  outPath: string,
  recording: Recording,
  format: Format,
): Promise<void> {
  await fs.writeFile(outPath, serialize(recording, format), "utf8");
}

/** Serialize the resolved CPU model to `cpuModelPath`. */
export async function writeCpuModel(
  cpuModelPath: string,
  cpuModel: CpuModel,
  format: Format,
): Promise<void> {
  await fs.writeFile(cpuModelPath, serialize(cpuModel, format), "utf8");
}
