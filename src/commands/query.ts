import { promises as fs } from "node:fs";
import path from "node:path";
import type { EventKind, NormalizedEvent, Recording, StepIndex } from "../model/recording.js";
import type { BlameEntry } from "../model/query.js";
import { num, table } from "../output/ascii.js";
import { deserialize, serialize, isFormat, type Format } from "../output/format.js";
import { buildDigest } from "./digest.js";
import { printSummary } from "./summaryView.js";
import { resolveTarget } from "./resolve.js";
import { EVENT_KINDS, isEventKind } from "../trace/classify.js";

interface OutOpts {
  json?: boolean;
  format?: string;
}

async function load(file: string): Promise<Recording> {
  const abs = await resolveTarget(file, "recording");
  const raw = await fs.readFile(abs, "utf8");
  return deserialize(raw, path.extname(abs).toLowerCase()) as Recording;
}

function structuredFormat(opts: OutOpts): Format | null {
  if (opts.format) {
    if (!isFormat(opts.format)) throw new Error("--format must be json or toon");
    return opts.format;
  }
  return opts.json ? "json" : null;
}

function emit(value: unknown, fmt: Format): void {
  console.log(serialize(value, fmt));
}

function eventsInWindow(rec: Recording): NormalizedEvent[] {
  const start = rec.window.startTs;
  return rec.events.filter((event) => start == null || event.ts >= start);
}

export async function queryDigest(file: string, opts: OutOpts): Promise<void> {
  const abs = await resolveTarget(file, "recording");
  const rec = await load(abs);
  const digest = buildDigest(rec, abs, 20);
  const fmt = structuredFormat(opts);
  if (fmt) return emit(digest, fmt);

  printSummary(rec);
  if (digest.forced.length) {
    console.log(
      "\nLayout thrashing — forced layout/style by source (run `query blame --forced` for all):",
    );
    console.log(
      table(
        ["count", "ms", "source"],
        digest.forced
          .slice(0, 8)
          .map((forcedEntry) => [forcedEntry.count, num(forcedEntry.durMs, 2), forcedEntry.at]),
      ),
    );
  }
  if (digest.longTasks.length) {
    console.log("\nLong tasks (drill in with `query get <file> <id>`):");
    console.log(
      table(
        ["id", "ms", "dominant", "source"],
        digest.longTasks
          .slice(0, 8)
          .map((task) => [task.id, num(task.durMs, 1), task.dominantKind ?? "?", task.at ?? ""]),
      ),
    );
  }
  console.log("\nSlowest events:");
  console.log(
    table(
      ["id", "kind", "name", "ms", "source"],
      digest.slowestEvents
        .slice(0, 10)
        .map((event) => [event.id, event.kind, event.name, num(event.durMs, 3), event.at ?? ""]),
    ),
  );
}

export async function queryIndex(file: string, opts: OutOpts): Promise<void> {
  const abs = await resolveTarget(file, "index");
  const raw = await fs.readFile(abs, "utf8");
  const idx = deserialize(raw, path.extname(abs).toLowerCase()) as StepIndex;
  const fmt = structuredFormat(opts);
  if (fmt) return emit(idx, fmt);

  console.log(`Stepped run — ${idx.steps.length} step(s). Full recording: ${idx.recording}`);
  if (idx.meta.throttle) {
    const throttle = idx.meta.throttle;
    console.log(
      `slowdown: ${[throttle.cpuRate ? `cpu ${throttle.cpuRate}x` : null, throttle.network].filter(Boolean).join(", ")}`,
    );
  }
  console.log(
    table(
      [
        "#",
        "label",
        "wall ms",
        "inp ms",
        "layout",
        "forced",
        "paint",
        "layoutInval",
        "longTasks",
        "file",
      ],
      idx.steps.map((step) => [
        step.index,
        step.label,
        num(step.wallMs ?? 0, 1),
        step.inpMs == null ? "—" : num(step.inpMs, 1),
        step.headline.layoutCount,
        step.headline.forcedLayoutCount,
        step.headline.paintCount,
        step.headline.layoutInvalidations,
        step.headline.longTaskCount,
        path.basename(step.recording),
      ]),
    ),
  );
  console.log("\nInspect a step:  wpd query digest <file above>");
}

