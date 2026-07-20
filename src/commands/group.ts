// The run-group CONSUMPTION side: load a manifest, resolve a member's recording path, and route a
// single-member verb (cpu/frame/blame/events/get) to the member that measures its axis. The stitched
// multi-member views (query spans/span, assert, diff) branch in their own command files and reuse
// these primitives. A verb that finds no member for its axis fails LOUDLY here (n/a), never a silent
// pass -- the same honesty the Measured contract enforces on a single recording.

import { promises as fs } from "node:fs";
import path from "node:path";
import { deserialize } from "../output/format.js";
import { assertGroupArtifact, assertRecordingArtifact } from "../model/artifact.js";
import {
  memberLabel,
  pickMember,
  type GroupMember,
  type MemberAxis,
  type RunGroup,
} from "../model/group.js";
import { resolveConsumption } from "./resolve.js";
import type { Recording } from "../model/recording.js";

// The read side re-exports the shared member label so consumers import it from one place.
export { memberLabel };

/** Load and validate a run-group manifest. */
export async function loadGroup(manifestPath: string): Promise<RunGroup> {
  const body = await fs.readFile(manifestPath, "utf8");
  const group = deserialize(body, path.extname(manifestPath).toLowerCase()) as RunGroup;
  assertGroupArtifact(
    group as { meta?: { schemaVersion?: string; kind?: string }; members?: unknown },
    manifestPath,
  );
  return group;
}

/** A member's recording path, absolute (its manifest stores it relative to the manifest dir). */
export function memberRecordingPath(manifestPath: string, member: GroupMember): string {
  return path.resolve(path.dirname(manifestPath), member.recording);
}

/** Load a member's recording. */
export async function loadMemberRecording(
  manifestPath: string,
  member: GroupMember,
): Promise<Recording> {
  const abs = memberRecordingPath(manifestPath, member);
  const rec = deserialize(
    await fs.readFile(abs, "utf8"),
    path.extname(abs).toLowerCase(),
  ) as Recording;
  assertRecordingArtifact(rec, abs);
  return rec;
}

/** What a resolved verb target is: a plain recording, or a group member routed for one axis. */
export interface VerbTarget {
  /** the string the verb passes downstream: the ORIGINAL `file` for a plain recording (so `latest`
   * stays `latest` and its messages are unchanged), else the routed member's absolute recording path */
  target: string;
  /** set when `file` resolved to a run-group and was routed to a member */
  group?: RunGroup;
  manifestPath?: string;
  member?: GroupMember;
}

/**
 * Resolve a single-member verb's target: a plain recording resolves to the original argument; a
 * run-group routes to the member that measures `axis` (pickMember). No member for the axis is a LOUD
 * failure naming the axis and the members present, never a silent fall-through. `axisLabel` words the
 * axis for that error.
 */
export async function resolveVerbTarget(
  file: string,
  axis: MemberAxis,
  axisLabel: string,
): Promise<VerbTarget> {
  const consumption = await resolveConsumption(file);
  if (consumption.kind === "recording") return { target: file };
  const group = await loadGroup(consumption.path);
  const member = pickMember(group, axis);
  if (!member)
    throw new Error(
      `No member of run-group '${group.meta.name}' measures ${axisLabel} ` +
        `(members: ${group.members.map((entry) => memberLabel(entry)).join(", ") || "none"}). ` +
        `Record a member that does (e.g. --deep for forced-layout blame, --breakdown for the bar).`,
    );
  return {
    target: memberRecordingPath(consumption.path, member),
    group,
    manifestPath: consumption.path,
    member,
  };
}

/** The one-line routing disclosure a delegating verb prints (human output), so a reader knows which
 * member answered. Silent for a plain recording. */
export function routingNote(target: VerbTarget, axisLabel: string): string | null {
  if (!target.group || !target.member) return null;
  return `run-group '${target.group.meta.name}': ${axisLabel} from member '${memberLabel(target.member)}'.`;
}
