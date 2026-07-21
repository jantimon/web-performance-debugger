// Crash-safe file writes. Every artifact write in this tool is a truncate-in-place `writeFile`, which
// opens the target for writing and can leave it half-written if the process dies mid-write. The manifest
// rewrite is the sharp edge: appendMember reads the whole manifest, adds one member, and writes it back,
// so a kill during that write loses every member already recorded. These helpers write a sibling temp
// file and rename it over the target; a rename on one filesystem is atomic, so a reader sees the old file
// or the new one, never a torn one, and an interrupted write cannot corrupt a good file.
//
// Single-writer stays the assumption: this guards a crash, not two writers racing. No lock, no CAS.

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** A unique sibling temp path in the target's own directory, so the rename never crosses a filesystem
 * boundary. The random suffix keeps two temp files apart even within one process. */
function tempPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  return path.join(dir, `.${path.basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`);
}

/** Write `data` to `filePath` via a same-directory temp file + atomic rename. Any failure (the temp
 * write or the rename) removes the temp, so a failed write leaves no litter. */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const temp = tempPathFor(filePath);
  try {
    await fs.writeFile(temp, data, "utf8");
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** Copy `sourcePath` onto `filePath` via a same-directory temp file + atomic rename, for a large binary
 * artifact (the Gecko dump) that must not round-trip through a string. Any failure removes the temp. */
export async function copyFileAtomic(sourcePath: string, filePath: string): Promise<void> {
  const temp = tempPathFor(filePath);
  try {
    await fs.copyFile(sourcePath, temp);
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}
