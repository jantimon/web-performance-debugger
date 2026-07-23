import { DEFAULT_CPU_INTERVAL_US } from "../profile/cpuprofile.js";
import type { RawCpuProfile, RawProfileNode, RawCallFrame } from "../profile/cpuprofile.js";
import { toRawTraceEvents } from "./scan.js";

// The trace's CPU profiler stream. Enabling the `disabled-by-default-v8.cpu_profiler` trace category
// makes V8 emit a `Profile` event (the stream's startTime) followed by `ProfileChunk` events
// (incremental nodes + samples + timeDeltas) per sampled isolate, with NO CDP Profiler.start/stop.
// The stream is continuous across a cross-document navigation, so a pre-navigation window keeps its
// samples, which the CDP sampler drops (it restarts in the new renderer process).
//
// One `Profile` record per (pid, Profile id): a navigation swaps renderer process and each process
// restarts its node-id space at 1, so the per-process streams must be MERGED into one id space, not
// concatenated naively (which conflates the two roots). The merge renumbers node ids into disjoint
// ranges, inverts each node's `parent` link into a `children[]` array, and stamps every sample with
// its absolute trace-clock timestamp (startTime + cumulative timeDeltas within its own process), so a
// windowing consumer never reconstructs a cross-process cumsum that would compress the gap away.

