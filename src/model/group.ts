// A run group: N separate, unfused captures of ONE workload, recorded as sibling recordings under
// one manifest (`<base>.group.json`). "One capture per invocation" means one capture per RECORDING;
// a group is the sanctioned two-question path (e.g. --breakdown for the bar AND --deep for the
// attribution report), each its own real capture. The manifest holds NO summary, NO wall, NO
// aggregate of its own -- structurally, so no output can imply one number describes the group, and
// nothing is ever averaged across members. This module is the PURE core: the manifest shape, the
// formation-honesty rules (reusing comparabilityMismatches), member routing (pickMember), and the
// cross-member count-disagreement check. The fs writer/reader and the runner live in
// src/record/group.ts and commands/group.ts.

import type { RecordingMeta, WorkloadIdentity } from "./recording.js";
import { comparabilityMismatches } from "./compat.js";

/** The manifest's discriminator meta. `kind: "run-group"` is what tells a reader this file is a
 * manifest, not a Recording (which has no `meta.kind`), at the SAME schema epoch -- like a sibling
 * .cpu.json is a different artifact kind at the same epoch. */
export interface GroupMeta {
  tool: string;
  version: string;
  schemaVersion: string;
  kind: "run-group";
  createdAt: string;
  /** the group name (`record --group <name>`), the manifest's identity for a reader */
  name: string;
}

/** One member of a group: a whole recording captured in one mode, referenced by path. */
export interface GroupMember {
  /** the member's capture mode = its recording's `meta.passes[0]` (breakdown/deep/gecko/...) */
  mode: string;
  /** the member's variant label, when the recording carried one (`--variant`); absent otherwise */
  variant?: string;
  /** path to the recording, RELATIVE to the manifest's own directory (members are always siblings,
   * so the group survives moving/committing the recordings dir) */
  recording: string;
  /** path to the resolved CPU model, relative to the manifest dir; absent when the mode sampled none */
  cpuModel?: string;
  /** path to the raw .cpuprofile, relative to the manifest dir; absent when the mode sampled none */
  cpuProfile?: string;
  createdAt: string;
  /** the member's own workload identity (lane/host/module); the group refuses a member whose identity
   * differs from the others', so this equals the group's, kept per-member for a self-contained read */
  workload?: WorkloadIdentity;
  /** per-member join disclosures (e.g. a sampler-interval difference that annotated rather than refused) */
  annotations: string[];
}

/**
 * The run-group manifest (`<base>.group.json`). Carries the shared workload identity + capture axes
 * (so a consumer reads them without opening a member) and the member list, but NO summary/wall/aggregate
 * of its own: the whole point is that no field can imply one number describes the group.
 */
export interface RunGroup {
  meta: GroupMeta;
  /** the shared workload identity (lane/host/module), stabilized the same way compat.ts stabilizes it */
  workload?: WorkloadIdentity;
  iterations: number;
  warmup: number;
  headless: boolean;
  /** chrome headless flavour when headless (shell/new); absent when headed or firefox/node */
  headlessMode?: "shell" | "new";
  throttle?: { cpuRate?: number };
  /** browser backend of every member; absent => chrome */
  browser?: "chrome" | "firefox";
  /** execution runtime of every member; absent => chrome */
  runtime?: "chrome" | "node";
  /** group-level variant (nullable): the shared technique label, when every member carries one */
  variant?: string;
  /** the capture modes a `--members` run asked this group to hold, so partial status is derived
   * structurally (requested minus present) at every append rather than narrated once on failure.
   * Set/unioned only by the `--members` runner; absent on an ad-hoc `--group` group, which is
   * complete-by-construction (each single record is a whole member) and never reports partial. */
  requested?: string[];
  members: GroupMember[];
  /** group-level disclosures: partial formation, count disagreement across members */
  notes: string[];
}

/** The outcome of testing a joining member against a group: any refusal blocks the join; annotations
 * ride along on the member (they warn but do not block). */
export interface FormationVerdict {
  /** why the join is refused (one line each); empty means the member may join */
  refusals: string[];
  /** non-blocking disclosures for the joining member (e.g. a sampler-interval difference) */
  annotations: string[];
}

