import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import type {
  AllocFunction,
  AllocGroupStat,
  AllocModel,
  AllocSamplingConfig,
} from "../model/alloc.js";
import type { RecordingMeta } from "../model/recording.js";
import { makeSourceResolver, makeNodeSourceResolver } from "../trace/stacks.js";
import { SourceMapResolver } from "../trace/sourcemap.js";
import { frameKey, rankedFrameKeys, type RawCallFrame } from "./raw.js";
import { resolveCallFrame, type ResolvedFrame } from "./cpuprofile.js";
import { deserialize } from "../output/format.js";
import { assertSchemaVersion } from "../model/artifact.js";
import { resolveTarget } from "../commands/resolve.js";

/**
 * The raw V8 heap SAMPLING profile, as `HeapProfiler.stopSampling` returns it (`.profile`). A tree of
 * allocation call frames (`head` + nested `children`), each node carrying the bytes sampled AT that
 * frame (`selfSize`), plus the per-sample event list. Distinct from `RawCpuProfile` (a flat node list
 * + `samples`/`timeDeltas`): heap sampling is a tree, so this needs its own walk
 */
export interface RawHeapNode {
  callFrame: RawCallFrame;
  /** bytes sampled at this frame directly (children excluded) */
  selfSize: number;
  id: number;
  children?: RawHeapNode[];
}

export interface RawHeapSample {
  size: number;
  nodeId: number;
  ordinal: number;
}

export interface RawHeapProfile {
  head: RawHeapNode;
  samples: RawHeapSample[];
}

/**
 * Turn a raw heap sampling profile into a resolved `AllocModel`: aggregate `selfSize` per frame, rank
 * rankable user frames by self bytes, and resolve each to its owning package/source with the SAME
 * `resolveCallFrame` + package walk the CPU model uses, so an allocation's package matches
 * `query cpu --by package`'s spelling. System pseudo-frames ((root)) and the tool's own harness frames
 * drop out of the ranking (isRankableFrame), so `totalBytes` and the shares never bill wpd's own loop
 */
export async function buildAllocModel(
  raw: RawHeapProfile,
  context: {
    /** path to the raw .heapprofile (stored as the model's back-pointer) */
    profilePath: string;
    /** the recording identity/provenance to stamp on the model */
    meta: RecordingMeta;
    /** the heap sampler config the numbers came from */
    sampling: AllocSamplingConfig;
    /** project root, so resolved source paths store relative to it */
    root: string;
    /** "node" rewrites file:// frames to local paths; default "chrome" */
    runtime?: "chrome" | "node";
    /** served-page origin for url->local rewriting (chrome runtime); omit for node */
    serverUrl?: string;
    /** share one resolver (cache + diagnostics) with the run; omit for a fresh one */
    maps?: SourceMapResolver;
  },
): Promise<AllocModel> {
  // Walk the sampling tree, summing self bytes by frame key and keeping one call frame per key
  const selfBytesByKey = new Map<string, number>();
  const callFrameByKey = new Map<string, RawCallFrame>();
  const stack: RawHeapNode[] = [raw.head];
  while (stack.length) {
    const node = stack.pop()!;
    const key = frameKey(node.callFrame);
    callFrameByKey.set(key, node.callFrame);
    selfBytesByKey.set(key, (selfBytesByKey.get(key) ?? 0) + (node.selfSize ?? 0));
    for (const child of node.children ?? []) stack.push(child);
  }

  // Resolve each unique frame once (sourcemap + local path), shared cache with the run's resolver
  const rewriteToLocal =
    context.runtime === "node"
      ? makeNodeSourceResolver()
      : makeSourceResolver(context.serverUrl ?? "", context.root);
  const maps = context.maps ?? new SourceMapResolver();
  const packageCache = new Map<string, string | null>();
  const resolvedByKey = new Map<string, ResolvedFrame>();
  for (const [key, callFrame] of callFrameByKey)
    resolvedByKey.set(
      key,
      await resolveCallFrame(
        callFrame,
        rewriteToLocal,
        maps,
        packageCache,
        context.root,
        context.serverUrl ?? "",
      ),
    );
  const unmappedFrames = [...resolvedByKey.values()].filter((frame) => frame.unmapped).length;

  // Rank rankable user frames by self bytes (isRankableFrame drops (root)/system pseudo-frames and the
  // tool's own harness frames), reusing the CPU model's ranking with bytes as the weight. totalBytes is
  // the sum over these ranked frames, so the per-package/per-function shares reconcile to 100% against
  // it (the (root) frame's own selfSize is ~0 and never a real owner)
  const rankedKeys = rankedFrameKeys(callFrameByKey, selfBytesByKey);
  const totalBytes = rankedKeys.reduce((sum, key) => sum + (selfBytesByKey.get(key) ?? 0), 0);

  const functions: AllocFunction[] = rankedKeys.map((key, index) => {
    const resolved = resolvedByKey.get(key)!;
    const selfBytes = selfBytesByKey.get(key) ?? 0;
    return {
      id: index,
      fn: resolved.fn,
      minified: resolved.minified,
      source: resolved.source,
      file: resolved.file,
      package: resolved.package,
      selfBytes,
      selfPct: totalBytes > 0 ? (selfBytes / totalBytes) * 100 : 0,
    };
  });

  return {
    profile: context.profilePath,
    meta: context.meta,
    sampling: context.sampling,
    totalBytes,
    sampleCount: raw.samples?.length ?? 0,
    functions,
    unmappedFrames,
  };
}