export async function queryGet(file: string, id: number, opts: OutOpts): Promise<void> {
  const rec = await load(file);
  const event = rec.events.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`No event with id ${id} in ${file}`);
  emit(event, structuredFormat(opts) ?? "json");
}

export interface EventsQuery extends OutOpts {
  kind?: string;
  name?: string;
  forced?: boolean;
  top?: number;
  sort?: "dur" | "ts";
}

export async function queryEvents(file: string, query: EventsQuery): Promise<void> {
  if (query.kind && !isEventKind(query.kind))
    throw new Error(`Unknown --kind '${query.kind}'. Valid kinds: ${EVENT_KINDS.join(", ")}`);
  const rec = await load(file);
  let events = eventsInWindow(rec);
  if (query.kind) events = events.filter((event) => event.kind === query.kind);
  if (query.name)
    events = events.filter((event) => event.name.toLowerCase().includes(query.name!.toLowerCase()));
  if (query.forced) events = events.filter((event) => event.forced);
  events.sort((firstEvent, secondEvent) =>
    query.sort === "ts" ? firstEvent.ts - secondEvent.ts : secondEvent.dur - firstEvent.dur,
  );
  if (query.top != null) events = events.slice(0, query.top);

  const fmt = structuredFormat(query);
  if (fmt) return emit(events, fmt);
  console.log(
    table(
      ["id", "kind", "name", "ms", "source"],
      events.map((event) => [
        event.id,
        event.kind,
        event.name,
        num(event.dur / 1000, 3),
        event.at ?? "",
      ]),
    ),
  );
  console.log(`\n${events.length} event(s)`);
}

export interface BlameQuery extends OutOpts {
  kind?: string;
  forced?: boolean;
  /** show every attributed source line with a `forced` column (incl. forced=0) */
  all?: boolean;
  top?: number;
}

export async function queryBlame(file: string, query: BlameQuery): Promise<void> {
  if (query.kind && !isEventKind(query.kind))
    throw new Error(`Unknown --kind '${query.kind}'. Valid kinds: ${EVENT_KINDS.join(", ")}`);
  const rec = await load(file);
  let events = eventsInWindow(rec).filter((event) => event.at);
  // --forced narrows to thrashing; --all keeps everything (and reports forced=0 lines)
  if (query.forced && !query.all) events = events.filter((event) => event.forced);
  if (query.kind) events = events.filter((event) => event.kind === query.kind);

  const groups = new Map<
    string,
    { at: string; count: number; forced: number; durMs: number; kinds: Set<string> }
  >();
  for (const event of events) {
    const group = groups.get(event.at!) ?? {
      at: event.at!,
      count: 0,
      forced: 0,
      durMs: 0,
      kinds: new Set<string>(),
    };
    group.count++;
    if (event.forced) group.forced++;
    group.durMs += event.dur / 1000;
    group.kinds.add(event.kind);
    groups.set(event.at!, group);
  }
  let rows = [...groups.values()].sort(
    (left, right) =>
      right.forced - left.forced || right.durMs - left.durMs || right.count - left.count,
  );
  if (query.top != null) rows = rows.slice(0, query.top);

  const fmt = structuredFormat(query);
  if (fmt) {
    const entries: BlameEntry[] = rows.map((row) => ({
      at: row.at,
      count: row.count,
      forced: row.forced,
      durMs: row.durMs,
      kinds: [...row.kinds] as EventKind[],
    }));
    return emit(entries, fmt);
  }
  if (!rows.length) {
    console.log(
      query.forced
        ? "No forced (synchronous) layout/style — no layout thrashing. 🎉"
        : "No source-attributed events (Chrome captures stacks for layout/style/invalidation/scripting).",
    );
    return;
  }
  // `--all` shows the forced column so "ran but forced 0" lines are first-class.
  console.log(
    query.all
      ? table(
          ["events", "forced", "ms", "kinds", "source"],
          rows.map((row) => [
            row.count,
            row.forced,
            num(row.durMs, 3),
            [...row.kinds].join(","),
            row.at,
          ]),
        )
      : table(
          ["count", "ms", "kinds", "source"],
          rows.map((row) => [row.count, num(row.durMs, 3), [...row.kinds].join(","), row.at]),
        ),
  );
}