/**
 * Decide whether a member may join a group, reusing `comparabilityMismatches` so the group speaks the
 * SAME comparability vocabulary a diff gate does. A `blocksGating` axis that differs REFUSES the join
 * -- EXCEPT capture-mode, whose differing is the group's whole purpose. So workload, iterations,
 * warmup, browser, runtime, throttle, headless flavour and variant must match; the capture mode must
 * not. A non-blocking axis (sampler-interval) ANNOTATES instead: the member joins with a note. A
 * duplicate `(mode, variant)` pair is also refused -- two identical captures are not two questions.
 *
 * `reference` is an existing member's full meta (member 0's recording), `joining` the candidate's,
 * `existingPairs` every member already in the group. Pure: the caller reads the metas and applies the
 * verdict.
 */
export function formationVerdict(
  reference: RecordingMeta,
  joining: RecordingMeta,
  existingPairs: { mode: string; variant?: string }[],
): FormationVerdict {
  const refusals: string[] = [];
  const annotations: string[] = [];
  for (const mismatch of comparabilityMismatches(reference, joining)) {
    if (mismatch.axis === "capture-mode") continue; // the group exists to hold differing modes
    if (mismatch.blocksGating)
      refusals.push(
        `${mismatch.axis}: ${mismatch.base} vs ${mismatch.current} (must match across a group)`,
      );
    else annotations.push(`${mismatch.axis} differs (${mismatch.base} vs ${mismatch.current})`);
  }
  const joiningMode = joining.passes[0];
  const joiningVariant = joining.variant;
  if (existingPairs.some((pair) => pair.mode === joiningMode && pair.variant === joiningVariant)) {
    const label = joiningVariant ? `${joiningMode}/${joiningVariant}` : joiningMode;
    refusals.push(
      `duplicate member (${label}): a group already holds this capture mode + variant. Two ` +
        `identical captures are not two questions; drop --members to re-record just this one.`,
    );
  }
  return { refusals, annotations };
}

// --- Member routing: which member answers a given consumption axis ---

/** A member's mode carries the deep event log (forced-layout blame, dirtied-by, thrash, exact counts). */
export function modeIsDeep(mode: string): boolean {
  return mode === "deep" || mode === "gecko-deep";
}

/** A member's mode ran a CPU sampler, so it carries a CpuModel and (breakdown/gecko/node) a bar. */
export function modeHasCpu(mode: string): boolean {
  return mode !== "deep" && mode !== "precise-wall";
}

/** A member's mode carries exact rendering counts (layout/style/paint, plus forced on the deep tiers). */
export function modeHasCounts(mode: string): boolean {
  return mode === "breakdown" || modeIsDeep(mode) || mode === "gecko";
}

/** A member's mode carries the deep event log (forced-layout blame, dirtied-by, thrash). Chrome writes
 * it under `--deep`; firefox writes it at every gecko capture mode (the gecko pass carries the markers
 * and the sampled read-site blame), so a plain `gecko` member has it too. */
export function modeHasEventLog(mode: string): boolean {
  return modeIsDeep(mode) || mode === "gecko";
}

/** How to name a member in a routing/disclosure line: its mode, or `mode/variant`. */
export function memberLabel(member: Pick<GroupMember, "mode" | "variant">): string {
  return member.variant ? `${member.mode}/${member.variant}` : member.mode;
}

/** The consumption axes a group routes to a member. */
export type MemberAxis =
  | "slice-bar"
  | "cpu"
  | "forced"
  | "dirtied"
  | "thrash"
  | "blame"
  | "counts"
  | "inp";

/**
 * Pick the member that measures `axis`, or null when no member did (a loud n/a at the call site,
 * never a silent pass). The routing:
 *   - slice-bar / cpu -> the CPU-bearing member, breakdown preferred (its reconciling bar).
 *   - blame -> the deep member (exact read-site), else a breakdown member (sampled read-site blame).
 *   - forced / dirtied / thrash -> the deep member only (the forced COUNT and the WRITE set need what
 *     --breakdown drops: `.stack` / invalidationTracking).
 *   - counts -> the deep member preferred (exact + forced), else any counting member (disclosed).
 *   - inp -> any member: INP is an in-page observer ungated by capture mode, and every member shares
 *     the group's lane + workload, so all observed the same interaction.
 */
