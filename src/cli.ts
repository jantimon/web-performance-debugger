#!/usr/bin/env node
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { recordAndReport, type RecordOptions } from "./commands/record.js";
import { queryBlame, queryDigest, queryEvents, queryGet, queryIndex } from "./commands/query.js";
import { queryCpu, queryFrame } from "./commands/cpu.js";
import { assertCmd, type Thresholds } from "./commands/assert.js";
import { diffCmd } from "./commands/diff.js";
import { cpuDiffCmd } from "./commands/cpudiff.js";
import { setColorEnabled } from "./output/color.js";
import { VERSION, TOOL } from "./version.js";

/**
 * Puppeteer's protocol-timeout error tells the user to "increase the 'protocolTimeout' setting in
 * launch/connect calls" -- an API a CLI user never touches. Name the flag that actually fixes it.
 * A heavy traced interaction pinning the main thread is the usual cause.
 */
function recordFailureMessage(error: Error): string {
  const protocolTimedOut =
    error.name === "ProtocolTimeoutError" || /protocolTimeout/i.test(error.message);
  if (!protocolTimedOut) return error.message;
  return `${error.message}\n\nThe page did not answer CDP in time, usually because a traced interaction pinned the main thread. Retry with a higher --protocol-timeout (e.g. --protocol-timeout 600000), or measure less work per step.`;
}

const program = new Command();
program
  .name(TOOL)
  .description(
    "Drive Chrome (Puppeteer) to attribute layout/paint/invalidation work to source, with isolated timing.",
  )
  .version(VERSION)
  .option("--color <when>", "colorize human output: auto | always | never", "auto");

// Resolve color once before any command runs. Human tables/reports use it; structured
// (--json/--format) output never calls the color helpers, so it stays plain regardless.
// auto = on only for an interactive TTY with NO_COLOR unset (https://no-color.org).
program.hook("preAction", (thisCommand) => {
  const when = thisCommand.opts().color;
  if (!["auto", "always", "never"].includes(when))
    thisCommand.error("--color must be auto, always, or never");
  const on =
    when === "always"
      ? true
      : when === "never"
        ? false
        : process.stdout.isTTY === true && process.env.NO_COLOR == null;
  setColorEnabled(on);
});

/**
 * Rejects what parseInt would quietly accept. Bare `parseInt` turns `abc` into NaN and `1.5` into
 * 1, and every option below would then carry that forward silently: NaN passes every range check
 * (every comparison with NaN is false), so `--iterations abc` would reach a `for (i = 0; i < NaN)`
 * loop that never runs and record 0 layouts -- zeros indistinguishable from a clean page. Fail on
 * the argument instead, once, for every option that parses a whole number.
 */
const toInt = (value: string) => {
  if (!/^-?\d+$/.test(value.trim()))
    throw new InvalidArgumentError(`'${value}' is not a whole number.`);
  return parseInt(value, 10);
};

