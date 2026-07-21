// The run-group WRITE side: derive a manifest path, append a freshly-recorded member to the manifest
// (the ONE join primitive `--group` and the `--members` runner both use), and run the runner loop.
// The pure formation rules live in model/group.ts; this module is where the fs and the record() calls
// happen. No aggregate is ever written here: a member is added by reference, and the only group-level
// numbers are the count-disagreement and partial-formation NOTES.

import { promises as fs } from "node:fs";
import path from "node:path";
import { serialize, deserialize, extFor, type Format } from "../output/format.js";
import { assertGroupArtifact, assertRecordingArtifact } from "../model/artifact.js";
import {
  formationVerdict,
  countDisagreements,
  memberLabel,
  GROUP_COUNT_FIELDS,
  type RunGroup,
  type GroupMember,
  type MemberCounts,
} from "../model/group.js";
import type { Recording, RecordingMeta, RecordingSummary } from "../model/recording.js";
import type { RecordOptions } from "../commands/record.js";
import { VERSION, TOOL } from "../version.js";
import { SCHEMA_VERSION } from "../schema.js";

/** The chrome capture modes a `--members` group can span (mutually exclusive per member, so a list of
 * them is the two-question path). Firefox/node are rejected upstream: each is one pass at every mode. */
export const GROUP_MEMBER_MODES = ["default", "breakdown", "deep", "precise-wall"] as const;
export type GroupMemberMode = (typeof GROUP_MEMBER_MODES)[number];

export function isGroupMemberMode(value: string): value is GroupMemberMode {
  return (GROUP_MEMBER_MODES as readonly string[]).includes(value);
}

/** A group name folded to a filesystem-safe stem, so `--group "My Perf!"` never escapes its directory. */
function sanitizeName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "group"
  );
}

/** The manifest path for a group: `<dir>/<name>.group.<ext>`, a sibling of the member recordings so
 * every member path in it is relative and the whole directory can move or be committed together. */
export function groupManifestPathFor(dir: string, name: string, format: Format): string {
  return path.join(dir, `${sanitizeName(name)}.group${extFor(format)}`);
}

/** A member recording's own path when the `--members` runner records it: a named sibling of the
 * manifest, one per capture mode, so re-running the group overwrites the same member deterministically. */
export function memberOutPath(dir: string, name: string, mode: string, format: Format): string {
  return path.join(dir, `${sanitizeName(name)}.${mode}${extFor(format)}`);
}

/** Read a recording (json/toon) and project its summary onto the exact-count fields the disagreement
 * check compares. Only counts are read: the manifest never stores or averages a member's numbers. */
async function readMemberCounts(recordingPath: string, label: string): Promise<MemberCounts> {
  const body = await fs.readFile(recordingPath, "utf8");
  const rec = deserialize(body, path.extname(recordingPath).toLowerCase()) as Recording;
  // Fail loudly on a mis-referenced member (a hand-edited manifest, or a path pointing at a sibling
  // .cpu.json / .group.json): treating a non-recording as "no counts" would hide a real disagreement.
  assertRecordingArtifact(rec, recordingPath);
  const summary = rec.summary ?? ({} as RecordingSummary);
  const counts: MemberCounts["counts"] = {};
  const summaryFields = summary as unknown as Record<string, number | null | undefined>;
  for (const [field] of GROUP_COUNT_FIELDS) counts[field] = summaryFields[field] ?? null;
  return { label, counts };
}