export function pickMember(group: RunGroup, axis: MemberAxis): GroupMember | null {
  const { members } = group;
  const prefer = (
    first: (member: GroupMember) => boolean,
    fallback?: (member: GroupMember) => boolean,
  ): GroupMember | null =>
    members.find(first) ?? (fallback ? (members.find(fallback) ?? null) : null);
  switch (axis) {
    case "slice-bar":
    case "cpu":
      return prefer(
        (member) => member.mode === "breakdown",
        (member) => modeHasCpu(member.mode),
      );
    case "blame":
      // The read-site blame log lives in the deep event log; a chrome `breakdown` member carries it
      // too, sampled from the CPU profile, so fall back to it when no deep member is present.
      return prefer(
        (member) => modeHasEventLog(member.mode),
        (member) => member.mode === "breakdown",
      );
    case "forced":
    case "dirtied":
    case "thrash":
      // The forced COUNT (assert --max-forced) and the WRITE set (dirtied-by, thrash) need what
      // --breakdown drops (`.stack` / invalidationTracking), so they are deep-only: no breakdown fallback.
      return prefer((member) => modeHasEventLog(member.mode));
    case "counts":
      return prefer(
        (member) => modeIsDeep(member.mode),
        (member) => modeHasCounts(member.mode),
      );
    case "inp":
      return members[0] ?? null;
  }
}

// --- Cross-member count disagreement ---

/** The exact-count fields two members can both measure; a disagreement on any is workload
 * nondeterminism worth surfacing. */
export const GROUP_COUNT_FIELDS = [
  ["layoutCount", "layout"],
  ["styleCount", "style recalc"],
  ["paintCount", "paint"],
  ["forcedLayoutCount", "forced layout/style"],
  ["layoutInvalidations", "layout invalidations"],
  ["styleInvalidations", "style invalidations"],
  ["longTaskCount", "long tasks"],
] as const;

export type GroupCountField = (typeof GROUP_COUNT_FIELDS)[number][0];

/** One member's exact counts, as read from its recording summary (null = the mode did not measure it). */
export interface MemberCounts {
  /** how to name this member in a disagreement note: its mode, or `mode/variant` */
  label: string;
  counts: Partial<Record<GroupCountField, number | null>>;
}

/**
 * Find every exact count that TWO OR MORE members both measured and disagree on, and word each as a
 * loud note. Two members measuring the same workload in different capture modes should agree on an
 * exact count; when they do not, that is workload nondeterminism (a race, an animation frame that
 * landed differently), which is signal. The group NEVER launders it into one number: it surfaces both
 * members' values. A field only one member measured, or that all agree on, produces nothing.
 */
export function countDisagreements(members: MemberCounts[]): string[] {
  const notes: string[] = [];
  for (const [field, label] of GROUP_COUNT_FIELDS) {
    const measured = members
      .map((member) => ({ label: member.label, value: member.counts[field] }))
      .filter((entry): entry is { label: string; value: number } => entry.value != null);
    if (measured.length < 2) continue;
    const distinct = new Set(measured.map((entry) => entry.value));
    if (distinct.size <= 1) continue;
    const detail = measured.map((entry) => `${entry.label}=${entry.value}`).join(", ");
    notes.push(
      `WARNING: members disagree on the exact ${label} count (${detail}). Two captures of one ` +
        `workload should agree on an exact count; this is workload nondeterminism (a race, a frame ` +
        `that landed differently), not a measurement error, so neither value is "the" count. Both are ` +
        `reported; do not average them.`,
    );
  }
  return notes;
}

// --- Partial-group status (requested vs present) ---

/**
 * The partial-group note, derived structurally from the modes a `--members` run requested versus the
 * modes present. While a requested mode is missing, one loud note names the gap and the exact recovery
 * command; when every requested mode is present (or none was requested), NO note. This describes the
 * CURRENT state only -- never a failure narrative -- so a recovered group carries no stale "the deep
 * capture failed" line once its missing member records. Pure: the caller reads the manifest and stores
 * the result.
 */
export function partialGroupNotes(
  name: string,
  requestedModes: string[],
  presentModes: string[],
): string[] {
  if (requestedModes.length === 0) return [];
  const present = new Set(presentModes);
  const missing = requestedModes.filter((mode) => !present.has(mode));
  if (missing.length === 0) return [];
  return [
    `WARNING: partial group: ${presentModes.length} of ${requestedModes.length} members recorded; ` +
      `missing: ${missing.join(", ")}. A verb routed to a missing member reports it as not measured ` +
      `(a loud n/a), never a silent pass. Record the missing member(s): ` +
      `\`record --members ${missing.join(",")} --group ${name}\`.`,
  ];
}