program
  .command("record")
  .description(
    "Drive a real page (default; run gets { page, ctx, measureStep }) or benchmark a module in-page (--bench), and record where rendering work comes from.",
  )
  .argument("<module>", "path to a JS/ESM module exporting `run` (and optional prepare/cleanup)")
  .option("--fn <name>", "exported function to run", "run")
  .option(
    "--target <name>",
    "where to run: chrome (default, full CDP) | firefox (WebDriver BiDi + Gecko profiler) | node (in-process, CPU only, no DOM)",
    "chrome",
  )
  .option("--html <file>", "host page: load this local HTML, then run the module against it")
  .option("--url <url>", "host page: load this live URL, then run the module against it")
  .option(
    "--bench",
    "benchmark mode: import the module inside the page and call run() (no args); repeat with --iterations",
  )
  .option(
    "--iterations <n>",
    "timed repetitions of run(); every step is re-measured, so each gets a median instead of one sample. Counts stay per-iteration. For a fresh page each time, page.goto() inside run() outside any measureStep",
    toInt,
    1,
  )
  .option("--warmup <n>", "untimed repetitions of run() before the timed ones", toInt, 0)
  .option("--out <file>", "output recording path (default recordings/<timestamp>.json)")
  .option("--no-headless", "run with a visible browser window")
  .option(
    "--user-data-dir <path>",
    "reuse a persistent Chrome profile (log in once; shared across passes/runs)",
  )
  .option("--screenshot <when>", "capture screenshots: before | after | both")
  .option("--no-isolate", "single pass (faster, but timing is polluted by instrumentation)")
  .option("--settle <ms>", "ms to wait after run for async paints to flush", toInt, 200)
  .option("--cpu-throttle <rate>", "artificial slowdown: CPU multiplier (4 = 4x slower)", toInt)
  .option("--network <preset>", "artificial slowdown: slow-3g | fast-3g | slow-4g | offline")
  .option(
    "--no-cpu-profile",
    "skip CPU sampling: keeps the timing pass pristine (the sampler perturbs wall by ~10%), at the cost of no .cpu model",
  )
  .option("--cpu-interval <us>", "CPU sampler interval in microseconds (default 200)", toInt)
  .option(
    "--protocol-timeout <ms>",
    "CDP protocol timeout in ms (default 180000); raise it when a heavy traced interaction pins the main thread",
    toInt,
  )
  .option(
    "--no-invalidation-tracking",
    "drop the invalidationTracking trace category (much lower overhead on invalidation-heavy pages; keeps paint + forced-reflow blame, loses the invalidation rollup)",
  )
  .option(
    "--no-trace",
    "skip the trace pass: counts from CDP + the CPU model only, no paint/forced/invalidation detail. Use when the trace pass hangs on a pathological interaction",
  )
  .option("--format <fmt>", "on-disk format: json | toon", "json")
  .action(async (module: string, cmdOpts: any) => {
    if (cmdOpts.screenshot && !["before", "after", "both"].includes(cmdOpts.screenshot)) {
      program.error("--screenshot must be one of: before, after, both");
    }
    if (!["json", "toon"].includes(cmdOpts.format)) program.error("--format must be json or toon");
    // One axis: chrome | firefox | node, so a conflicting browser/runtime combination is
    // unrepresentable rather than something to guard against.
    if (!["chrome", "firefox", "node"].includes(cmdOpts.target))
      program.error("--target must be chrome, firefox, or node");
    const bench = !!cmdOpts.bench;
    const node = cmdOpts.target === "node";
    const firefox = cmdOpts.target === "firefox";
    if (firefox) {
      // Firefox is driven over BiDi with no CDP: these features have no Gecko equivalent.
      const unsupported = [
        cmdOpts.cpuThrottle && "--cpu-throttle",
        cmdOpts.network && "--network",
        cmdOpts.protocolTimeout != null && "--protocol-timeout",
        cmdOpts.invalidationTracking === false && "--no-invalidation-tracking",
      ].filter(Boolean);
      if (unsupported.length) {
        program.error(
          `--target firefox has no CDP, so these are unsupported: ${unsupported.join(", ")}. See the target-support matrix in the README.`,
        );
      }
      // On firefox the profiler pass is the ONLY source of counts and blame, so opting out is not
      // the "slightly less data" it means on chrome: it leaves wall times and nothing else.
      if (cmdOpts.cpuProfile === false) {
        program.error(
          "--target firefox --no-cpu-profile would record timing only: on firefox the profiler pass is what yields layout/style counts and blame. Drop --no-cpu-profile.",
        );
      }
    }
    if (node) {
      const browserOnly = [
        cmdOpts.url && "--url",
        cmdOpts.html && "--html",
        cmdOpts.screenshot && "--screenshot",
        cmdOpts.network && "--network",
        cmdOpts.cpuThrottle && "--cpu-throttle",
        cmdOpts.userDataDir && "--user-data-dir",
      ].filter(Boolean);
      if (browserOnly.length)
        program.error(
          `--target node is CPU-only and has no browser: remove ${browserOnly.join(", ")}`,
        );
      // --bench selects in-page execution, not iteration, so it has no meaning without a page.
      // Rejected with its own message rather than folded into browserOnly above, whose "has no
      // browser" wording would imply --bench is about the browser rather than about *where run()
      // executes*.
      if (bench)
        program.error(
          "--bench imports the module inside a page; --target node has no page. Drop --bench (--iterations already repeats run() on this lane).",
        );
      if (cmdOpts.cpuProfile === false)
        program.error(
          "--target node is a CPU-profiling lane; --no-cpu-profile leaves it nothing to measure.",
        );
    }
    // toInt already rejected non-numbers, so these are range checks only. 0 iterations would run
    // the flow zero times and report a page's worth of zeros.
    if (cmdOpts.iterations < 1) program.error("--iterations must be at least 1");
    if (cmdOpts.warmup < 0) program.error("--warmup cannot be negative");
    const opts: RecordOptions = {
      module,
      fn: cmdOpts.fn,
      // RecordOptions keeps browser/runtime as separate internal axes because runPass and capsFor
      // are written against them. --target is the single user-facing axis that maps onto both.
      browser: firefox ? "firefox" : "chrome",
      html: cmdOpts.html,
      url: cmdOpts.url,
      iterations: cmdOpts.iterations,
      warmup: cmdOpts.warmup,
      out: cmdOpts.out,
      headless: cmdOpts.headless,
      userDataDir: cmdOpts.userDataDir ? path.resolve(cmdOpts.userDataDir) : undefined,
      screenshot: cmdOpts.screenshot,
      isolate: cmdOpts.isolate,
      settleMs: cmdOpts.settle,
      format: cmdOpts.format,
      driver: !bench && !node,
      runtime: node ? "node" : "chrome",
      cpuThrottle: cmdOpts.cpuThrottle,
      network: cmdOpts.network,
      // On by default on every target: the sampler rides the timing pass, so it costs no extra
      // pass, and on firefox it is what produces counts + blame at all. --no-cpu-profile opts out.
      cpuProfile: cmdOpts.cpuProfile !== false,
      cpuIntervalUs: cmdOpts.cpuInterval,
      protocolTimeoutMs: cmdOpts.protocolTimeout,
      trace: cmdOpts.trace,
      invalidationTracking: cmdOpts.invalidationTracking,
    };
    try {
      await recordAndReport(opts);
    } catch (err) {
      program.error(`record failed: ${recordFailureMessage(err as Error)}`);
    }
  });