/** A node as the trace emits it: a single `parent` link, not the `children[]` CDP uses. */
interface TraceProfileNode {
  id: number;
  callFrame: {
    functionName?: string;
    scriptId?: number | string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  parent?: number;
}

interface RawTraceEvent {
  name: string;
  pid?: number;
  ts?: number;
  id?: string | number;
  args?: {
    data?: {
      startTime?: number;
      cpuProfile?: { nodes?: TraceProfileNode[]; samples?: number[] };
      timeDeltas?: number[];
      /** per-sample EXECUTING line (1-based, trace-stack convention), aligned with cpuProfile.samples.
       * Present on recent Chrome; absent on older builds, in which case sampled read-site blame
       * degrades to unavailable rather than to a wrong (function-definition) line. */
      lines?: number[];
    };
  };
}

interface ProfileGroup {
  /** the stream's base clock (base::TimeTicks us), shared with the trace events and wpd:* markers */
  startTime: number | undefined;
  /** the Profile event's own ts, a fallback base clock when args.data.startTime is absent */
  fallbackStartTs: number | undefined;
  /** node id -> node, first definition wins (a node is emitted once, in the chunk that introduces it) */
  nodes: Map<number, TraceProfileNode>;
  /** the ProfileChunk payloads for this stream, ordered by ts before the deltas are accumulated. `lines`
   * is the per-sample executing line (undefined when the chunk carried no `data.lines`). */
  chunks: { ts: number; samples: number[]; timeDeltas: number[]; lines: number[] | undefined }[];
}

export interface AssembledTraceCpuProfile {
  /** the merged, CDP-shaped profile fed to buildCpuModel unchanged */
  profile: RawCpuProfile;
  /** the interval the stream actually ran at, read back from the inter-sample deltas */
  sampleIntervalUs: number;
  /** per-sample EXECUTING line (1-based), parallel to `profile.samples`/`profile.sampleTimestampsUs`,
   * for sampled read-site forced-layout blame. Absent when NO chunk carried `data.lines` (older
   * Chrome): the feature then reports unavailable, never a function-definition line. A sample whose
   * chunk lacked the field carries -1 here (skipped downstream). */
  sampleLines?: number[];
}

const PROFILE_EVENT = "Profile";
const PROFILE_CHUNK_EVENT = "ProfileChunk";

function normalizeCallFrame(callFrame: TraceProfileNode["callFrame"]): RawCallFrame {
  return {
    functionName: callFrame.functionName ?? "",
    // scriptId is a number in the trace; buildCpuModel keys frames on name/url/line/col, not scriptId,
    // but the CDP-shaped type wants a string, so match it.
    scriptId: String(callFrame.scriptId ?? 0),
    url: callFrame.url ?? "",
    // The trace uses the CDP 0-based line/column convention; -1 means "no position" (a system frame).
    lineNumber: callFrame.lineNumber ?? -1,
    columnNumber: callFrame.columnNumber ?? -1,
  };
}

/** The stream's base clock: the Profile event's startTime, else its own ts, else the earliest chunk. */
function startOf(group: ProfileGroup): number {
  if (group.startTime != null) return group.startTime;
  if (group.fallbackStartTs != null) return group.fallbackStartTs;
  let earliest = Infinity;
  for (const chunk of group.chunks) earliest = Math.min(earliest, chunk.ts);
  return Number.isFinite(earliest) ? earliest : 0;
}

/** The interval the stream ran at, as the lower-median inter-sample delta. The stream runs at a fixed
 * rate (no CDP profiler to coarsen it), so the median is the honest per-sample time each `selfMs`
 * prices. Picking the lower of the two middle deltas (never their average) keeps the result an actual
 * observed integer-microsecond delta: it is printed verbatim (`query cpu` headline), and an averaged
 * "150.5us" would name an interval no sample ran at. */
function medianInterval(timeDeltas: number[]): number {
  const positive = timeDeltas.filter((delta) => delta > 0).sort((left, right) => left - right);
  if (positive.length === 0) return DEFAULT_CPU_INTERVAL_US;
  return positive[(positive.length - 1) >> 1];
}

/**
 * Assemble a CDP-shaped `RawCpuProfile` from a trace's `disabled-by-default-v8.cpu_profiler`
 * ProfileChunk stream, merging every (pid, Profile id) tree into one node-id space. Returns null when
 * the trace carries no chunk stream (a browser build that does not emit it), the honest signal to fall
 * back to the not-covered reporting -- never a fabricated zero-sample profile.
 *
 * Pure over the raw trace (string, `{traceEvents}`, the bare event array, or a `scanTraceEvents`
 * generator), so it is fixture-testable.
 */
export function assembleTraceCpuProfile(
  trace: string | Uint8Array | { traceEvents?: RawTraceEvent[] } | Iterable<RawTraceEvent>,
): AssembledTraceCpuProfile | null {
  const events = toRawTraceEvents<RawTraceEvent>(trace);

  const groups = new Map<string, ProfileGroup>();
  const groupFor = (event: RawTraceEvent): ProfileGroup => {
    // Group by the (pid, Profile id) pair, not pid alone: one renderer can emit more than one stream.
    const key = `${event.pid ?? 0} ${event.id ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { startTime: undefined, fallbackStartTs: undefined, nodes: new Map(), chunks: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const event of events) {
    if (event.name === PROFILE_EVENT) {
      const group = groupFor(event);
      group.startTime = event.args?.data?.startTime;
      group.fallbackStartTs = event.ts;
    } else if (event.name === PROFILE_CHUNK_EVENT) {
      const group = groupFor(event);
      const data = event.args?.data;
      for (const node of data?.cpuProfile?.nodes ?? [])
        if (!group.nodes.has(node.id)) group.nodes.set(node.id, node);
      group.chunks.push({
        ts: event.ts ?? 0,
        samples: data?.cpuProfile?.samples ?? [],
        timeDeltas: data?.timeDeltas ?? [],
        // undefined (not []) when the field is absent, so a chunk that lacks lines is distinguished
        // from one that legitimately carried an empty sample set.
        lines: data?.lines,
      });
    }
  }

  // Only streams that carried samples; ordered by base clock so the concatenated stream starts ascending.
  const orderedGroups = [...groups.values()]
    .filter((group) => group.chunks.length > 0)
    .sort((left, right) => startOf(left) - startOf(right));
  if (orderedGroups.length === 0) return null;

  const nodes: RawProfileNode[] = [];
  const childrenById = new Map<number, number[]>();
  let samples: number[] = [];
  let timeDeltas: number[] = [];
  let sampleTimestampsUs: number[] = [];
  // Per-sample executing line, parallel to `samples`. -1 = no line for this sample (its chunk carried
  // no `data.lines`); `anyLines` stays false until a real line lands, so a stream that never emits the
  // field returns sampleLines absent (the feature reports unavailable, never a fake line).
  let sampleLines: number[] = [];
  let anyLines = false;
  let nextId = 1;
  let earliestStart = Infinity;

  for (const group of orderedGroups) {
    // Renumber this stream's node ids into a range disjoint from every other stream's.
    const localToGlobal = new Map<number, number>();
    for (const localId of group.nodes.keys()) localToGlobal.set(localId, nextId++);
    for (const [localId, node] of group.nodes) {
      const globalId = localToGlobal.get(localId)!;
      nodes.push({ id: globalId, callFrame: normalizeCallFrame(node.callFrame) });
      if (node.parent != null) {
        const parentGlobalId = localToGlobal.get(node.parent);
        if (parentGlobalId != null) {
          const list = childrenById.get(parentGlobalId) ?? [];
          list.push(globalId);
          childrenById.set(parentGlobalId, list);
        }
      }
    }
    const start = startOf(group);
    earliestStart = Math.min(earliestStart, start);
    // Absolute per-sample timestamp = this stream's base clock + its own cumulative deltas. Reset per
    // stream: process B's deltas are relative to process B's startTime, not a continuation of A's.
    let clock = start;
    const orderedChunks = [...group.chunks].sort((left, right) => left.ts - right.ts);
    for (const chunk of orderedChunks) {
      for (let index = 0; index < chunk.samples.length; index++) {
        const deltaUs = chunk.timeDeltas[index] ?? 0;
        clock += deltaUs;
        const globalId = localToGlobal.get(chunk.samples[index]);
        // A sample referencing a node no chunk introduced is unmappable; skip rather than mis-attribute.
        if (globalId == null) continue;
        samples.push(globalId);
        timeDeltas.push(deltaUs);
        sampleTimestampsUs.push(clock);
        const line = chunk.lines?.[index];
        if (typeof line === "number") anyLines = true;
        sampleLines.push(typeof line === "number" ? line : -1);
      }
    }
  }
  if (samples.length === 0) return null;

  for (const node of nodes) {
    const children = childrenById.get(node.id);
    if (children) node.children = children;
  }

  // A cross-process merge can interleave the tail of one stream with the head of the next if their
  // active windows overlapped; sort the parallel sample arrays by timestamp so the per-span hot tally
  // sees a monotonic clock. That tally (profile/span-hot.ts tallySpanHot) sweeps the samples with a
  // single moving pointer that never rewinds and early-breaks past the last window, so an out-of-order
  // sample would be miscounted; the js-by-package split and buildCpuModel are order-independent, but
  // this one consumer is not. A single stream is already ascending, so this only runs across a navigation.
  if (orderedGroups.length > 1) {
    const order = sampleTimestampsUs.map((_timestamp, index) => index);
    order.sort((left, right) => sampleTimestampsUs[left] - sampleTimestampsUs[right]);
    // Reassign to the reordered arrays. Spreading them back in place with
    // `splice(0, len, ...sorted)` passes a per-sample-sized array (hundreds of thousands of entries on
    // a heavy page) as call arguments, which overflows the stack (`Maximum call stack size exceeded`).
    samples = order.map((index) => samples[index]);
    timeDeltas = order.map((index) => timeDeltas[index]);
    sampleTimestampsUs = order.map((index) => sampleTimestampsUs[index]);
    sampleLines = order.map((index) => sampleLines[index]);
  }

  const startTime = Number.isFinite(earliestStart) ? earliestStart : 0;
  const profile: RawCpuProfile = {
    nodes,
    startTime,
    endTime: sampleTimestampsUs[sampleTimestampsUs.length - 1] ?? startTime,
    samples,
    timeDeltas,
    sampleTimestampsUs,
  };
  return {
    profile,
    sampleIntervalUs: medianInterval(timeDeltas),
    // Absent when no chunk carried lines: the sampled-blame join then reports unavailable.
    ...(anyLines ? { sampleLines } : {}),
  };
}

/**
 * Drop samples earlier than `fromTs` (trace-clock us) from a trace-sourced profile, so the CPU model
 * describes the run onward rather than the whole trace (which in driver mode spans prepare()/warmup
 * before the run window). The nodes/tree are kept intact -- buildCpuModel bills self-time from samples,
 * so a node that loses all its samples simply reads zero. Requires the per-sample timestamps the
 * trace lane carries; a profile without them is returned unchanged.
 */
export function windowTraceCpuProfile(profile: RawCpuProfile, fromTs: number): RawCpuProfile {
  const timestamps = profile.sampleTimestampsUs;
  if (!timestamps) return profile;
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  const sampleTimestampsUs: number[] = [];
  for (let index = 0; index < profile.samples.length; index++) {
    if (timestamps[index] < fromTs) continue;
    samples.push(profile.samples[index]);
    timeDeltas.push(profile.timeDeltas[index] ?? 0);
    sampleTimestampsUs.push(timestamps[index]);
  }
  return {
    ...profile,
    startTime: sampleTimestampsUs[0] ?? fromTs,
    endTime: sampleTimestampsUs[sampleTimestampsUs.length - 1] ?? fromTs,
    samples,
    timeDeltas,
    sampleTimestampsUs,
  };
}
