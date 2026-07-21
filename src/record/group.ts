// The run-group WRITE side: derive a manifest path, append a freshly-recorded member to the manifest
// (the ONE join primitive `--group` and the `--members` runner both use), and run the runner loop.
// The pure formation rules live in model/group.ts; this module is where the fs and the record() calls
// happen. No aggregate is ever written here: a member is added by reference, and the only group-level
// numbers are the count-disagreement and partial-formation NOTES.

import { promises as fs } from "node:fs";
import path from "node:path";
import { serialize, deserialize, extFor, type Format } from "../output/format.js";
import { writeFileAtomic } from "../model/atomic-write.js";
import { assertGroupArtifact, assertRecordingArtifact } from "../model/artifact.js";
import {
  formationVerdict,
  countDisagreements,
  partialGroupNotes,
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

/** The D2 refusal: two group names that sanitize to the SAME manifest filename are distinct groups, so
 * joining a `requested` name into a manifest stored under `stored` would silently merge them. Identity
 * is the stored `meta.name`, never the shared filename. Names both so the collision is legible. */
function nameCollisionError(manifestPath: string, stored: string, requested: string): Error {
  return new Error(
    `Refusing to record into '${path.basename(manifestPath)}': it belongs to run-group '${stored}', ` +
      `but you passed --group '${requested}'. Those two names reduce to the same manifest filename, so ` +
      `joining would silently merge two different groups. Use a --group name that does not collide with ` +
      `'${stored}', or record into '${stored}' itself.`,
  );
}

/** The out-path refusal: a joining member whose recording lands on the SAME file as an existing
 * member would overwrite that member the moment it is written, leaving two manifest entries pointing
 * at one file (and every verb routed to the clobbered member reading undefined slices). Two members
 * are two recordings; refuse before anything is written, naming the collision and both fixes. */
function outPathCollisionError(
  groupName: string,
  collidingMember: GroupMember,
  recordingPath: string,
): Error {
  return new Error(
    `Refusing to record into run-group '${groupName}': the output path '${recordingPath}' is already the recording for member '${memberLabel(collidingMember)}'. ` +
      `Appending would overwrite that member, leaving two manifest entries pointing at one file. Give each member a distinct --out, ` +
      `or drop --out and use \`--members <modes> --group ${groupName}\` to auto-name each member.`,
  );
}

/** The existing member (if any) whose recording resolves to `recordingPath`, so a join that would
 * overwrite it is refused. Paths are resolved against the manifest dir, the same key the members are
 * stored relative to. Compared by `path.resolve`, not `realpath`: both the new `--out` and the stored
 * member paths derive from the one `outDir` of this invocation, so they share symlink form (a
 * `/tmp` vs `/private/tmp` split cannot arise between them within a run). */
function memberAtRecordingPath(
  members: GroupMember[],
  manifestDir: string,
  recordingPath: string,
): GroupMember | undefined {
  const target = path.resolve(recordingPath);
  return members.find((member) => path.resolve(manifestDir, member.recording) === target);
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
  /** the capture modes the `--members` runner asked for this invocation; unioned into the manifest's
   * `requested` set so partial status is derived structurally. Absent for an ad-hoc single `--group`
   * record, which is complete-by-construction and never reports partial. */
  requested?: string[];
}

/**
 * Validate the requested members of a `--group`/`--members` run against any EXISTING manifest, BEFORE
 * the browser launches or a byte is written. Refuses (throws) on:
 *   - a name-identity mismatch (D2): the requested name and the stored `meta.name` differ but sanitize
 *     to the same manifest filename -- two distinct groups the join would silently merge.
 *   - an out-path collision: the joining member's recording resolves to an existing member's file, so
 *     appending would overwrite it (a plain `--group --out <base>` repeated across modes).
 *   - a duplicate `(mode, variant)` member (D1): two identical captures are not two questions.
 * A refusal names the recovery in one sentence: the exact missing-members command while the group is
 * still partial, else record under a new `--group` name or remove the manifest and its members. No
 * manifest (first formation) passes silently. This runs the D1 preflight so a re-run never overwrites a
 * member artifact or downgrades the `latest` pointer before the duplicate is caught. `newRecordingPath`
 * (the resolved `--out` of this invocation's single member) drives the out-path collision check; absent
 * for the `--members` runner, whose per-mode `memberOutPath` names are distinct by construction.
 */
export async function preflightGroup(
  manifestPath: string,
  format: Format,
  requestedName: string,
  requested: { mode: string; variant?: string }[],
  newRecordingPath?: string,
): Promise<void> {
  const existing = await readManifest(manifestPath, format);
  if (!existing) return;
  if (existing.meta.name !== requestedName)
    throw nameCollisionError(manifestPath, existing.meta.name, requestedName);
  const presentModes = new Set(existing.members.map((member) => member.mode));
  const duplicates = requested.filter((candidate) =>
    existing.members.some(
      (member) => member.mode === candidate.mode && member.variant === candidate.variant,
    ),
  );
  if (duplicates.length === 0) {
    // Not a duplicate capture, so the D1 message would not fit; a shared --out with a DIFFERENT mode
    // is the out-path collision (the duplicate check above already caught a same-mode shared --out).
    if (newRecordingPath != null) {
      const clash = memberAtRecordingPath(
        existing.members,
        path.dirname(manifestPath),
        newRecordingPath,
      );
      if (clash) throw outPathCollisionError(existing.meta.name, clash, newRecordingPath);
    }
    return;
  }
  // Recovery names the still-missing members from the group's declared `requested` set when it carries
  // one (a partial `--members` group), else from this invocation's own requested modes.
  const declared = existing.requested?.length
    ? existing.requested
    : requested.map((candidate) => candidate.mode);
  const missing = declared.filter((mode) => !presentModes.has(mode));
  const dupLabels = duplicates
    .map((candidate) =>
      candidate.variant ? `${candidate.mode}/${candidate.variant}` : candidate.mode,
    )
    .join(", ");
  const recovery = missing.length
    ? `Record only the missing member(s): \`record --members ${missing.join(",")} --group ${requestedName}\`.`
    : `This group is complete. Record under a new --group name, or remove ${path.basename(manifestPath)} and its member recordings first, then re-record.`;
  throw new Error(
    `Refusing to record into run-group '${existing.meta.name}': it already holds ${dupLabels}. ` +
      `Two identical captures are not two questions. ${recovery}`,
  );
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
    // Identity is the stored meta.name, not the shared filename: refuse a name that only collides on
    // disk rather than silently joining under the stored name the user never typed (D2). The preflight
    // catches this before the run; this is the primitive's own guard for a direct/programmatic caller.
    if (group.meta.name !== name) throw nameCollisionError(manifestPath, group.meta.name, name);
    const reference = await readMemberMeta(manifestDir, group.members[0]);
    const verdict = formationVerdict(
      reference,
      meta,
      group.members.map((member) => ({ mode: member.mode, variant: member.variant })),
    );
    if (verdict.refusals.length)
      throw new Error(
        `Refusing to add this recording to run-group '${group.meta.name}' (requested as '${name}'): ` +
          `${verdict.refusals.join("; ")}. A group holds N captures of ONE workload differing only in ` +
          `capture mode. Re-record this member with the group's flags, or start a new group.`,
      );
    // Out-path collision: a member of a NEW capture mode (formationVerdict passed) whose recording
    // lands on an existing member's file. The preflight catches it before launch; this is the
    // primitive's guard, so a direct caller cannot append a second entry pointing at the file it just
    // overwrote. After the duplicate refusal above, so a same-mode re-record gets the apter D1 message.
    const clash = memberAtRecordingPath(group.members, manifestDir, input.recordingPath);
    if (clash) throw outPathCollisionError(group.meta.name, clash, input.recordingPath);
    newMember.annotations = verdict.annotations;
    group.members.push(newMember);
  }

  // Union the modes this `--members` invocation asked for into the manifest, so partial status is a
  // structural fact (requested minus present) at every append, not a note narrated once on failure.
  if (input.requested?.length) {
    const merged = new Set([...(group.requested ?? []), ...input.requested]);
    group.requested = [...merged];
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
  // Recompute both note sets from the current manifest state (idempotent, present-tense): the
  // cross-member count disagreements, then the structural partial-group note (requested minus present).
  // A recovered group -- one whose missing member has now recorded -- carries no partial note, because
  // partialGroupNotes derives it from state, never from a stored failure narrative.
  group.notes = [
    ...countDisagreements(memberCounts),
    ...partialGroupNotes(
      group.meta.name,
      group.requested ?? [],
      group.members.map((member) => member.mode),
    ),
  ];

  await fs.mkdir(manifestDir, { recursive: true });
  // Atomic: appendMember rewrites the WHOLE manifest, so a truncate-in-place write killed mid-flight
  // would lose every member already recorded. Temp file + rename leaves the good manifest intact.
  await writeFileAtomic(manifestPath, serialize(group, format));
  return group;
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
  // Validate the WHOLE requested set against any existing manifest before the first browser launches:
  // a name-identity mismatch or a duplicate member refuses here, so a re-run of a complete group never
  // overwrites a member artifact or touches the `latest` pointer (D1).
  await preflightGroup(
    manifestPath,
    baseOpts.format,
    name,
    modes.map((mode) => ({ mode, variant: baseOpts.variant })),
  );
  let completed = 0;
  for (const mode of modes) {
    const memberOpts: RecordOptions = {
      ...baseOpts,
      breakdown: mode === "breakdown",
      deep: mode === "deep",
      preciseWall: mode === "precise-wall",
      group: name,
      // Thread the full requested set so each append derives partial status structurally (a later
      // member's failure leaves the correct "N of M, missing X" note without a separate annotate step).
      groupRequested: modes,
      out: memberOutPath(dir, name, mode, baseOpts.format),
    };
    try {
      await recordOne(memberOpts);
      completed++;
    } catch (error) {
      // The first member failing leaves nothing to salvage: surface it, like keep-partial's
      // first-iteration rule. A later one keeps the members recorded so far; the last successful
      // append already left the structural partial note ("N of M, missing X"), no annotate needed.
      if (completed === 0) throw error;
      const reason = error instanceof Error ? error.message : String(error);
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
