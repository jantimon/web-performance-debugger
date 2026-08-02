#!/usr/bin/env node
import path from "node:path";
import { Command, Option } from "commander";
import { recordAndReport, recordMembersAndReport, type RecordOptions } from "./commands/record.js";
import { GROUP_MEMBER_MODES, isGroupMemberMode, type GroupMemberMode } from "./record/group.js";
import { resolvePageOption } from "./record/page-option.js";
import { builtinFlowFailureGuidance } from "./record/nav-failure.js";
import { isPrivateHostname } from "./trace/sourcemap.js";
import { queryBlame, queryEvents, queryGet, querySpan, querySpans } from "./commands/query.js";
import { queryCpu, queryFrame } from "./commands/cpu.js";
import { queryAlloc } from "./commands/alloc.js";
import { assertCmd, type Thresholds } from "./commands/assert.js";
import { diffCmd } from "./commands/diff.js";
import { parseSliceBudgets, SLICE_NAMES, type SliceBudgets } from "./model/spans.js";
import { cpuDiffCmd } from "./commands/cpudiff.js";
import { setColorEnabled } from "./output/color.js";
import { toFloat, toInt, toNonNegativeInt, toPositiveInt } from "./cli-validation.js";
import { docLinksEpilog } from "./doc-links.js";
import { VERSION, TOOL } from "./version.js";

/**
 * Puppeteer's protocol-timeout error tells the user to "increase the 'protocolTimeout' setting in
 * launch/connect calls" -- an API a CLI user never touches. Name the flag that actually fixes it.
 *
 * Two causes, and the advice differs: a heavy traced interaction pinned the main thread, or the
 * browser never finished its startup handshake (`session.new`, Firefox/BiDi), where there is no
 * step to make smaller
 */
function recordFailureMessage(error: Error): string {
  const protocolTimedOut =
    error.name === "ProtocolTimeoutError" || /protocolTimeout/i.test(error.message);
  if (!protocolTimedOut) return error.message;
  // `session.new` is the BiDi handshake: this fired before the browser was usable, so advice about
  // measuring less work per step would point at a step that never ran
  if (/session\.new/i.test(error.message))
    return `${error.message}\n\nThe browser did not finish its startup handshake in time. This is usually load, not your flow: retry, or raise --protocol-timeout (e.g. --protocol-timeout 600000).`;
  return `${error.message}\n\nThe page did not answer in time, usually because a traced interaction pinned the main thread. Retry with a higher --protocol-timeout (e.g. --protocol-timeout 600000), or measure less work per step.`;
}

/**
 * The one error-report shape every top-level catch shares. The message reaches the user first; under
 * WPD_DEBUG the full stack trails it (a RangeError such as a stack overflow carries an unhelpful
 * one-line message; the stack is the only pointer to where it blew). Otherwise the debug hint trails
 * ON THE SAME LINE as the message, so a caller reading only the last stderr line still gets the real
 * error, not a bare "(set WPD_DEBUG=1 ...)"
 */
function emitFailure(message: string, error: Error): void {
  if (process.env.WPD_DEBUG && error.stack) {
    console.error(message);
    console.error(error.stack);
  } else {
    console.error(`${message} (set WPD_DEBUG=1 to print the error stack)`);
  }
}

const program = new Command();
program
  .name(TOOL)
  .description(
    "Attribute rendering work (layout/paint/style/invalidation) and CPU self-time back to source lines. Drives Chrome, Firefox, or Node (--target); one capture mode per run.",
  )
  .version(VERSION)
  .option("--color <when>", "colorize human output: auto | always | never", "auto")
  .addHelpText(
    "after",
    "\nQuick start:\n  wpd record --url https://example.com\n  wpd query spans latest\n",
  )
  // Absolute paths to the installed package's docs, so an agent running `wpd --help` can open and
  // read them. import.meta.url is dist/cli.js; the docs sit at the package root above dist/
  .addHelpText("after", docLinksEpilog(import.meta.url));

