import type { Digest, NormalizedEvent, Recording } from "../model/recording.js";
import { usToMs } from "../model/time.js";
import { forcedLayouts, longTasks, extractInvalidations } from "../trace/analysis.js";

export function buildDigest(rec: Recording, recordingPath: string, topN = 20): Digest {
  const start = rec.window.startTs;
  const inWindow: NormalizedEvent[] = rec.events.filter(
    (event) => start == null || event.ts >= start,
  );

  const slowestEvents = [...inWindow]
    .filter((event) => event.dur > 0 && event.kind !== "task")
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

  const forced = forcedLayouts(inWindow, start).slice(0, topN);
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
    })),
    longTasks: tasks,
    invalidationsByReason,
    // --breakdown mode only; carried through so `query digest` exposes the per-span bars (and JSON
    // consumers get them automatically). Absent on every other mode.
    breakdowns: rec.breakdowns,
    hints: [
      `Full record: ${recordingPath} — do NOT read it wholesale.`,
      `Layout thrashing (with source lines): wpd query blame --forced "${recordingPath}"`,
      `Longest tasks: wpd query events "${recordingPath}" --kind task --top 10`,
      `Drill into an event by id: wpd query get "${recordingPath}" <id>`,
      `Gate in CI: wpd assert "${recordingPath}" --max-forced 0 --max-layouts 50`,
    ],
  };
}
