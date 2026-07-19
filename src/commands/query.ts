import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BlameSemantic,
  CpuBreakdown,
  CpuModel,
  EventKind,
  NormalizedEvent,
  Recording,
} from "../model/recording.js";
import type { BlameEntry } from "../model/query.js";
import { buildSpans, recordingLane } from "../model/spans.js";
import { isFirefoxDeep, isGeckoRung } from "../model/rung.js";
import { isSteppedRecording, stepIndexView } from "../model/step-view.js";
import { num, table } from "../output/ascii.js";
import { dim } from "../output/color.js";
import { analyzeThrash } from "../trace/thrash.js";
import { firefoxDirtiedBy } from "../trace/firefox-dirtied.js";
import { deserialize, serialize, isFormat, type Format } from "../output/format.js";
import { assertRecordingArtifact } from "../model/artifact.js";
import { buildDigest } from "./digest.js";
import { printSpanBreakdowns, printCpuBreakdown } from "./cpu.js";
import { loadCpuModel } from "../profile/cpuprofile.js";
import { printSummary } from "./summaryView.js";
import { resolveTarget } from "./resolve.js";
import { formatMeasured } from "../model/measured.js";
import { usToMs } from "../model/time.js";
import { EVENT_KINDS, isEventKind } from "../trace/classify.js";

interface OutOpts {
  json?: boolean;
  format?: string;
}