// Resolve color once before any command runs. Human tables/reports use it; structured
// (--format) output never calls the color helpers, so it stays plain regardless
// auto = on only for an interactive TTY with NO_COLOR unset (https://no-color.org)
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
 * A positional id (`query get`/`query frame`). Bare `parseInt` turns `abc` into NaN ("No function
 * with id NaN") and `12junk` into 12, so parse it strictly and name the argument that was wrong
 */
const toPositionalId = (raw: string, argName: string): number => {
  if (!/^\d+$/.test(raw.trim()))
    program.error(`<${argName}> must be a non-negative whole number, got '${raw}'.`);
  return parseInt(raw, 10);
};

program
  .command("record")
  // Both modes have a real page and a live DOM; they differ in WHERE run() executes, and therefore
  // in what times it. Name both signatures: "no args" or an unqualified "real page" on one of them
  // reads as "--bench has no page", and from there as "it cannot touch the DOM"
  .description(
    "Record where rendering work comes from. Default: run({ page, ctx, measureStep }) executes in Node and drives the page via Puppeteer. --bench: run(ctx) executes inside the page itself, with live document/window and no page handle, timed in-page.",
  )
  // Optional: with no module, wpd runs a built-in load flow (navigate to --url and settle), so a
  // first run needs zero authoring. A module continues to work exactly as before
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
  // --html is removed: --url names the host page and accepts a local HTML file or a live URL. Kept
  // hidden so an explicit --html gets a migration message from the action, not commander's generic
  // unknown-option error
  .addOption(new Option("--html <file>").hideHelp())
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
  .option(
    "--keep-partial",
    "driver mode: if a later iteration fails (a flaky nav on a production site), keep the iterations that completed instead of aborting the whole run. A failure in the first iteration still errors; the salvaged recording carries a loud note naming the failed iteration and step",
  )
  .option("--out <file>", "output recording path (default recordings/<timestamp>.json)")
  .option("--no-headless", "run with a visible browser window")
  .option(
    "--user-data-dir <path>",
    "reuse a persistent browser profile (chrome or firefox) to log in once; shared across passes/runs. Use a throwaway dedicated dir: it stores cookies, logins and history",
  )
  .option(
    "--disable-browser-sandbox",
    "chrome only: launch with --no-sandbox for environments that cannot start Chrome's sandbox (containers, restricted CI). WARNING: reduces process containment; only use in a trusted, isolated environment and not with --user-data-dir or a non-loopback --url",
  )
  .option("--cpu-throttle <rate>", "artificial slowdown: CPU multiplier (4 = 4x slower)", toInt)
  .option(
    "--allow-bot-wall",
    "skip bot-wall detection: measure the page even if wpd's navigation lands on a bot-challenge interstitial (Cloudflare/DataDome/etc.). Off by default, where such a page is refused with a screenshot before measuring. Use only when you deliberately want to measure the challenge page itself; the recording carries a loud note that the numbers describe it, not the site",
  )
  .option(
    "--protocol-timeout <ms>",
    "timeout in ms for one protocol call (default 180000); raise it when a heavy traced interaction pins the main thread, or when a loaded machine makes Firefox time out launching",
    toPositiveInt,
  )
  // The chrome capture modes. Default (no flag): CPU sampler only, no trace, cleanest wall -- the
  // four-slice CPU bar, no rendering counts. --breakdown and --deep each capture more. Every
  // invocation is exactly ONE pass
  .option(
    "--breakdown",
    "chrome capture mode: ONE fused pass (light trace + CPU sampler) yields a reconciling js/style/layout/paint/gc/other/idle bar per span, plus exact layout/style/paint counts. Cannot report forced-layout counts or blame (they need the `.stack` category, which --deep captures). Mutually exclusive with --deep; for both, record a run group via --members. Read it with `query spans`",
  )
  .option(
    "--deep",
    "attribution-report capture mode. Chrome: ONE full-trace pass (.stack + invalidationTracking), sampler OFF -- exact forced-layout blame, dirtied-by writes, invalidation rollup, exact counts, long tasks; slice durations suppressed (the trace distorts them), no CPU model. Firefox: the SAME gecko pass, adding a dirtied-by (first-invalidation-only) write report from Gecko's cause stacks (no exact-count parity, no forced-by, no thrash detector). Mutually exclusive with --breakdown; for both, record a run group via --members. Read it with `query blame --forced`",
  )
  .option(
    "--alloc",
    "allocation-attribution capture mode (--target node only): which dependency ALLOCATES during run(). Runs V8's heap sampler instead of the CPU sampler (CPU self-time not measured on this recording). Read it with `query alloc`",
  )
  // Removed: wpd always runs Chrome's built-in headless (full Chrome, windowless) or --no-headless
  // Kept as a hidden option so an explicit --headless-mode gets a clear removal message from the
  // action, not commander's generic unknown-option error
  .addOption(new Option("--headless-mode <mode>").hideHelp())
  // Removed: the CPU sampler now rides every chrome sampling capture; its wall cost is systematic and
  // cancels in diff/cpu-diff. Kept as a hidden option so an explicit --precise-wall gets a clear
  // removal message from the action, not commander's generic unknown-option error
  .addOption(new Option("--precise-wall").hideHelp())
  .option(
    "--variant <label>",
    "label this recording's technique (e.g. when one module runs several, switched by an env var), so a diff/cpu-diff --fail-on-regression gate refuses to compare two different variants",
  )
  .option(
    "--framework <mode>",
    "framework addons: off | auto (default auto). off runs zero addon code; auto lets factual detection decide. React: detection metadata + per-step commit counts (browser lanes), react-dom server-phase self-time rollup (node lane), and React Performance-Track facts on --deep. Every lane accepts it; an addon no-ops where its signals are absent",
    "auto",
  )
  .option(
    "--group <name>",
    "append this recording to a named run-group manifest (siblings under <name>.group.json), so a two-question flow (record --breakdown, then record --deep) reads as one group. The join refuses a member whose workload/iterations/etc differ (only the capture mode may)",
  )
  .option(
    "--members <modes>",
    `record several capture modes back-to-back into ONE --group (${GROUP_MEMBER_MODES.join(",")}; comma-separated, e.g. --members breakdown,deep). Runs N browser launches, applies all other flags identically. chrome only; needs --group`,
  )
  .option("--format <fmt>", "on-disk format: json | toon", "json")
  .addHelpText(
    "after",
    "\nAfter recording, read it with: wpd query spans latest (then: query span / query cpu / query blame)\n",
  )
  .action(async (module: string | undefined, cmdOpts: any) => {
    if (!["json", "toon"].includes(cmdOpts.format)) program.error("--format must be json or toon");
    // --framework accepts every lane (an addon no-ops where its signals are absent), so it is validated
    // here for spelling but never rejected on a target
    if (!["off", "auto"].includes(cmdOpts.framework))
      program.error("--framework must be off or auto");
    // One axis: chrome | firefox | node, so a conflicting browser/runtime combination is
    // unrepresentable rather than something to guard against
    if (!["chrome", "firefox", "node"].includes(cmdOpts.target))
      program.error("--target must be chrome, firefox, or node");
    const bench = !!cmdOpts.bench;
    const node = cmdOpts.target === "node";
    const firefox = cmdOpts.target === "firefox";
    const alloc = !!cmdOpts.alloc;
    // --alloc is a dedicated node capture mode (V8 heap sampling in-process): it needs --target node,
    // and it is mutually exclusive with the chrome capture modes (--breakdown/--deep) -- three
    // different questions, one capture each. Fired before the lane guards below so an --alloc on the
    // wrong lane gets this message, not a generic browser-flag complaint
    if (alloc && !node)
      program.error(
        "--alloc needs --target node: it is an in-process heap-sampling capture mode (which dependency allocates during run()), not available on chrome or firefox.",
      );
    if (alloc && (cmdOpts.breakdown || cmdOpts.deep))
      program.error(
        "--alloc, --breakdown and --deep are different capture modes (allocation vs the reconciling bar vs the attribution report): pick one. --alloc runs the heap sampler with the CPU sampler off.",
      );
    // --html is removed: --url names the host page and accepts a local HTML file or a live URL
    // Intercept an explicit --html here (before resolution reuses cmdOpts.html for the resolved
    // local-file case) so it gets a migration message, not a silently ignored flag
    if (cmdOpts.html !== undefined)
      program.error("--html was removed in this version. Use --url <file-or-url>.");
    // --precise-wall is removed: fires before the firefox/node/no-module guards so any invocation
    // carrying it gets the retirement message, not a lane-specific complaint about the same flag
    if (cmdOpts.preciseWall !== undefined)
      program.error(
        "--precise-wall was removed. The CPU sampler now rides every chrome sampling capture; its wall cost is systematic, so it cancels in `diff`/`cpu-diff`. A sampler-free wall serves only absolute-wall benchmarking, which wpd does not measure. Record in the default capture mode and compare with `diff`.",
      );
    // --url names the host page and accepts a live URL OR a local HTML file path; the detection
    // (URL vs file) sets cmdOpts.url or cmdOpts.html to the resolved value. node has no page, so its
    // own guard (below) rejects --url with a lane-specific message; skip the detection there so a bad
    // value does not preempt it
    let urlSchemeAssumed = false;
    const rawHostPage = cmdOpts.url;
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
    // and --target node (no page) have nothing to run, and a bare `record` has no target at all
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
    }
    // --headless-mode is removed: wpd measures how real Chrome performs, so it always runs Chrome's
    // built-in headless (full Chrome, windowless), and chrome-headless-shell is gone. Fail an explicit
    // flag with a clear message rather than silently ignoring it
    if (cmdOpts.headlessMode !== undefined)
      program.error(
        "--headless-mode was removed in this version. wpd always runs Chrome's built-in headless; use --no-headless for a visible window.",
      );
    // The capture modes are mutually exclusive: each answers a different question with a different
    // capture, and every invocation is exactly one pass. Two capture modes means two invocations
    if (cmdOpts.breakdown && cmdOpts.deep)
      program.error(
        "--breakdown and --deep are two different capture modes (two captures, two questions): --breakdown is the reconciling bar, --deep is the attribution report. Record both into one group: `record --members breakdown,deep --group <name>`.",
      );
    if (firefox) {
      // On firefox the ONE gecko pass IS the lane in every capture mode. --breakdown has no meaning
      // over it, and --cpu-throttle needs CDP, which BiDi does not expose. --deep IS supported: it is
      // a reporting tier (the dirtied-by write report from Gecko's cause stacks), not a capture
      // change. --protocol-timeout is deliberately allowed: puppeteer threads it into BiDi
      const unsupported = [
        cmdOpts.breakdown &&
          "--breakdown (firefox's reconciling bar comes from the Gecko profile automatically; your performance.measure() spans surface in recording.spans without a flag)",
        // Presence-based, not truthiness: --cpu-throttle 0 is still unsupported here, and 0 is falsy
        cmdOpts.cpuThrottle != null && "--cpu-throttle (needs CDP)",
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
        // Detection is skipped on node (above), so this holds the raw flag the user passed
        cmdOpts.url && "--url",
        // Presence-based where the value can be falsy (0 throttle, 0 timeout): the lane consumes
        // none of these, so a passed-but-falsy value is still a flag on the wrong lane
        cmdOpts.cpuThrottle != null && "--cpu-throttle",
        cmdOpts.userDataDir && "--user-data-dir",
        cmdOpts.disableBrowserSandbox && "--disable-browser-sandbox",
        cmdOpts.breakdown && "--breakdown",
        cmdOpts.deep && "--deep",
        // No browser to make headless/visible, no driver iteration to salvage, no protocol to time
        // out: this lane runs in-process
        cmdOpts.headless === false && "--no-headless",
        cmdOpts.keepPartial && "--keep-partial",
        cmdOpts.protocolTimeout != null && "--protocol-timeout",
        cmdOpts.allowBotWall && "--allow-bot-wall",
      ].filter(Boolean);
      if (browserOnly.length)
        program.error(
          `--target node is a CPU-only lane with no browser or trace: remove ${browserOnly.join(", ")}`,
        );
      // --bench selects in-page execution, not iteration, so it has no meaning without a page
      if (bench)
        program.error(
          "--bench imports the module inside a page; --target node has no page. Drop --bench (--iterations already repeats run() on this lane).",
        );
    }
    // --keep-partial salvages a failed driver iteration; --bench imports run() in-page with no
    // driver loop to salvage, so the flag has nothing to act on (node already rejected --bench)
    if (bench && cmdOpts.keepPartial)
      program.error(
        "--keep-partial is a driver-mode salvage: --bench runs run() in-page, with no per-iteration driver step to keep. Drop --keep-partial.",
      );
    // --cpu-throttle multiplies CPU slowdown; the throttle skips a rate of 1 or below silently, so a
    // value that does nothing is a typo, not a request. firefox/node already rejected the flag above,
    // so reaching here is chrome
    if (!firefox && !node && cmdOpts.cpuThrottle != null && cmdOpts.cpuThrottle <= 1)
      program.error("--cpu-throttle must be an integer greater than 1 (e.g. 4 for 4x slower).");
    // --disable-browser-sandbox drops the renderer's OS process containment (chrome-only; firefox and
    // node reject the flag above, so reaching here means chrome). What that unsandboxed renderer is
    // then allowed to touch decides whether the combination is merely reduced-containment or actively
    // dangerous
    if (cmdOpts.disableBrowserSandbox && !firefox && !node) {
      // A persistent real profile behind an unsandboxed renderer has no safe use: a renderer
      // compromise reaches the profile's cookies and logins with nothing in the way. Refuse
      if (cmdOpts.userDataDir)
        program.error(
          "--disable-browser-sandbox with --user-data-dir runs page content in a renderer with no OS containment AND gives it your persistent Chrome profile (its cookies and logins). There is no safe way to combine them: drop one.",
        );
      // A public --url loads content you do not control into that unsandboxed renderer. This is
      // legitimate inside an already-isolated container (the reason the opt-out exists), so warn
      // loudly before launch rather than refuse -- the point is that the composition is not silent
      let publicUrlHost: string | undefined;
      if (cmdOpts.url) {
        try {
          const candidateHost = new URL(cmdOpts.url).hostname;
          if (!isPrivateHostname(candidateHost)) publicUrlHost = candidateHost;
        } catch {
          publicUrlHost = undefined;
        }
      }
      if (publicUrlHost)
        console.error(
          `WARNING: --disable-browser-sandbox loads ${cmdOpts.url} (a public host) in a renderer with no OS containment. Only do this in a trusted, isolated environment such as a container or CI, never on a machine holding data worth protecting.`,
        );
    }
    // toInt already rejected non-numbers, so these are range checks only. 0 iterations would run
    // the flow zero times and report a page's worth of zeros
    if (cmdOpts.iterations < 1) program.error("--iterations must be at least 1");
    if (cmdOpts.warmup < 0) program.error("--warmup cannot be negative");
    // --group appends this recording to a named manifest; --members records several capture modes
    // into ONE group in one invocation. The runner sets the capture mode per member, so it is chrome
    // only (firefox is one gecko pass at every mode, node is one lane) and rejects the single-mode
    // flags. --group alone stays allowed on every target
    const groupName = cmdOpts.group?.trim() || undefined;
    if (cmdOpts.group != null && !groupName) program.error("--group needs a non-empty name.");
    // --alloc has no group-aware consumer verb yet (query alloc reads a single recording), so a group
    // holding an alloc member has nothing to stitch. Refuse rather than write a member no verb reaches
    if (alloc && groupName)
      program.error(
        "--alloc does not support --group in this version: there is no group-aware allocation verb. Record it as a standalone `record <module> --target node --alloc` run.",
      );
    let memberModes: GroupMemberMode[] | undefined;
    if (cmdOpts.members != null) {
      if (!groupName)
        program.error("--members records into a group; pass --group <name> to name it.");
      if (firefox || node)
        program.error(
          `--members is chrome only: --target ${cmdOpts.target} is one capture at every mode (firefox is one gecko pass, node is one lane). Use --group <name> to add this single recording to a group.`,
        );
      if (cmdOpts.breakdown || cmdOpts.deep)
        program.error(
          "--members sets the capture mode per member: drop --breakdown/--deep (list them in --members instead).",
        );
      const rawModes = String(cmdOpts.members)
        .split(",")
        .map((mode: string) => mode.trim())
        .filter(Boolean);
      const invalid = rawModes.filter((mode: string) => !isGroupMemberMode(mode));
      if (invalid.length)
        program.error(
          `--members: unknown capture mode(s) ${invalid.join(", ")}. Valid: ${GROUP_MEMBER_MODES.join(", ")}.`,
        );
      const seen = new Set<string>();
      for (const mode of rawModes) {
        if (seen.has(mode))
          program.error(`--members lists '${mode}' twice; each capture mode is one member.`);
        seen.add(mode);
      }
      if (!rawModes.length)
        program.error("--members needs at least one capture mode, e.g. --members breakdown,deep.");
      memberModes = rawModes as GroupMemberMode[];
    }
    const opts: RecordOptions = {
      module,
      /**
       * `run` is the sole export the harness/driver look for (plus prepare/cleanup); there is no
       * flag to name another
       */
      fn: "run",
      /**
       * RecordOptions keeps browser/runtime as separate internal axes because runPass and capsFor
       * are written against them. --target is the single user-facing axis that maps onto both
       */
      browser: firefox ? "firefox" : "chrome",
      html: cmdOpts.html,
      url: cmdOpts.url,
      urlSchemeAssumed,
      iterations: cmdOpts.iterations,
      warmup: cmdOpts.warmup,
      out: cmdOpts.out,
      headless: cmdOpts.headless,
      userDataDir: cmdOpts.userDataDir ? path.resolve(cmdOpts.userDataDir) : undefined,
      /**
       * WPD_DISABLE_BROWSER_SANDBOX=1 is the env equivalent of --disable-browser-sandbox, for a CI
       * whose runner cannot run Chrome's sandbox with trace capture; chrome-only, ignored by node/firefox
       */
      disableSandbox:
        !!cmdOpts.disableBrowserSandbox || process.env.WPD_DISABLE_BROWSER_SANDBOX === "1",
      /** Internal default (no user flag): async paints flush before tracing stops */
      settleMs: 200,
      format: cmdOpts.format,
      driver: !bench && !node,
      keepPartial: !!cmdOpts.keepPartial,
      runtime: node ? "node" : "chrome",
      cpuThrottle: cmdOpts.cpuThrottle,
      allowBotWall: !!cmdOpts.allowBotWall,
      /**
       * On by default; captureFor turns it off on --deep (the sampler cannot ride a .stack trace)
       * On firefox it is what produces counts + blame at all
       */
      cpuProfile: true,
      protocolTimeoutMs: cmdOpts.protocolTimeout,
      breakdown: !!cmdOpts.breakdown,
      deep: !!cmdOpts.deep,
      alloc,
      /**
       * Trim to a non-empty label or drop it: an empty/whitespace --variant would otherwise persist
       * into meta and block a comparability gate while every truthiness-guarded output omitted it,
       * so gating and disclosure would disagree
       */
      variant: cmdOpts.variant?.trim() || undefined,
      group: groupName,
      /** off runs zero addon code; auto (default) lets factual detection decide */
      framework: cmdOpts.framework === "off" ? "off" : "auto",
    };
    try {
      if (memberModes) await recordMembersAndReport(opts, memberModes);
      else await recordAndReport(opts);
    } catch (err) {
      const error = err as Error;
      // Set a non-zero exit code so CI/scripts detect the failure. process.exitCode (not a hard
      // process.exit) lets buffered stdout/stderr flush and the browser/server teardown finish before
      // the process ends
      // The built-in --url load flow (no module) failing on a site-behavior class gets the
      // driver-module escape-hatch guidance appended; a bot-wall refusal already carries its own
      // evidence + skip-flag message, so it is left as-is
      const builtinFlow = !module && !!cmdOpts.url;
      const guidance = builtinFlow ? builtinFlowFailureGuidance(error) : null;
      const cause = recordFailureMessage(error) + (guidance ?? "");
      emitFailure(`record failed: ${cause}`, error);
      process.exitCode = 1;
    }
  });

