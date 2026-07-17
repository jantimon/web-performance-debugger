import { promises as fs } from "node:fs";
import path from "node:path";

/** Pointer file written by `record` so `latest` resolves without guessing by mtime. */
export const POINTER = "recordings/.wpd-last.json";

export interface LastPointer {
  recording: string;
  digest: string;
  index?: string;
  /** raw .cpuprofile, when CPU profiling ran */
  cpuProfile?: string;
  /** resolved CPU model (.cpu.json/.cpu.toon), when CPU profiling ran */
  cpuModel?: string;
}

export async function writePointer(pointer: LastPointer): Promise<void> {
  const file = path.resolve(POINTER);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(pointer, null, 2), "utf8");
}

async function readPointer(): Promise<LastPointer> {
  const file = path.resolve(POINTER);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as LastPointer;
  } catch {
    throw new Error(
      `No previous recording found for 'latest' (looked for ${POINTER}). Run \`record\` first, or pass an explicit file path.`,
    );
  }
}

/**
 * Resolve a file argument. The literal `latest` resolves to the most recent
 * recording (or its index) via the pointer file, never by mtime.
 */
export async function resolveTarget(
  file: string,
  kind: "recording" | "index" | "auto" | "cpu-model" | "cpu-profile",
): Promise<string> {
  if (file !== "latest") return path.resolve(file);
  const pointer = await readPointer();
  if (kind === "index") {
    if (!pointer.index)
      throw new Error("Latest run was not a stepped run (no index). Use a recording verb instead.");
    return path.resolve(pointer.index);
  }
  if (kind === "cpu-model" || kind === "cpu-profile") {
    const target = kind === "cpu-model" ? pointer.cpuModel : pointer.cpuProfile;
    if (!target)
      throw new Error("Latest run has no CPU profile. Re-run `record` without --no-cpu-profile.");
    return path.resolve(target);
  }
  if (kind === "auto") return path.resolve(pointer.index ?? pointer.recording);
  return path.resolve(pointer.recording);
}