async function load(file: string): Promise<Recording> {
  const abs = await resolveTarget(file, "recording");
  const raw = await fs.readFile(abs, "utf8");
  const rec = deserialize(raw, path.extname(abs).toLowerCase()) as Recording;
  assertRecordingArtifact(rec, abs);
  return rec;
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

/**
 * The deep event log (`rec.events`) is stored only where a reader consumes it: --deep (chrome) and
 * firefox. On every other rung it is empty by design, so `query events`/`get`/`blame` say "not
 * captured at this rung" rather than reporting an empty result as if the page did nothing. A --deep
 * run that genuinely observed nothing still has the log (it just came back empty), so the rung, not
 * the array length, is the test.
 */
function requireEventLog(rec: Recording, file: string): void {
  if (rec.meta.passes.includes("deep") || isGeckoRung(rec.meta.passes)) return;
  throw new Error(
    `${file}: the event log was not captured at this rung (${rec.meta.passes.join("+")}). Events, ` +
      `forced-layout blame, and invalidation records are stored only under --deep (chrome) or ` +
      `--target firefox. Re-record with --deep.`,
  );
}

export async function queryDigest(file: string, opts: OutOpts): Promise<void> {
  const abs = await resolveTarget(file, "recording");
  const rec = await load(abs);
  const digest = buildDigest(rec, abs, 20);
  const fmt = structuredFormat(opts);
  if (fmt) return emit(digest, fmt);

  printSummary(rec);
  // Spans carrying a reconciling bar (--breakdown / firefox measures) print here so `query digest`
  // matches the `record` report; a no-op when no span has a bar.
  printSpanBreakdowns(digest.spans, digest.meta.iterations);
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
  if (digest.firefoxDirtiedBy) {
    console.log(
      "\ndirtied-by (first invalidation only) — the write Gecko blames for each forced flush:",
    );
    console.log(
      dim(
        "  forced-by: n/a (firefox --deep); Gecko records only the FIRST invalidation since the last " +
          "flush, so this is not Chrome's full write set. Read side: query blame --forced.",
      ),
    );
    console.log(
      table(
        ["count", "kinds", "write"],
        digest.firefoxDirtiedBy.writes
          .slice(0, 8)
          .map((write) => [write.count, write.kinds.join(","), write.at]),
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

export interface SpansQuery extends OutOpts {
  /** exact span label to keep (case-sensitive, like a performance.measure name) */
  label?: string;
}

/**
 * `query spans`: ONE unified per-span breakdown across chrome/firefox/node -- the run window, each
 * driver step, and every user `performance.measure`, each in the same slice shape. Sources the
 * recording's stored per-span bars when present, else synthesizes the `run` span from
 * `CpuModel.breakdown`, so a recording carrying any bar is never empty. `--label` filters by exact
 * label.
 */
export async function querySpans(file: string, query: SpansQuery): Promise<void> {
  const abs = await resolveTarget(file, "recording");
  const rec = await load(abs);
  // Prefer the recording's spans that carry a bar; reach for the sibling CPU model only when none do
  // (firefox/node without measures, or a rung-1 chrome run), where the run bar lives on
  // CpuModel.breakdown instead of on the stored spans.
  const hasBar = rec.spans?.some((span) => span.breakdown);
  let model: CpuModel | undefined;
  let cpuBreakdown: CpuBreakdown | undefined;
  if (!hasBar) {
    try {
      model = await loadCpuModel(abs);
      cpuBreakdown = model.breakdown;
    } catch {
      // No sibling CPU model: buildSpans returns null below and we report the empty case.
    }
  }
  const iterations = rec.meta.iterations ?? 1;
  const result = buildSpans(rec.spans, cpuBreakdown, recordingLane(rec.meta), iterations);
  if (!result)
    throw new Error(
      `${file} carries no per-span breakdown. Record with \`--breakdown\` (chrome), \`--target ` +
        `firefox\`, or \`--target node\` to produce span bars; the default/--deep/--precise-wall ` +
        `rungs and older recordings have none.`,
    );

  const label = query.label;
  const spans = label ? result.spans.filter((span) => span.label === label) : result.spans;

  const fmt = structuredFormat(query);
  if (fmt) return emit({ ...result, spans }, fmt);

  // Human output reuses the existing bar renderers. The stored-bars path prints the seven-slice
  // per-span table; the synthesized run bar prints the CpuModel bar, which already labels
  // style/layout and browser/native honestly for its lane.
  if (result.source === "breakdowns") {
    const barSpans = rec.spans.filter((span) => span.breakdown);
    const bars = label ? barSpans.filter((span) => span.label === label) : barSpans;
    if (!bars.length) return void console.log(`No span labelled '${label}' in ${file}.`);
    printSpanBreakdowns(bars, iterations);
    return;
  }
  if (label && label !== "run")
    return void console.log(
      `No span labelled '${label}' in ${file} (this lane carries only the 'run' bar).`,
    );
  printCpuBreakdown(model!, iterations);
}

export async function queryIndex(file: string, opts: OutOpts): Promise<void> {
  const abs = await resolveTarget(file, "index");
  const rec = await load(abs);
  // The step index is a VIEW over the recording's step spans now, not a stored file. A run with no
  // step spans (a --bench or --target node run) is not stepped: say so, and name the fix.
  if (!isSteppedRecording(rec)) {
    throw new Error(
      `${abs} is not a stepped run: it has no step spans. Only a driver run (measureStep) has ` +
        `steps; a --bench or --target node run has none. Use \`query digest\`/\`query spans\` instead.`,
    );
  }
  const idx = stepIndexView(rec, abs);
  const fmt = structuredFormat(opts);
  if (fmt) return emit(idx, fmt);

  console.log(`Stepped run — ${idx.steps.length} step(s). Full recording: ${idx.recording}`);
  if (idx.meta.throttle?.cpuRate) {
    console.log(`slowdown: cpu ${idx.meta.throttle.cpuRate}x`);
  }
  // `inp` and `handler` come first because they describe the PAGE. `wall` is last and labelled with
  // a `*`: it is the page's own window between the step marks (the trace clock under --breakdown/--deep,
  // else the page's performance.now), not the node-side page.click bound (~20ms of which is input
  // dispatch in the tool process, in no renderer timeline). It still spans the settle the step waits
  // for (~31ms floor new-headless), so it bounds the interaction's window rather than pricing the JS.
  // A '—' means the wall was not measured (a step that navigated on a no-trace rung). See docs/dev/driver-timing.md.
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
      ],
      idx.steps.map((step) => [
        step.index,
        step.label,
        step.inpMs == null ? "—" : num(step.inpMs, 1),
        step.interaction == null ? "—" : num(step.interaction.processingMs, 2),
        // null = not measured (the default rung captures no counts, a --breakdown step drops
        // forced); show a placeholder, never a fake 0.
        formatMeasured(step.headline.layoutCount, (count) => String(count)),
        formatMeasured(step.headline.forcedLayoutCount, (count) => String(count)),
        formatMeasured(step.headline.paintCount, (count) => String(count)),
        formatMeasured(step.headline.layoutInvalidations, (count) => String(count)),
        formatMeasured(step.headline.longTaskCount, (count) => String(count)),
        step.wallMs == null ? "—" : num(step.wallMs, 1),
      ]),
    ),
  );
  console.log(
    "\n* wall is the page's own window between the step marks (trace clock under --breakdown/--deep, " +
      "else the page's performance.now),\n  not the node-side page.click bound. It still spans the " +
      "step's settle (~31ms floor new-headless), so it bounds the interaction rather than pricing the " +
      "JS.\n  inp/processing are measured in-page; 'processing ms' is first handler start to last " +
      "handler end. A '—' in inp/processing means no interaction crossed the 16 ms Event Timing floor.",
  );
  console.log(`\nInspect a step's bar:  wpd query spans "${idx.recording}" --label <label>`);
}

export async function queryGet(file: string, id: number, opts: OutOpts): Promise<void> {
  const rec = await load(file);
  requireEventLog(rec, file);
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
  requireEventLog(rec, file);
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
        num(usToMs(event.dur), 3),
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
  /** firefox --deep only: the dirtied-by write report, separate from the read-site rows */
  dirtied?: boolean;
  top?: number;
}

export async function queryBlame(file: string, query: BlameQuery): Promise<void> {
  if (query.kind && !isEventKind(query.kind))
    throw new Error(`Unknown --kind '${query.kind}'. Valid kinds: ${EVENT_KINDS.join(", ")}`);
  const rec = await load(file);
  requireEventLog(rec, file);

  // --dirtied: the firefox --deep write report ALONE (Gecko cause stacks, first-invalidation-only).
  // Kept a distinct mode so the write side never merges into the --forced read-site rows, and so its
  // JSON carries the `semantic: "first-invalidation"` marker a consumer needs to not read it as
  // chrome's exact write set. Refused off this lane, naming where the write identity actually lives.
  if (query.dirtied) return void queryDirtied(rec, file, query);

  let events = eventsInWindow(rec).filter((event) => event.at);
  // --forced narrows to thrashing; --all keeps everything (and reports forced=0 lines)
  if (query.forced && !query.all) events = events.filter((event) => event.forced);
  if (query.kind) events = events.filter((event) => event.kind === query.kind);

  const groups = new Map<
    string,
    {
      at: string;
      count: number;
      forced: number;
      durMs: number;
      kinds: Set<string>;
      properties: Set<string>;
    }
  >();
  for (const event of events) {
    const group = groups.get(event.at!) ?? {
      at: event.at!,
      count: 0,
      forced: 0,
      durMs: 0,
      kinds: new Set<string>(),
      properties: new Set<string>(),
    };
    group.count++;
    if (event.forced) group.forced++;
    group.durMs += usToMs(event.dur);
    group.kinds.add(event.kind);
    // The forcing DOM property (Firefox read-site blame), stashed on the sampled event's args.
    const property = (event.args as { data?: { property?: string } } | undefined)?.data?.property;
    if (typeof property === "string") group.properties.add(property);
    groups.set(event.at!, group);
  }
  let rows = [...groups.values()].sort(
    (left, right) =>
      right.forced - left.forced || right.durMs - left.durMs || right.count - left.count,
  );
  if (query.top != null) rows = rows.slice(0, query.top);

  // dirtied-by: the WRITE that dirtied each forced read-site, from the invalidation records only
  // a --deep trace carries. Absent on every other lane (empty map), so the read stays the headline
  // and no second line prints there.
  // Pass the full event log: the enclosing RunTask can begin just before the run:start mark, and the
  // interleave walk needs it. analyzeThrash windows internally to the in-window flushes.
  const dirtiedByReadSite = rec.meta.passes.includes("deep")
    ? analyzeThrash(rec.events, rec.window.startTs).dirtiedByReadSite
    : {};

  const fmt = structuredFormat(query);
  if (fmt) {
    const entries: BlameEntry[] = rows.map((row) => ({
      at: row.at,
      count: row.count,
      forced: row.forced,
      durMs: row.durMs,
      kinds: [...row.kinds] as EventKind[],
      properties: row.properties.size ? [...row.properties] : undefined,
      dirtiedBy: dirtiedByReadSite[row.at]?.length ? dirtiedByReadSite[row.at] : undefined,
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
  // The source cell carries the forcing DOM property when the lane names it (Firefox read-site).
  const sourceCell = (row: { at: string; properties: Set<string> }): string =>
    row.properties.size ? `${row.at} (${[...row.properties].join(", ")})` : row.at;
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
            sourceCell(row),
          ]),
        )
      : table(
          ["count", "ms", "kinds", "source"],
          rows.map((row) => [
            row.count,
            num(row.durMs, 3),
            [...row.kinds].join(","),
            sourceCell(row),
          ]),
        ),
  );
  // dual annotation: under each forced read-site, the WRITE that dirtied it (Chrome --deep). The
  // read stays the headline (the table above); dirtied-by is the second line, so a reader sees both
  // "who paid" (the read) and "who caused" (the write). Only rows with a resolved write print.
  const dirtiedRows = rows.filter((row) => dirtiedByReadSite[row.at]?.length);
  if (dirtiedRows.length) {
    console.log("\ndirtied-by (the write that forced each read):");
    for (const row of dirtiedRows) {
      console.log(`  ${row.at}`);
      for (const write of dirtiedByReadSite[row.at])
        console.log(
          `    ${dim("↳ dirtied by")} ${write.at}${write.reason ? dim(` (${write.reason})`) : ""}`,
        );
    }
  }
  // Firefox --deep: the dirtied-by WRITE section, appended AFTER the read-site table so a reader sees
  // both without the two ever merging into one row. It is Gecko's cause-stack write identity,
  // first-invalidation-only -- a distinct concept from the read rows above (whose `at` is the read
  // that paid). The full JSON write report is `query blame --dirtied`.
  if (isFirefoxDeep(rec.meta.passes)) {
    const report = firefoxDirtiedBy(eventsInWindow(rec), rec.window.startTs);
    if (report) {
      console.log(
        "\ndirtied-by (first invalidation only) — the write Gecko blames for each flush:",
      );
      console.log(
        dim(
          "  forced-by: n/a (firefox --deep); not Chrome's full write set. Full report: query blame --dirtied",
        ),
      );
      for (const write of report.writes)
        console.log(`    ${write.at}  ${dim(`(${write.kinds.join(",")} ×${write.count})`)}`);
    }
  }
  // Only the forced rows have an engine-specific meaning worth naming, so the note is gated on
  // one being present rather than on the --forced flag: plain `blame` and `--all` show forced and
  // unforced rows together, and an unforced scripting/invalidation row is not a geometry read at
  // all. Saying so over such a table would print the exact read/write confusion the semantic
  // exists to prevent (Chrome's invalidation stacks name the WRITE: docs/dev/engine-mapping.md).
  if (rows.some((row) => row.forced > 0)) {
    const semantic = blameSemanticLine(rec.meta.blameSemantic, rec.meta.browser);
    if (semantic) console.log(`\n${semantic}`);
  }
}

/**
 * `query blame --dirtied`: the firefox --deep dirtied-by write report alone. Refused off the firefox
 * --deep lane -- the write identity comes from Gecko's cause stacks, so there is nothing to show
 * elsewhere (chrome's write set is `query blame` dirtied-by rows + `query digest` thrash instead).
 */
async function queryDirtied(rec: Recording, file: string, query: BlameQuery): Promise<void> {
  if (query.forced)
    throw new Error(
      "--forced (read-site rows) and --dirtied (the write report) are separate answers; pass one.",
    );
  if (!isFirefoxDeep(rec.meta.passes))
    throw new Error(
      `${file}: --dirtied is the firefox --deep write report (Gecko cause stacks, first-invalidation-only). ` +
        `This recording is not one (passes: ${rec.meta.passes.join("+")}). On firefox, re-record with ` +
        `--deep; on chrome, the write side is the dirtied-by rows under \`query blame\` and the thrash ` +
        `rollup in \`query digest\`.`,
    );
  const report = firefoxDirtiedBy(eventsInWindow(rec), rec.window.startTs);
  const fmt = structuredFormat(query);
  if (fmt) return emit(report ?? { semantic: "first-invalidation", writes: [] }, fmt);
  if (!report) {
    console.log("No JS-forced flush named a write (no cause stack resolved). 🎉");
    return;
  }
  console.log(
    "dirtied-by (first invalidation only) — the write Gecko blames for each forced flush.",
  );
  console.log(
    dim(
      "forced-by: n/a (firefox --deep). Gecko records only the FIRST invalidation since the last flush, so\n" +
        "this is not Chrome's full write set. The read that forced each flush is the sampled read-site\n" +
        "blame: query blame --forced.",
    ),
  );
  console.log(
    table(
      ["count", "kinds", "write"],
      report.writes.map((write) => [write.count, write.kinds.join(","), write.at]),
    ),
  );
}

/**
 * Which engine attributed this recording's events, for the "nothing to show" message. Naming
 * Chrome unconditionally would be wrong on a Firefox recording, pointing the reader at a stack
 * source that lane does not have. Absent semantic => no blame pass ran at all.
 */
function whatCapturesStacks(semantic: BlameSemantic | undefined): string {
  if (semantic === "invalidation-site")
    return "Firefox captures cause stacks for layout/style via the Gecko profiler";
  if (semantic === "flush-site")
    return "the run captures the geometry read that forced the flush (Chrome via the trace's `.stack`, Firefox via the sampled DOM-accessor stacks)";
  return "this run captured no blame: the default and --precise-wall rungs run no trace, and --target node has no DOM; record with --deep (chrome) or --target firefox";
}

/**
 * One line saying what the `source` column of the FORCED rows points at. Without it the table
 * invites the one comparison it cannot support: the same probe blamed in both engines shares zero
 * lines, because each engine answers a different question (see BlameSemantic). Human output only --
 * structured consumers read `meta.blameSemantic` off the recording or digest, which is durable and
 * does not depend on having run this verb.
 */
function blameSemanticLine(
  semantic: BlameSemantic | undefined,
  browser: "chrome" | "firefox" | undefined,
): string | null {
  if (semantic === "flush-site")
    return browser === "firefox"
      ? "forced rows: source = the geometry read that forced the flush, named from the sampled " +
          "DOM-accessor stacks (with the property). Same read-site semantic as Chrome; it is a " +
          "sampled estimate, so cheap reads can be missed and the line can lag one statement."
      : "forced rows: source = the geometry read that forced the flush. Firefox now names the same " +
          "read site (sampled), so the two engines' forced lines are comparable at line granularity.";
  if (semantic === "invalidation-site")
    return (
      "forced rows: source = the write that dirtied the DOM (older Firefox recording), not the read " +
      "that forced the flush. Newer runs and Chrome name the read instead."
    );
  return null;
}