const query = program
  .command("query")
  .description("Browse/search a recording (start with `spans`). Any <file> may be 'latest'.");
const fmtOpts = (command: Command) =>
  command
    // --json is the hidden alias of --format json: kept working (structuredFormat reads it), kept out
    // of help. --format is the documented spelling
    .addOption(new Option("--json").hideHelp())
    .option("--format <fmt>", "structured output: json | toon");
// Surface query errors (bad --kind, missing recording, unknown id) as a clean message
// and exit 1, not a raw unhandled-rejection stack trace
const run = (promise: Promise<void>) =>
  promise.catch((error: Error) => {
    emitFailure(error.message, error);
    process.exitCode = 1;
  });

fmtOpts(
  query
    .command("spans <file>")
    .description(
      "compact overview: per-span time breakdown (run + steps + performance.measure), one shape across targets",
    )
    .option("--label <label>", "keep only the span with this exact label (case-sensitive)")
    .option(
      "--min-wall <ms>",
      "hide spans below this wall (ms); cuts a tag manager's flood of sub-N-ms measures. The hidden count is disclosed",
      toFloat,
    )
    .option(
      "--filter <text>",
      "keep only spans whose label contains <text> (case-insensitive substring). The hidden count is disclosed",
    )
    .option(
      "--frames",
      "list each dropped/smoothness-affecting compositor frame under a bar (default: a one-line count)",
    ),
).action((file, opts) => run(querySpans(file, opts)));
fmtOpts(
  query
    .command("span <file> <label>")
    .description(
      "one span's full anatomy: bar, counts, INP, forced/dirtied-by, hot functions. <label> is a bare label or a kind:label qualifier",
    )
    .option("--top <n>", "hot functions to show within the span (run span only)", toPositiveInt)
    .option(
      "--frames",
      "list each dropped/smoothness-affecting compositor frame under the bar (default: a one-line count)",
    ),
).action((file, label, opts) => run(querySpan(file, label, opts)));
// The removed `digest`/`index` verbs: a run is already digest-sized and steps are spans, so both
// folded into `spans` (overview) + `span <label>` (one span's anatomy). Kept as hidden stubs so an
// old invocation gets a message naming the replacement, not commander's bare "unknown command"
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
      "layout|style|paint|composite|invalidation|scripting|gc|task|usertiming|other",
    )
    .option("--name <substr>", "case-insensitive name filter")
    .option("--forced", "only forced (synchronous) layout/style")
    .option("--top <n>", "limit to first n", toPositiveInt)
    .option("--sort <by>", "dur|ts (default dur)", "dur"),
).action((file, opts) => run(queryEvents(file, opts)));
fmtOpts(
  query
    .command("blame <file>")
    .description("aggregate source-attributed events by location (file may be 'latest')")
    .option("--kind <kind>", "restrict to one event kind")
    .option("--forced", "only forced (synchronous) layout/style -- layout thrashing")
    .option("--all", "every attributed line with a 'forced' column (shows ran-but-forced-0)")
    .option(
      "--dirtied",
      "firefox --deep only: the dirtied-by write report (Gecko cause stacks, first-invalidation-only), separate from the --forced read-site rows",
    )
    .option("--top <n>", "limit to first n locations", toPositiveInt),
).action((file, opts) => run(queryBlame(file, opts)));
fmtOpts(
  query.command("get <file> <id>").description("fetch one event (full stack + args) by id"),
).action((file, id, opts) => run(queryGet(file, toPositionalId(id, "id"), opts)));
fmtOpts(
  query
    .command("cpu <file>")
    .description("CPU profile overview: hot functions + by-package self time")
    .option("--by <grouping>", "rollup grouping: package | file | function", "package")
    .option("--top <n>", "hot functions to show", toPositiveInt),
).action((file, opts) => run(queryCpu(file, opts)));
fmtOpts(
  query
    .command("alloc <file>")
    .description(
      "allocation profile overview (--target node --alloc): top allocating functions + by-package bytes",
    )
    .option("--by <grouping>", "rollup grouping: package | file | function", "package")
    .option("--top <n>", "functions to show", toPositiveInt),
).action((file, opts) => run(queryAlloc(file, opts)));
fmtOpts(
  query
    .command("frame <file> <id>")
    .description("drill one CPU function by id: its callers and callees"),
).action((file, id, opts) => run(queryFrame(file, toPositionalId(id, "id"), opts)));

