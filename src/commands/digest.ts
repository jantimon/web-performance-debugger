import type { Digest, NormalizedEvent, Recording } from "../model/recording.js";
import { usToMs } from "../model/time.js";
import { isFirefoxDeep } from "../model/rung.js";
import { forcedLayouts, longTasks, extractInvalidations } from "../trace/analysis.js";
import { analyzeThrash } from "../trace/thrash.js";
import { firefoxDirtiedBy } from "../trace/firefox-dirtied.js";

export function buildDigest(rec: Recording, recordingPath: string, topN = 20): Digest {
  const start = rec.window.startTs;
  const inWindow: NormalizedEvent[] = rec.events.filter(
    (event) => start == null || event.ts >= start,
  );

  // Sampled events are Firefox read-site blame annotations, not measured durations: they feed
  // topBlame/forced below but must not rank among the slowest events, where their duration is not a
  // real wall measurement.
  const slowestEvents = [...inWindow]
    .filter((event) => event.dur > 0 && event.kind !== "task" && !event.sampled)
    .sort((firstEvent, secondEvent) => secondEvent.dur - firstEvent.dur)
    .slice(0, topN)
    .map((event) => ({
      id: event.id,
      kind: event.kind,
      name: event.name,
      durMs: usToMs(event.dur),
      at: event.at,
    }));

  const blame = new Map<string, { at: string; count: number; durMs: number; kinds: Set<string> }>();
  for (const event of inWindow) {
    if (!event.at) continue;
    const group = blame.get(event.at) ?? {
      at: event.at,
      count: 0,
      durMs: 0,
      kinds: new Set<string>(),
    };
    group.count++;
    group.durMs += usToMs(event.dur);
    group.kinds.add(event.kind);
    blame.set(event.at, group);
  }
  const topBlame = [...blame.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, topN)
    .map((group) => ({
      at: group.at,
      count: group.count,
      durMs: group.durMs,
      kinds: [...group.kinds] as Digest["topBlame"][number]["kinds"],
    }));

  const inval = new Map<
    string,
    { kind: string; reason: string; count: number; sampleAt?: string }
  >();
  for (const invalidation of extractInvalidations(inWindow, start)) {
    const reason = invalidation.reason ?? "(unknown)";
    const key = `${invalidation.kind}::${reason}`;
    const group = inval.get(key) ?? {
      kind: invalidation.kind,
      reason,
      count: 0,
      sampleAt: invalidation.at,
    };
    group.count++;
    if (!group.sampleAt && invalidation.at) group.sampleAt = invalidation.at;
    inval.set(key, group);
  }
  const invalidationsByReason = [...inval.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, topN);

  // The layout-thrashing detector + dirtied-by write annotation, Chrome `--deep` only: it walks
  // the invalidation records the full trace carries, which no other lane has (Firefox/--breakdown
  // drop them). Absent (undefined thrash, no dirtiedBy) elsewhere -- not a fabricated 0. Fed the FULL
  // event log (rec.events), not the windowed `inWindow`: the enclosing RunTask can begin just before
  // the run:start mark, so windowing first would drop it; analyzeThrash windows the flushes itself.
  const isDeep = rec.meta.passes.includes("deep");
  const thrashAnalysis = isDeep ? analyzeThrash(rec.events, start) : null;
  // Firefox --deep: Gecko's native cause-stack write identity, first-invalidation-only. A SEPARATE
  // rollup from the read-site `forced` above (never merged into it), and never a thrash input -- the
  // partial write set cannot feed the detector. Absent (undefined) on chrome and every non-deep
  // firefox run, so a consumer never mistakes it for chrome's full write set or a fabricated one.
  const firefoxDirtiedByReport = isFirefoxDeep(rec.meta.passes)
    ? firefoxDirtiedBy(rec.events, start)
    : null;
  const forced = forcedLayouts(inWindow, start)
    .slice(0, topN)
    .map((forcedEntry) => {
      const dirtiedBy = thrashAnalysis?.dirtiedByReadSite[forcedEntry.at];
      return dirtiedBy?.length ? { ...forcedEntry, dirtiedBy } : forcedEntry;
    });
  const tasks = longTasks(inWindow, start)
    .slice(0, topN)
    .map((task) => ({
      id: task.id,
      ts: task.ts,
      durMs: task.durMs,
      dominantKind: task.dominantKind,
      at: task.at,
    }));

  return {
    recording: recordingPath,
    meta: rec.meta,
    window: rec.window,
    summary: rec.summary,
    slowestEvents,
    topBlame,
    forced: forced.map((forcedEntry) => ({
      at: forcedEntry.at,
      count: forcedEntry.count,
      durMs: forcedEntry.durMs,
      ...("dirtiedBy" in forcedEntry ? { dirtiedBy: forcedEntry.dirtiedBy } : {}),
    })),
    // The thrash rollup rides only a Chrome --deep recording (thrashAnalysis is null otherwise), so
    // this is absent on every other lane, Firefox included -- "not available", never a fabricated
    // count: 0. Firefox --deep has no full write set to detect thrashing from.
    ...(thrashAnalysis ? { thrash: thrashAnalysis.report } : {}),
    // Firefox --deep's dirtied-by write report (first-invalidation-only). Absent on chrome and
    // non-deep firefox, so it never poses as chrome's exact write set.
    ...(firefoxDirtiedByReport ? { firefoxDirtiedBy: firefoxDirtiedByReport } : {}),
    longTasks: tasks,
    invalidationsByReason,
    // The recording's spans (run + steps + measures), carried through so `query digest` exposes them
    // and JSON consumers get the per-span bars automatically.
    spans: rec.spans,
    hints: [
      `Full record: ${recordingPath} — do NOT read it wholesale.`,
      `Layout thrashing (with source lines): wpd query blame --forced "${recordingPath}"`,
      `Longest tasks: wpd query events "${recordingPath}" --kind task --top 10`,
      `Drill into an event by id: wpd query get "${recordingPath}" <id>`,
      `Gate in CI: wpd assert "${recordingPath}" --max-forced 0 --max-layouts 50`,
    ],
  };
}