/** Self bytes bucketed by a per-function key (package or file), descending. Denominated by
 * `totalBytes`, so the shares reconcile to 100% -- the same contract packageRollup keeps for CPU */
function allocRollup(model: AllocModel, keyOf: (fn: AllocFunction) => string): AllocGroupStat[] {
  const byKey = new Map<string, { selfBytes: number; functions: number }>();
  for (const fn of model.functions) {
    const key = keyOf(fn);
    const entry = byKey.get(key) ?? { selfBytes: 0, functions: 0 };
    entry.selfBytes += fn.selfBytes;
    entry.functions += 1;
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .map(([key, entry]) => ({
      key,
      selfBytes: entry.selfBytes,
      selfPct: model.totalBytes > 0 ? (entry.selfBytes / model.totalBytes) * 100 : 0,
      functions: entry.functions,
    }))
    .sort((left, right) => right.selfBytes - left.selfBytes);
}

/** Self bytes by owning npm/workspace package (the headline rollup) */
export function packageAllocRollup(model: AllocModel): AllocGroupStat[] {
  return allocRollup(model, (fn) => fn.package);
}

/** Self bytes by source file */
export function fileAllocRollup(model: AllocModel): AllocGroupStat[] {
  return allocRollup(model, (fn) => fn.file ?? "(native)");
}

/** An AllocModel carries `functions[]` AND a `sampling` block; a CpuModel has functions but no
 * `sampling`, so that field discriminates the two artifact kinds at one schema epoch */
function looksLikeAllocModel(parsed: unknown): parsed is AllocModel {
  return (
    !!parsed &&
    Array.isArray((parsed as AllocModel).functions) &&
    typeof (parsed as AllocModel).sampling === "object" &&
    (parsed as AllocModel).sampling != null
  );
}

/**
 * Load a resolved allocation model. Accepts the `.alloc.json` directly, `latest`, or (as a
 * convenience) a recording path whose sibling `.alloc.json` is loaded instead. A `--target node`
 * (CPU) recording passed here points the reader at `query cpu`, so the two verbs never load each
 * other's model silently
 */
export async function loadAllocModel(file: string): Promise<AllocModel> {
  const abs = await resolveTarget(file, "alloc-model");
  const parsed = deserialize(await fs.readFile(abs, "utf8"), path.extname(abs).toLowerCase());
  if (looksLikeAllocModel(parsed)) {
    assertSchemaVersion(parsed.meta?.schemaVersion, abs);
    return parsed;
  }
  // A recording path was likely passed; try its sibling alloc model. An extension-less `--out`
  // recording defaults the sibling to `.json`
  const ext = path.extname(abs);
  const base = ext ? abs.slice(0, -ext.length) : abs;
  const sibling = `${base}.alloc${ext || ".json"}`;
  try {
    const fallback = deserialize(
      await fs.readFile(sibling, "utf8"),
      path.extname(sibling).toLowerCase(),
    );
    if (looksLikeAllocModel(fallback)) {
      assertSchemaVersion(fallback.meta?.schemaVersion, sibling);
      return fallback;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  // A CPU-sampling recording (the default node lane, or a chrome capture) has a `.cpu.json` sibling,
  // not a `.alloc.json`: point at `query cpu` rather than a bare "not an alloc model"
  if (existsSync(`${base}.cpu.json`) || existsSync(`${base}.cpu.toon`)) {
    const wrongModel = new Error(
      `${file} sampled CPU, not allocation, so it has no allocation model. Use \`query cpu\` for its self-time attribution, or re-record with --alloc for allocation attribution.`,
    );
    (wrongModel as NodeJS.ErrnoException).code = "ENOALLOCMODEL";
    throw wrongModel;
  }
  const noModel = new Error(
    `${file} is not an allocation model. Pass the .alloc.json, or use 'latest' after \`record <module> --target node --alloc\`.`,
  );
  (noModel as NodeJS.ErrnoException).code = "ENOALLOCMODEL";
  throw noModel;
}