program
  .command("assert <file>")
  .description(
    "gate a recording or run-group against thresholds; driver thresholds apply per step (exit 1 on violation)",
  )
  .option("--max-forced <n>", "max forced layout/style", toNonNegativeInt)
  .option("--max-layouts <n>", "max layout count", toNonNegativeInt)
  .option("--max-paints <n>", "max paint count", toNonNegativeInt)
  .option("--max-layout-invalidations <n>", "max layout invalidations", toNonNegativeInt)
  .option("--max-style-invalidations <n>", "max style/selector invalidations", toNonNegativeInt)
  .option("--max-long-tasks <n>", "max tasks >=50ms", toNonNegativeInt)
  // INP (Event Timing) durations are 8ms-granular whole numbers, but the budget accepts fractional
  // ms for one consistent policy with --max-wall and --max-slice: every directional ms budget is a
  // non-negative finite float
  .option("--max-inp <ms>", "max INP (worst interaction) ms", toFloat)
  .option("--max-wall <ms>", "max wall ms", toFloat)
  .option(
    "--max-slice <name=ms>",
    `max ms for a breakdown slice (${SLICE_NAMES.join("|")}); repeatable, e.g. --max-slice js=5 ` +
      "--max-slice layout=2. Slice ms is directional, never count-exact: trace wall-tier (~1%) on --breakdown bars, the profiler's own clock on CPU-only bars",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option("--label <label>", "span the --max-slice budgets gate, by label (default the run span)")
  // --json is the hidden alias of --format json (same policy as the query/diff verbs); the exit code
  // is unchanged, so a JSON consumer and a table reader gate on the same verdict
  .addOption(new Option("--json").hideHelp())
  .option("--format <fmt>", "structured output: json | toon")
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
    return assertCmd(file, thresholds, sliceBudgets, opts.label, {
      json: opts.json,
      format: opts.format,
    }).catch((error) => {
      emitFailure(error.message, error);
      process.exitCode = 1;
    });
  });

