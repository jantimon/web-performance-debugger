import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * The pointer answers "resolve `latest` from THIS cwd", so it is keyed by the resolved cwd and
 * stored out-of-tree under the XDG state dir, never inside the working directory. A consumer that
 * records with `--out` somewhere else gets no `recordings/` dir dropped into its cwd as a side
 * effect. The pointer contents are unchanged (absolute paths to the artifacts).
 *
 * `$XDG_STATE_HOME/wpd/pointers/<hash>.json`, falling back to `~/.local/state/wpd/pointers/`, where
 * `<hash>` is a short sha of the resolved cwd.
 */
function stateBase(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(base, "wpd", "pointers");
}

function pointerFileFor(cwd: string): string {
  const hash = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  return path.join(stateBase(), `${hash}.json`);
}

/** Legacy in-cwd pointer. Still READ (so an in-flight `latest` keeps resolving) but never WRITTEN. */
const LEGACY_POINTER = "recordings/.wpd-last.json";

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
  const file = pointerFileFor(process.cwd());
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(pointer, null, 2), "utf8");
}

async function readPointer(): Promise<LastPointer> {
  const stateFile = pointerFileFor(process.cwd());
  try {
    return JSON.parse(await fs.readFile(stateFile, "utf8")) as LastPointer;
  } catch {
    // Fall back to the legacy in-cwd pointer so a `latest` left by an older record keeps resolving.
    try {
      return JSON.parse(await fs.readFile(path.resolve(LEGACY_POINTER), "utf8")) as LastPointer;
    } catch {
      throw new Error(
        `No previous recording found for 'latest' (looked in ${stateFile} and ${path.resolve(LEGACY_POINTER)}). Run \`record\` first, or pass an explicit file path.`,
      );
    }
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
