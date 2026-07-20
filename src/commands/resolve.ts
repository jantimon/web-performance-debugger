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
  /** the one default artifact (Span[] + summary + meta); the `query span`/`spans` views derive from it */
  recording: string;
  /** raw .cpuprofile, when CPU profiling ran */
  cpuProfile?: string;
  /** resolved CPU model (.cpu.json/.cpu.toon), when CPU profiling ran */
  cpuModel?: string;
  /** the run-group manifest, when the latest record formed or extended a group (absolute, like the
   * others). `recording` still points at the last member as a fallback; a subsequent NON-group record
   * writes a pointer without this field, which CLEARS it, so `latest` stops resolving to the group. */
  group?: string;
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
  } catch (error) {
    // Fall back to the legacy in-cwd pointer ONLY when the state file is absent. A corrupt state
    // pointer (bad JSON) or an unreadable one (EACCES) must surface: silently resolving a stale
    // legacy pointer would answer `latest` with the wrong recording, the quiet-wrong-answer this
    // tool refuses.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Failed to read the 'latest' pointer at ${stateFile}: ${(error as Error).message}`,
      );
    }
    const legacyFile = path.resolve(LEGACY_POINTER);
    try {
      return JSON.parse(await fs.readFile(legacyFile, "utf8")) as LastPointer;
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Failed to read the legacy 'latest' pointer at ${legacyFile}: ${(legacyError as Error).message}`,
        );
      }
      throw new Error(
        `No previous recording found for 'latest' (looked in ${stateFile} and ${legacyFile}). Run \`record\` first, or pass an explicit file path.`,
      );
    }
  }
}

/**
 * An artifact path as a report or a copy-pasteable hint should show it: relative to cwd when that is
 * shorter, else the absolute path unchanged.
 *
 * Display only. The stored back-pointers stay absolute so a recording reopens from any directory;
 * this is purely the terminal, where an absolute path is both harder to scan and something you may
 * not want on screen -- a pasted report or a recorded terminal otherwise carries your home directory.
 *
 * Falls back to absolute when relativizing does not help: an --out outside cwd would otherwise become
 * a worse `../../../tmp/x.json`.
 */
export function displayPath(absPath: string): string {
  const relative = path.relative(process.cwd(), absPath);
  return relative && !relative.startsWith("..") && relative.length < absPath.length
    ? relative
    : absPath;
}

/**
 * A paste-ready target token for a copy-pasteable drill-in hint: the bare literal `latest` when this
 * path IS the current cwd's `latest` pointer target, else the `displayPath` DOUBLE-QUOTED so a path
 * with spaces (a home dir, a spaced project name) stays one shell argument. Keeps a pasted hint free
 * of absolute home/scratch paths and runnable verbatim.
 */
export async function hintTarget(absPath: string): Promise<string> {
  try {
    const pointer = await readPointer();
    if (path.resolve(pointer.recording) === path.resolve(absPath)) return "latest";
  } catch {
    // No resolvable pointer (never recorded from this cwd, or an unreadable one): fall back to the
    // relative display path rather than failing a hint line.
  }
  return JSON.stringify(displayPath(absPath));
}

export interface Consumption {
  kind: "recording" | "group";
  /** absolute path to the recording or the run-group manifest */
  path: string;
}

/** Whether a path names a run-group manifest by its `<base>.group.json|.toon` filename convention.
 * A member recording never matches, so an explicit member path always resolves to the recording (the
 * maintainer-locked rule), while an explicit manifest path resolves to the group. */
function looksLikeGroupPath(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  return base.endsWith(".group.json") || base.endsWith(".group.toon");
}

/**
 * Resolve a consumption target to a recording OR a run-group manifest. `latest` resolves to the group
 * iff the pointer carries one (a group-forming record set it; a later non-group record cleared it);
 * an explicit path is a group only when it is a `.group.json|.toon` manifest, so an explicit member
 * path always resolves to the recording. A group-aware verb branches on `kind`; the recording verbs
 * keep using `resolveTarget`.
 */
export async function resolveConsumption(file: string): Promise<Consumption> {
  if (file === "latest") {
    const pointer = await readPointer();
    if (pointer.group) return { kind: "group", path: path.resolve(pointer.group) };
    return { kind: "recording", path: path.resolve(pointer.recording) };
  }
  const abs = path.resolve(file);
  return { kind: looksLikeGroupPath(abs) ? "group" : "recording", path: abs };
}

/**
 * Resolve a file argument. The literal `latest` resolves to the most recent
 * recording via the pointer file, never by mtime.
 */
export async function resolveTarget(
  file: string,
  kind: "recording" | "auto" | "cpu-model" | "cpu-profile",
): Promise<string> {
  if (file !== "latest") return path.resolve(file);
  const pointer = await readPointer();
  if (kind === "cpu-model" || kind === "cpu-profile") {
    const target = kind === "cpu-model" ? pointer.cpuModel : pointer.cpuProfile;
    if (!target)
      throw new Error(
        "Latest run has no CPU profile. Re-run `record` in a capture mode that samples CPU (the default or --breakdown, not --deep/--precise-wall).",
      );
    return path.resolve(target);
  }
  // One artifact kind: the recording carries the spans, so the `recording` and `auto` targets both
  // resolve to it and every span/count view is derived by the verb.
  return path.resolve(pointer.recording);
}