fmtOpts(
  program
    .command("diff <baseline> <current>")
    .description("compare two recordings field-by-field (counts/INP/wall)")
    .option(
      "--fail-on-regression",
      "exit 1 if a gated exact count increased (INP and other wall-tier numbers stay advisory)",
    ),
).action((baseline, current, opts) =>
  diffCmd(baseline, current, {
    failOnRegression: !!opts.failOnRegression,
    json: opts.json,
    format: opts.format,
  }).catch((error) => {
    emitFailure(error.message, error);
    process.exitCode = 1;
  }),
);

program
  .command("cpu-diff <baseline> <current>")
  .description("compare two CPU models: per-package + per-function self-time deltas")
  .option(
    "--fail-on-regression",
    "exit 1 if net JS self-time increased (gc/native/idle changes and sampler noise do not count)",
  )
  // --json is the hidden alias of --format json: kept working, kept out of help
  .addOption(new Option("--json").hideHelp())
  .option("--format <fmt>", "structured output: json | toon")
  .action((baseline, current, opts) =>
    cpuDiffCmd(baseline, current, {
      failOnRegression: !!opts.failOnRegression,
      json: opts.json,
      format: opts.format,
    }).catch((error) => {
      emitFailure(error.message, error);
      process.exitCode = 1;
    }),
  );

// Any error that escapes a command action (one not already routed through emitFailure) must still
// exit non-zero, independent of Node's --unhandled-rejections policy, so CI never reads a silent 0
program.parseAsync(process.argv).catch((error: unknown) => {
  const failure = error instanceof Error ? error : new Error(String(error));
  emitFailure(failure.message, failure);
  process.exitCode = 1;
});