const query = program
  .command("query")
  .description("Browse/search a recording (start with `digest`). Any <file> may be 'latest'.");
const fmtOpts = (command: Command) =>
  command
    .option("--json", "emit raw JSON")
    .option("--format <fmt>", "structured output: json | toon");
// Surface query errors (bad --kind, missing recording, unknown id) as a clean message
// and exit 1, not a raw unhandled-rejection stack trace.
const run = (promise: Promise<void>) =>
  promise.catch((error: Error) => program.error(error.message));

fmtOpts(
  query
    .command("digest <file>")
    .description("entry point: summary + thrashing + long tasks + slowest"),
).action((file, opts) => run(queryDigest(file, opts)));
fmtOpts(
  query.command("index <file>").description("stepped run: per-step headline numbers + file paths"),
).action((file, opts) => run(queryIndex(file, opts)));
fmtOpts(
  query
    .command("events <file>")
    .description("filter/sort the classified event log")
    .option(
      "--kind <kind>",
      "layout|style|paint|composite|invalidation|scripting|task|usertiming|other",
    )
    .option("--name <substr>", "case-insensitive name filter")
    .option("--forced", "only forced (synchronous) layout/style")
    .option("--top <n>", "limit to first n", toInt)
    .option("--sort <by>", "dur|ts (default dur)", "dur"),
).action((file, opts) => run(queryEvents(file, opts)));
fmtOpts(
  query
    .command("blame <file>")
    .description("aggregate source-attributed events by location (file may be 'latest')")
    .option("--kind <kind>", "restrict to one event kind")
    .option("--forced", "only forced (synchronous) layout/style — layout thrashing")
    .option("--all", "every attributed line with a 'forced' column (shows ran-but-forced-0)")
    .option("--top <n>", "limit to first n locations", toInt),
).action((file, opts) => run(queryBlame(file, opts)));
query
  .command("get <file> <id>")
  .description("fetch one event (full stack + args) by id")
  .option("--format <fmt>", "structured output: json | toon")
  .action((file, id, opts) => run(queryGet(file, parseInt(id, 10), opts)));
fmtOpts(
  query
    .command("cpu <file>")
    .description("CPU profile overview: hot functions + by-package self time")
    .option("--by <grouping>", "rollup grouping: package | file | function", "package")
    .option("--top <n>", "hot functions to show", toInt),
).action((file, opts) => run(queryCpu(file, opts)));
fmtOpts(
  query
    .command("frame <file> <id>")
    .description("drill one CPU function by id: its callers and callees"),
).action((file, id, opts) => run(queryFrame(file, parseInt(id, 10), opts)));

program
  .command("assert <file>")
  .description("gate a recording or step-index against thresholds (exit 1 on violation)")
  .option("--max-forced <n>", "max forced layout/style", toInt)
  .option("--max-layouts <n>", "max layout count", toInt)
  .option("--max-paints <n>", "max paint count", toInt)
  .option("--max-layout-invalidations <n>", "max layout invalidations", toInt)
  .option("--max-style-invalidations <n>", "max style/selector invalidations", toInt)
  .option("--max-long-tasks <n>", "max tasks >=50ms", toInt)
  .option("--max-inp <ms>", "max INP (worst interaction) ms", toInt)
  .option("--max-wall <ms>", "max wall ms", toInt)
  .action((file, opts) => {
    const thresholds: Thresholds = {
      forced: opts.maxForced,
      layouts: opts.maxLayouts,
      paints: opts.maxPaints,
      layoutInvalidations: opts.maxLayoutInvalidations,
      styleInvalidations: opts.maxStyleInvalidations,
      longTasks: opts.maxLongTasks,
      inp: opts.maxInp,
      wall: opts.maxWall,
    };
    return assertCmd(file, thresholds).catch((error) => program.error(error.message));
  });

program
  .command("diff <baseline> <current>")
  .description("compare two recordings field-by-field (counts/INP/wall)")
  .option("--fail-on-regression", "exit 1 if any count/INP increased")
  .action((baseline, current, opts) =>
    diffCmd(baseline, current, { failOnRegression: !!opts.failOnRegression }),
  );

program
  .command("cpu-diff <baseline> <current>")
  .description("compare two CPU models: per-package + per-function self-time deltas")
  .option("--fail-on-regression", "exit 1 if net scripting time increased")
  .option("--json", "emit raw JSON")
  .option("--format <fmt>", "structured output: json | toon")
  .action((baseline, current, opts) =>
    cpuDiffCmd(baseline, current, {
      failOnRegression: !!opts.failOnRegression,
      json: opts.json,
      format: opts.format,
    }).catch((error) => program.error(error.message)),
  );

program.parseAsync(process.argv);
