#!/usr/bin/env node
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { recordAndReport, type RecordOptions } from "./commands/record.js";
import { resolvePageOption } from "./record/page-option.js";
import { queryBlame, queryEvents, queryGet, querySpan, querySpans } from "./commands/query.js";
import { queryCpu, queryFrame } from "./commands/cpu.js";
import { assertCmd, type Thresholds } from "./commands/assert.js";
import { diffCmd } from "./commands/diff.js";
import { parseSliceBudgets, SLICE_NAMES, type SliceBudgets } from "./model/spans.js";
import { cpuDiffCmd } from "./commands/cpudiff.js";
import { setColorEnabled } from "./output/color.js";
import { VERSION, TOOL } from "./version.js";

/**
 * Puppeteer's protocol-timeout error tells the user to "increase the 'protocolTimeout' setting in
 * launch/connect calls" -- an API a CLI user never touches. Name the flag that actually fixes it.
 *
 * Two causes, and the advice differs: a heavy traced interaction pinned the main thread, or the
 * browser never finished its startup handshake (`session.new`, Firefox/BiDi), where there is no
 * step to make smaller.
 */
function recordFailureMessage(error: Error): string {
  const protocolTimedOut =
    error.name === "ProtocolTimeoutError" || /protocolTimeout/i.test(error.message);
  if (!protocolTimedOut) return error.message;
  // `session.new` is the BiDi handshake: this fired before the browser was usable, so advice about
  // measuring less work per step would point at a step that never ran.
  if (/session\.new/i.test(error.message))
    return `${error.message}\n\nThe browser did not finish its startup handshake in time. This is usually load, not your flow: retry, or raise --protocol-timeout (e.g. --protocol-timeout 600000).`;
  return `${error.message}\n\nThe page did not answer in time, usually because a traced interaction pinned the main thread. Retry with a higher --protocol-timeout (e.g. --protocol-timeout 600000), or measure less work per step.`;
}

