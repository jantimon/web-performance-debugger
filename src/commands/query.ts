import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BlameSemantic,
  EventKind,
  NormalizedEvent,
  Recording,
  StepIndex,
} from "../model/recording.js";
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
  // `latest` resolves to the index via the pointer, but an explicit path is taken as given, so
  // `query index <recording>` used to read a Recording as a StepIndex and die on
  // `Cannot read properties of undefined (reading 'length')`, naming neither the file nor the fix.
  if (!Array.isArray(idx.steps)) {
    throw new Error(
      `${abs} has no steps: this is a recording, not a step index. A stepped (driver) run writes ` +
        `its index beside the recording as <name>.index.json -- pass that file, or 'latest'. ` +
        `A --bench or --target node run has no steps at all.`,
    );
  }
  const fmt = structuredFormat(opts);
  if (fmt) return emit(idx, fmt);

  console.log(`Stepped run — ${idx.steps.length} step(s). Full recording: ${idx.recording}`);
  if (idx.meta.throttle) {
    const throttle = idx.meta.throttle;
    console.log(
      `slowdown: ${[throttle.cpuRate ? `cpu ${throttle.cpuRate}x` : null, throttle.network].filter(Boolean).join(", ")}`,
    );
  }
  // `inp` and `handler` come first because they describe the PAGE. `wall` is last and labelled as
  // a bound: it is measured node-side around the action plus its settle, so it carries the driver's
  // own cost (measured: ~31ms of settle floor, and page.click alone ~20ms) and can differ by 8ms
  // between two ways of driving identical work. Leading with it invited reading tool overhead as
  // the page's cost. See docs/dev/driver-timing.md.
  console.log(
    table(
      [
        "#",
        "label",
        "inp ms",
        "processing ms",
        "layout",
        "forced",
        "paint",
        "layoutInval",
        "longTasks",
        "wall ms*",
        "file",
      ],
      idx.steps.map((step) => [
        step.index,
        step.label,
        step.inpMs == null ? "—" : num(step.inpMs, 1),
        step.interaction == null ? "—" : num(step.interaction.processingMs, 2),
        step.headline.layoutCount,
        step.headline.forcedLayoutCount,
        step.headline.paintCount,
        step.headline.layoutInvalidations,
        step.headline.longTaskCount,
        num(step.wallMs ?? 0, 1),
        path.basename(step.recording),
      ]),
    ),
  );
  console.log(
    "\n* wall includes the driver's own overhead (dispatching the action, then waiting for the page " +
      "to settle); it bounds the step\n  rather than pricing it. inp/processing are measured in-page. " +
      "'processing ms' is first handler start to last handler end,\n  so it also covers any gap " +
      "between the events of one interaction. A '—' means no interaction crossed the 16 ms " +
      "Event Timing floor.",
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
        : `No source-attributed events (${whatCapturesStacks(rec.meta.blameSemantic)}).`,
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
  // Only the forced rows have an engine-specific meaning worth naming, so the note is gated on
  // one being present rather than on the --forced flag: plain `blame` and `--all` show forced and
  // unforced rows together, and an unforced scripting/invalidation row is not a geometry read at
  // all. Saying so over such a table would print the exact read/write confusion the semantic
  // exists to prevent (Chrome's invalidation stacks name the WRITE: docs/dev/engine-mapping.md).
  if (rows.some((row) => row.forced > 0)) {
    const semantic = blameSemanticLine(rec.meta.blameSemantic);
    if (semantic) console.log(`\n${semantic}`);
  }
}

/**
 * Which engine attributed this recording's events, for the "nothing to show" message. Naming
 * Chrome unconditionally was wrong on a Firefox recording, and pointed the reader at a stack
 * source that lane does not have. Absent semantic => no blame pass ran at all.
 */
function whatCapturesStacks(semantic: BlameSemantic | undefined): string {
  if (semantic === "invalidation-site")
    return "Firefox captures cause stacks for layout/style via the Gecko profiler";
  if (semantic === "flush-site")
    return "Chrome captures stacks for layout/style/invalidation/scripting";
  return "this run recorded no blame pass: --no-trace and --target node collect none";
}

/**
 * One line saying what the `source` column of the FORCED rows points at. Without it the table
 * invites the one comparison it cannot support: the same probe blamed in both engines shares zero
 * lines, because each engine answers a different question (see BlameSemantic). Human output only --
 * structured consumers read `meta.blameSemantic` off the recording or digest, which is durable and
 * does not depend on having run this verb.
 */
function blameSemanticLine(semantic: BlameSemantic | undefined): string | null {
  if (semantic === "flush-site")
    return (
      "forced rows: source = the geometry read that forced the flush (Chrome). Firefox blames the " +
      "write that dirtied the DOM instead, so these lines are not comparable across engines."
    );
  if (semantic === "invalidation-site")
    return (
      "forced rows: source = the write that dirtied the DOM (Firefox), not the read that forced " +
      "the flush. Chrome blames the read instead, so these lines are not comparable across engines."
    );
  return null;
}