async function readManifest(manifestPath: string, format: Format): Promise<RunGroup | null> {
  let body: string;
  try {
    body = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = deserialize(body, extFor(format)) as RunGroup;
  assertGroupArtifact(
    parsed as { meta?: { schemaVersion?: string; kind?: string }; members?: unknown },
    manifestPath,
  );
  return parsed;
}

/** Read the reference member's (member 0's) full meta, so the formation check runs against a real meta
 * (covering every comparability axis, including the sampler interval) rather than a reconstruction. */
async function readMemberMeta(manifestDir: string, member: GroupMember): Promise<RecordingMeta> {
  const recordingPath = path.resolve(manifestDir, member.recording);
  const body = await fs.readFile(recordingPath, "utf8");
  const rec = deserialize(body, path.extname(recordingPath).toLowerCase()) as Recording;
  // The formation check runs against this meta; a wrong artifact kind here must fail with a clear
  // message now, not crash positionally on a missing meta field later in the join.
  assertRecordingArtifact(rec, recordingPath);
  return rec.meta;
}

export interface AppendMemberInput {
  name: string;
  manifestPath: string;
  format: Format;
  /** the just-written member's absolute artifact paths */
  recordingPath: string;
  cpuModelPath?: string;
  cpuProfilePath?: string;
  /** the joining recording's meta + summary (for formation + count-disagreement) */
  meta: RecordingMeta;
  summary: RecordingSummary;
}

/**
 * Append a recorded member to its group manifest, creating the manifest on the first member. Validates
 * the join against the group's shared identity (formationVerdict, reusing comparabilityMismatches) and
 * THROWS on a refusal; a compatible member joins, carrying any sampler-interval annotation. After the
 * add, the group's notes are recomputed from every member's exact counts, so a cross-member
 * disagreement surfaces both values loudly. Returns the written manifest.
 */
export async function appendMember(input: AppendMemberInput): Promise<RunGroup> {
  const { name, manifestPath, format, meta, summary } = input;
  const manifestDir = path.dirname(manifestPath);
  const relative = (absPath: string | undefined): string | undefined =>
    absPath == null ? undefined : path.relative(manifestDir, absPath);

  const mode = meta.passes[0];
  const newMember: GroupMember = {
    mode,
    ...(meta.variant ? { variant: meta.variant } : {}),
    recording: path.relative(manifestDir, input.recordingPath),
    ...(input.cpuModelPath ? { cpuModel: relative(input.cpuModelPath) } : {}),
    ...(input.cpuProfilePath ? { cpuProfile: relative(input.cpuProfilePath) } : {}),
    createdAt: meta.createdAt,
    ...(meta.workload ? { workload: meta.workload } : {}),
    annotations: [],
  };

  const existing = await readManifest(manifestPath, format);
  let group: RunGroup;
  if (!existing) {
    // First member: the group inherits its shared identity + capture axes from this recording. Every
    // later member is refused unless it matches these (except the capture mode, which is the point).
    group = {
      meta: {
        tool: TOOL,
        version: VERSION,
        schemaVersion: SCHEMA_VERSION,
        kind: "run-group",
        createdAt: new Date().toISOString(),
        name,
      },
      ...(meta.workload ? { workload: meta.workload } : {}),
      iterations: meta.iterations,
      warmup: meta.warmup,
      headless: meta.headless,
      ...(meta.headlessMode ? { headlessMode: meta.headlessMode } : {}),
      ...(meta.throttle ? { throttle: meta.throttle } : {}),
      ...(meta.browser ? { browser: meta.browser } : {}),
      ...(meta.runtime && meta.runtime !== "chrome" ? { runtime: meta.runtime } : {}),
      ...(meta.variant ? { variant: meta.variant } : {}),
      members: [newMember],
      notes: [],
    };
  } else {
    group = existing;
    const reference = await readMemberMeta(manifestDir, group.members[0]);
    const verdict = formationVerdict(
      reference,
      meta,
      group.members.map((member) => ({ mode: member.mode, variant: member.variant })),
    );
    if (verdict.refusals.length)
      throw new Error(
        `Refusing to add this recording to group '${group.meta.name}': ${verdict.refusals.join("; ")}. ` +
          `A group holds N captures of ONE workload differing only in capture mode. Re-record this ` +
          `member with the group's flags, or start a new group.`,
      );
    newMember.annotations = verdict.annotations;
    group.members.push(newMember);
  }

  // Recompute the cross-member disagreement notes from scratch each append (idempotent): read each
  // member's exact counts and surface any field two members measured and disagree on.
  const memberCounts: MemberCounts[] = [];
  for (const member of group.members) {
    if (member === newMember) {
      const counts: MemberCounts["counts"] = {};
      const summaryFields = summary as unknown as Record<string, number | null | undefined>;
      for (const [field] of GROUP_COUNT_FIELDS) counts[field] = summaryFields[field] ?? null;
      memberCounts.push({ label: memberLabel(member), counts });
    } else {
      memberCounts.push(
        await readMemberCounts(path.resolve(manifestDir, member.recording), memberLabel(member)),
      );
    }
  }
  // Keep any partial-formation note (it is not a count disagreement) and refresh the disagreement set.
  const partialNotes = group.notes.filter((note) => note.startsWith(GROUP_PARTIAL_PREFIX));
  group.notes = [...countDisagreements(memberCounts), ...partialNotes];

  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(manifestPath, serialize(group, format), "utf8");
  return group;
}

const GROUP_PARTIAL_PREFIX = "WARNING: partial group";

/** The loud note the runner attaches when a later member's capture failed, keeping the members that
 * completed (keep-partial precedent). Names the failed mode and why. */
export function groupPartialNote(
  completed: number,
  requested: number,
  failedMode: string,
  reason: string,
): string {
  return (
    `${GROUP_PARTIAL_PREFIX}: ${completed} of ${requested} members recorded; the '${failedMode}' ` +
    `capture failed, so this group is incomplete. A verb that routes to a missing member reports it ` +
    `as not measured (a loud n/a), never a silent pass. Re-run to record the missing member. ` +
    `Failure: ${reason}`
  );
}

/** Attach a group-level note to an existing manifest (the runner's partial-formation disclosure). */
export async function annotateGroup(
  manifestPath: string,
  format: Format,
  note: string,
): Promise<void> {
  const group = await readManifest(manifestPath, format);
  if (!group) return;
  group.notes.push(note);
  await fs.writeFile(manifestPath, serialize(group, format), "utf8");
}

export interface RunMembersOutcome {
  manifestPath: string;
  completed: number;
  requested: number;
  /** the failed member mode + reason, when a later member's capture failed (partial group) */
  partial?: { failedMode: string; reason: string };
}

/**
 * The `--members <modes>` runner: record each mode back-to-back (N browser launches, N recordings),
 * applying all other flags identically, each appending itself to the shared manifest via record() ->
 * appendMember. A later member's capture failure keeps the partial group with a loud note (keep-partial
 * precedent); a FIRST-member failure is a hard error (there is no group to salvage). `recordOne` is
 * injected so this stays free of a commands/record.ts import cycle.
 */
export async function runMembers(
  recordOne: (opts: RecordOptions) => Promise<void>,
  baseOpts: RecordOptions,
  modes: GroupMemberMode[],
): Promise<RunMembersOutcome> {
  const name = baseOpts.group!;
  const dir = baseOpts.out ? path.dirname(path.resolve(baseOpts.out)) : path.resolve("recordings");
  const manifestPath = groupManifestPathFor(dir, name, baseOpts.format);
  let completed = 0;
  for (const mode of modes) {
    const memberOpts: RecordOptions = {
      ...baseOpts,
      breakdown: mode === "breakdown",
      deep: mode === "deep",
      preciseWall: mode === "precise-wall",
      group: name,
      out: memberOutPath(dir, name, mode, baseOpts.format),
    };
    try {
      await recordOne(memberOpts);
      completed++;
    } catch (error) {
      // The first member failing leaves nothing to salvage: surface it, like keep-partial's
      // first-iteration rule. A later one keeps the members recorded so far, with a loud note.
      if (completed === 0) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      await annotateGroup(
        manifestPath,
        baseOpts.format,
        groupPartialNote(completed, modes.length, mode, reason),
      );
      return {
        manifestPath,
        completed,
        requested: modes.length,
        partial: { failedMode: mode, reason },
      };
    }
  }
  return { manifestPath, completed, requested: modes.length };
}