const program = new Command();
program
  .name(TOOL)
  .description(
    "Drive Chrome (Puppeteer) to attribute layout/paint/invalidation work to source, one capture rung per run.",
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
  // Both modes have a real page and a live DOM; they differ in WHERE run() executes, and therefore
  // in what times it. Name both signatures: "no args" or an unqualified "real page" on one of them
  // reads as "--bench has no page", and from there as "it cannot touch the DOM".
  .description(
    "Record where rendering work comes from. Default: run({ page, ctx, measureStep }) executes in Node and drives the page via Puppeteer. --bench: run(ctx) executes inside the page itself, with live document/window and no page handle, timed in-page.",
  )
  // Optional: with no module, wpd runs a built-in load flow (navigate to --url and settle), so a
  // first run needs zero authoring. A module continues to work exactly as before.
  .argument(
    "[module]",
    "path to a JS/ESM module exporting `run` (and optional prepare/cleanup). Omit it with --url to run the built-in load flow",
  )
  .option(
    "--target <name>",
    "where to run: chrome (default) | firefox (WebDriver BiDi + Gecko profiler) | node (in-process, CPU only, no DOM)",
    "chrome",
  )
  .option(
    "--url <url-or-file>",
    "the host page: a live URL (http://localhost:5173) or a local HTML file path. Run the module against it, or run it alone (no module) as the built-in load flow",
  )
  // --html is the pre-unification spelling, kept as a hidden alias that resolves onto the same host
  // page as --url. Zero behavior change for existing invocations; absent from --help.
  .addOption(
    new Option("--html <file>", "host page: a local HTML file (alias of --url)").hideHelp(),
  )
  .option(
    "--bench",
    "run(ctx) executes inside the page with live document/window (no page handle), timed in-page, so its wall excludes the driver's dispatch and settle. Pair with --url for a host page; repeat with --iterations",
  )
  .option(
    "--iterations <n>",
    "timed repetitions of run(); every step is re-measured, so each gets a median instead of one sample. For a fresh page each time, page.goto() inside run() outside any measureStep",
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
  .option(
    "--disable-browser-sandbox",
    "chrome only: launch with --no-sandbox for environments that cannot start Chrome's sandbox (containers, restricted CI). WARNING: reduces process containment; only use in a trusted, isolated environment and not with --user-data-dir or a non-loopback --url",
  )
  .option("--cpu-throttle <rate>", "artificial slowdown: CPU multiplier (4 = 4x slower)", toInt)
  .option(
    "--protocol-timeout <ms>",
    "timeout in ms for one protocol call (default 180000); raise it when a heavy traced interaction pins the main thread, or when a loaded machine makes Firefox time out launching",
    toInt,
  )
  // The chrome capture ladder. Default (no flag) is rung 1: CPU sampler only, no trace, cleanest
  // wall -- the four-slice CPU bar, no rendering counts. --breakdown and --deep are the higher rungs;
  // --precise-wall is rung 1 minus the sampler. Every invocation is exactly ONE pass.
  .option(
    "--breakdown",
    "chrome rung 2: ONE fused pass (light trace + CPU sampler) yields a reconciling js/style/layout/paint/gc/other/idle bar per span, plus exact layout/style/paint counts. Cannot report forced-layout counts or blame (they need the `.stack` category, which --deep captures)",
  )
  .option(
    "--deep",
    "rung 3 attribution report. Chrome: ONE full-trace pass (.stack + invalidationTracking), sampler OFF -- exact forced-layout blame, dirtied-by writes, invalidation rollup, exact counts, long tasks; slice durations suppressed (the trace distorts them), no CPU model. Firefox: the SAME gecko pass, adding a dirtied-by (first-invalidation-only) write report from Gecko's cause stacks (no exact-count parity, no forced-by, no thrash detector)",
  )
  .option(
    "--precise-wall",
    "rung 1 minus the CPU sampler: a pristine benchmark wall (the ~1% the sampler costs). No CPU model and no rendering counts",
  )
  .option(
    "--headless-mode <mode>",
    "chrome headless flavour: shell (default, chrome-headless-shell, ~120Hz frames) | new (full Chrome, ~60Hz frames). See docs/dev/frame-floor.md",
  )
  .option("--format <fmt>", "on-disk format: json | toon", "json")
  .action(async (module: string | undefined, cmdOpts: any) => {
    if (!["json", "toon"].includes(cmdOpts.format)) program.error("--format must be json or toon");
    // One axis: chrome | firefox | node, so a conflicting browser/runtime combination is
    // unrepresentable rather than something to guard against.
    if (!["chrome", "firefox", "node"].includes(cmdOpts.target))
      program.error("--target must be chrome, firefox, or node");
    const bench = !!cmdOpts.bench;
    const node = cmdOpts.target === "node";
    const firefox = cmdOpts.target === "firefox";
    // --url is the one documented way to name the host page, and it accepts a live URL OR a local
    // HTML file path; --html is a hidden alias that resolves onto the same host page. Whichever is
    // given feeds the same detection (URL vs file), so exactly one may be present. node has no page,
    // so its own guard (below) rejects either flag with a lane-specific message; skip the detection
    // there so a bad value does not preempt it.
    let urlSchemeAssumed = false;
    if (cmdOpts.url != null && cmdOpts.html != null)
      program.error("--url and --html name the same host page two ways: pass just one.");
    const rawHostPage = cmdOpts.url ?? cmdOpts.html;
    if (rawHostPage != null && !node) {
      try {
        const resolved = resolvePageOption(rawHostPage);
        if (resolved.kind === "url") {
          cmdOpts.url = resolved.url;
          cmdOpts.html = undefined;
          urlSchemeAssumed = resolved.schemeAssumed;
        } else {
          cmdOpts.html = resolved.html;
          cmdOpts.url = undefined;
        }
      } catch (error) {
        program.error((error as Error).message);
      }
    }
    // Zero-authoring on-ramp: no module runs the built-in driver flow (navigate to --url and
    // settle). It needs a page to load and a driver to load it, so --bench (imports run() in-page)
    // and --target node (no page) have nothing to run, and a bare `record` has no target at all.
    if (!module) {
      if (node)
        program.error(
          "record --target node needs a module: it imports and profiles run() in this process, and the built-in flow (which loads a page) has no page here. Pass a module path.",
        );
      if (bench)
        program.error(
          "record --bench needs a module: it import()s run() inside the page. Pass a module path, or drop --bench to run the built-in load flow against --url.",
        );
      if (!cmdOpts.url && !cmdOpts.html)
        program.error(
          "record needs a module path, or --url to run the built-in load flow. Try: wpd record --url https://example.com",
        );
      if (cmdOpts.preciseWall)
        program.error(
          "record --precise-wall needs a module: the built-in load flow's only step is a navigation, whose wall the page clock cannot price on a no-trace rung (nothing would be measured). Drop --precise-wall, or pass a module.",
        );
    }
    // undefined = flag not passed; the flavour then defaults to shell in launchBrowser. The two
    // guards below fire only on an EXPLICIT --headless-mode, so plain --no-headless stays headed
    // and a firefox/node run is not rejected for a default it never asked for.
    if (cmdOpts.headlessMode !== undefined && !["new", "shell"].includes(cmdOpts.headlessMode))
      program.error("--headless-mode must be new or shell");
    // --headless-mode is a Chrome CDP-launch flavour; Firefox and node have no equivalent, so any
    // explicit value (shell or new) is rejected there.
    if (cmdOpts.headlessMode !== undefined && (firefox || node))
      program.error(`--headless-mode is chrome-only (target is ${cmdOpts.target})`);
    // chrome-headless-shell is a headless binary; there is no headed shell to launch. Only an
    // explicit --headless-mode shell conflicts with --no-headless; the shell default does not.
    if (cmdOpts.headlessMode === "shell" && cmdOpts.headless === false)
      program.error("--headless-mode shell requires headless (drop --no-headless)");
    // The rungs are mutually exclusive: each answers a different question with a different capture,
    // and every invocation is exactly one pass. Two rungs means two invocations.
    if (cmdOpts.breakdown && cmdOpts.deep)
      program.error(
        "--breakdown and --deep are two different rungs (two captures, two questions): --breakdown is the reconciling bar, --deep is the attribution report. Run wpd twice to get both.",
      );
    if (cmdOpts.preciseWall && (cmdOpts.breakdown || cmdOpts.deep))
      program.error(
        `--precise-wall is rung 1 minus the sampler; it cannot combine with ${cmdOpts.breakdown ? "--breakdown" : "--deep"} (a higher rung). Drop one.`,
      );
    if (firefox) {
      // On firefox the ONE gecko pass IS the lane at every rung. --breakdown/--precise-wall have no
      // meaning over it, and --cpu-throttle needs CDP, which BiDi does not expose. --deep IS
      // supported: it is a reporting tier (the dirtied-by write report from Gecko's cause stacks), not
      // a capture change. --protocol-timeout is deliberately allowed: puppeteer threads it into BiDi.
      const unsupported = [
        cmdOpts.breakdown &&
          "--breakdown (firefox's reconciling bar comes from the Gecko profile automatically; your performance.measure() spans surface in recording.spans without a flag)",
        cmdOpts.preciseWall && "--precise-wall (the gecko pass IS the firefox lane)",
        cmdOpts.cpuThrottle && "--cpu-throttle (needs CDP)",
        cmdOpts.disableBrowserSandbox && "--disable-browser-sandbox (chrome-only launch flag)",
      ].filter(Boolean);
      if (unsupported.length) {
        program.error(
          `--target firefox has no CDP/DevTools trace, so these are unsupported: ${unsupported.join(", ")}. See the target-support matrix in the README.`,
        );
      }
    }
    if (node) {
      const browserOnly = [
        // Detection is skipped on node (above), so these hold the raw flag the user passed.
        (cmdOpts.url || cmdOpts.html) && (cmdOpts.url ? "--url" : "--html"),
        cmdOpts.cpuThrottle && "--cpu-throttle",
        cmdOpts.userDataDir && "--user-data-dir",
        cmdOpts.disableBrowserSandbox && "--disable-browser-sandbox",
        cmdOpts.breakdown && "--breakdown",
        cmdOpts.deep && "--deep",
        cmdOpts.preciseWall && "--precise-wall",
      ].filter(Boolean);
      if (browserOnly.length)
        program.error(
          `--target node is a CPU-only lane with no browser or trace: remove ${browserOnly.join(", ")}`,
        );
      // --bench selects in-page execution, not iteration, so it has no meaning without a page.
      if (bench)
        program.error(
          "--bench imports the module inside a page; --target node has no page. Drop --bench (--iterations already repeats run() on this lane).",
        );
    }
    // toInt already rejected non-numbers, so these are range checks only. 0 iterations would run
    // the flow zero times and report a page's worth of zeros.
    if (cmdOpts.iterations < 1) program.error("--iterations must be at least 1");
    if (cmdOpts.warmup < 0) program.error("--warmup cannot be negative");
    const opts: RecordOptions = {
      module,
      // `run` is the sole export the harness/driver look for (plus prepare/cleanup); there is no
      // flag to name another.
      fn: "run",
      // RecordOptions keeps browser/runtime as separate internal axes because runPass and capsFor
      // are written against them. --target is the single user-facing axis that maps onto both.
      browser: firefox ? "firefox" : "chrome",
      html: cmdOpts.html,
      url: cmdOpts.url,
      urlSchemeAssumed,
      iterations: cmdOpts.iterations,
      warmup: cmdOpts.warmup,
      out: cmdOpts.out,
      headless: cmdOpts.headless,
      headlessMode: cmdOpts.headlessMode,
      userDataDir: cmdOpts.userDataDir ? path.resolve(cmdOpts.userDataDir) : undefined,
      disableSandbox: !!cmdOpts.disableBrowserSandbox,
      // Internal default (no user flag): async paints flush before tracing stops.
      settleMs: 200,
      format: cmdOpts.format,
      driver: !bench && !node,
      runtime: node ? "node" : "chrome",
      cpuThrottle: cmdOpts.cpuThrottle,
      // On by default; captureFor turns it off on --deep (the sampler cannot ride a .stack trace)
      // and --precise-wall. On firefox it is what produces counts + blame at all.
      cpuProfile: true,
      protocolTimeoutMs: cmdOpts.protocolTimeout,
      breakdown: !!cmdOpts.breakdown,
      deep: !!cmdOpts.deep,
      preciseWall: !!cmdOpts.preciseWall,
    };
    try {
      await recordAndReport(opts);
    } catch (err) {
      program.error(`record failed: ${recordFailureMessage(err as Error)}`);
    }
  });

const query = program
  .command("query")
  .description("Browse/search a recording (start with `spans`). Any <file> may be 'latest'.");
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
    .command("spans <file>")
    .description(
      "compact overview: per-span time breakdown (run + steps + performance.measure), one shape across targets",
    )
    .option("--label <label>", "keep only the span with this exact label (case-sensitive)"),
).action((file, opts) => run(querySpans(file, opts)));
fmtOpts(
  query
    .command("span <file> <label>")
    .description(
      "one span's full anatomy: bar, counts, INP, forced/dirtied-by, hot functions. <label> is a bare label or a kind:label qualifier",
    )
    .option("--top <n>", "hot functions to show within the span (run span only)", toInt),
).action((file, label, opts) => run(querySpan(file, label, opts)));
// The removed `digest`/`index` verbs: a run is already digest-sized and steps are spans, so both
// folded into `spans` (overview) + `span <label>` (one span's anatomy). Kept as hidden stubs so an
// old invocation gets a message naming the replacement, not commander's bare "unknown command".
for (const [removed, replacement] of [
  [
    "digest",
    "`query spans <file>` for the overview, then `query span <file> <label>` for one span",
  ],
  ["index", "`query spans <file>` for the per-span overview, then `query span <file> <label>`"],
] as const) {
  query
    .command(removed, { hidden: true })
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => program.error(`\`query ${removed}\` was removed. Use ${replacement}.`));
}
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
    .option(
      "--dirtied",
      "firefox --deep only: the dirtied-by write report (Gecko cause stacks, first-invalidation-only), separate from the --forced read-site rows",
    )
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
  .option(
    "--max-slice <name=ms>",
    `max ms for a breakdown slice (${SLICE_NAMES.join("|")}); repeatable, e.g. --max-slice js=5 ` +
      "--max-slice layout=2. Slice ms is directional, never count-exact: trace wall-tier (~1%) on --breakdown bars, the profiler's own clock on CPU-only bars",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option("--label <label>", "span the --max-slice budgets gate, by label (default the run span)")
  .action((file, opts) => {
    let sliceBudgets: SliceBudgets;
    try {
      sliceBudgets = parseSliceBudgets(opts.maxSlice ?? []);
    } catch (error) {
      return program.error((error as Error).message);
    }
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
    return assertCmd(file, thresholds, sliceBudgets, opts.label).catch((error) =>
      program.error(error.message),
    );
  });

program
  .command("diff <baseline> <current>")
  .description("compare two recordings field-by-field (counts/INP/wall)")
  .option(
    "--fail-on-regression",
    "exit 1 if a gated exact count increased (INP and other wall-tier numbers stay advisory)",
  )
  .action((baseline, current, opts) =>
    diffCmd(baseline, current, { failOnRegression: !!opts.failOnRegression }).catch((error) =>
      program.error(error.message),
    ),
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
