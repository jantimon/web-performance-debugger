# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`wpd` (package `@jantimon/web-performance-debugger`, bins `wpd` / `web-performance-debugger`) is a
TypeScript CLI that drives Chrome or Firefox via Puppeteer to **attribute layout/paint/style/
invalidation work back to source lines**, plus **CPU sampling** (on by default) that attributes
self-time to source/package. One user-facing axis picks where it runs: `--target chrome|firefox|node`.
Three trust tiers, keep them straight: **counts** (CDP) are exact; **wall/INP timing** rides
`performance.now()` (Chrome-clamped, so coarse/directional); **CPU self-time** comes from the
profiler's own microsecond clock (*not* `performance.now()`), so its ms are a real signal,
trustworthy in aggregate (sampling noise ~few %). So it is not a wall-clock benchmark runner, but it
*is* the right tool for comparing JS cost (e.g. SSR `renderToString` lanes).

**`selfMs` is not "pure JS" on the browser lanes.** It is JS *plus the synchronous engine work JS
triggered*: a forced layout lands as self-time on the line that forced it (measured: ~85% of the
forced-layout probe's "JS" self-time is reflow). Only `--target node` (no DOM) measures pure JS.
This is a feature — it prices "delete this line" — but do not describe it as pure JS.

Read `README.md` for the user-facing surface; this file is the internal map; **`docs/dev/` holds the
measured facts behind the non-obvious choices** ([index](docs/dev/README.md)) and is the first stop
before changing the pass plan, the Gecko converter, or any cross-engine claim.

## Commands

```bash
npm run build           # tsc -> dist/ (ESM, NodeNext)
npm test                # unit only (pretest builds first); pure functions, no browser
npm run test:e2e        # e2e: drives the real CLI against headless Chrome (record -> query)
npm run lint            # oxlint src   (lint:fix to autofix)
npm run format          # oxfmt --write (format:check to verify; config in .oxfmtrc.json, ~prettier)
node dist/cli.js <...>  # run the CLI (installed bins: web-performance-debugger, wpd)
npm run changeset       # add a changeset; CI Release workflow versions+publishes on merge to main
```

CI (`.github/workflows/ci.yml`) has two jobs on Node 24: `ci` (lint → format:check → build →
unit `test`, browser-free, `PUPPETEER_SKIP_DOWNLOAD`) and `e2e` (downloads Chrome, runs
`test:e2e`). Unit tests (`test/unit.test.mjs`) cover pure functions
(classify/summarize/analysis/format) against compiled `dist/`. The e2e test (`test/cli.e2e.test.mjs`)
spawns the built CLI against real headless Chrome and asserts the two flagship flows end-to-end:
forced-layout `blame` attribution and CPU source resolution. It **self-skips when
Chrome is not installed** (so `npm test` and the `ci` job stay green and fast); `WPD_E2E_REQUIRED=1`
(set by `test:e2e`) turns a missing browser into a hard failure so the e2e job can't silently pass.
The broader smoke tests below stay manual (always `npm run build` first — the CLI runs `dist/`):

```bash
node dist/cli.js record examples/forces-layout.mjs --bench --iterations 5  # in-page; forced-layout detection
node dist/cli.js query blame latest --forced                        # source-attributed thrashing
node dist/cli.js record examples/counter-steps.mjs --html examples/react-counter/dist/index.html  # driver (default)
node dist/cli.js query index latest                                 # per-step output
# examples/react-counter is a Vite app: cd examples/react-counter && npm install && npm run build (needed once for --html)
```

## Architecture

Flow: **`record` produces a `Recording` (model/recording.ts) → `query`/`assert`/`diff` consume it.**
`src/cli.ts` (commander) is the only entry point and wires every command.

### Two execution modes (this is the central design fork)

`record` has two fundamentally different ways to run the user's module, with **different `run`
contracts** — keep them straight:

- **Driver mode** (default): the module runs *in Node* and `run({ page, ctx, measureStep })`
  drives the page via Puppeteer. Implemented by `browser/driver.ts`. Steps are defined by
  `measureStep(label, action, { until })`; each becomes its own per-step recording + a
  `StepIndex`. Per-step INP is captured via an injected Event Timing `PerformanceObserver`. A
  `page.goto` inside a `measureStep` is traced, so a navigation step measures a cold boot.
- **Bench mode** (`--bench`): the module is served over http and `import()`'d *inside the
  browser*; `run(ctx)` gets no `page` handle (there is nothing to drive from inside) but has live
  `document`/`window`, and `--html`/`--url` still supply the host page. Implemented by
  `browser/harness.ts` (a function serialized into `page.evaluate`) + `browser/server.ts` (a
  temp static server — ESM `import()` can't use `file://`, and the blank host page is served
  same-origin to avoid cross-origin import). It measures only `run()` (page load/boot is
  excluded). The CLI sets the internal `RecordOptions.driver` to `!bench`.

`--iterations`/`--warmup` repeat `run()` in **both** modes: the mode that measures real interactions
needs a statistical footing as much as bench does. Driver labels are unique **within an iteration**,
not within the run: the repetitions are a label's samples, so
`mergeSteps` groups by label and each step reports the median of its own. That is also why
`DriverStep` carries `markIndex` separately from `index` -- the trace needs a name that is unique
per pass, while `index` is the step's stable position within an iteration.

Modules/HTML must live under the cwd (the static server is rooted there). `--url` profiles any
local/remote server; `--html` a local file; neither => blank page.

### Two-pass isolation (why numbers are trustworthy)

`record.ts` runs the module **twice** by default (`runPass`):
1. **timing pass** — tracing OFF: clean per-iteration/per-step wall times + cheap CDP
   `getMetrics` counters (`metrics/cdp.ts`).
2. **trace pass** — full DevTools timeline incl. `invalidationTracking`: the event log,
   paint/invalidation counts, source attribution.

The merge prefers CDP counts (authoritative) and trace events for paint/invalidation. Heavy
instrumentation distorts timing, hence the split. `--no-isolate` collapses to one pass.
`meta.passes` records what ran. In driver mode each pass *replays the flow* (fresh browser), so
flows should be idempotent.

**Counts and wall live on different axes, and `--iterations` is where that bites.** Counts answer
"how much work does one iteration cause" and must NOT scale with `--iterations`; wall only means
something in bulk and must. So the count-bearing pass *runs* one iteration rather than being
windowed after the fact: `traceSpec` is pinned to `iterations: 1` (whenever a timing pass exists to
carry the samples), and `timingSpec.bracketFirstIteration` closes the CDP counter bracket after the
first iteration -- in bench by splitting the timed `page.evaluate` in two, in driver by snapshotting
inside `runDriver`. Windowing counts per iteration is NOT an option: paint/composite land after
`run:end` during settle (`inWindow` is start-onward *by design*), so they belong to no iteration.
Two lanes cannot have it both ways and say so via `noteCountScope` instead of lying: `--no-isolate`
(one pass carries wall AND counts) and firefox (the gecko pass is that lane's only CPU sampler).
Bench `wallMs` is the **sum of the timed samples**, not a window: the window would either span one
iteration (wrong) or bracket the split's own CDP round trip (measured: ~2.1ms of tool cost billed to
the page).

**The CPU sampler rides the timing pass**, not a pass of its own: a cpu spec and the timing spec are
the same pass (`categories: null`) plus the sampler, so a separate pass would buy isolation from
*timing*, which is not what matters. Isolation from **tracing** is: sampling during the trace pass
inflates CPU self-time **+21%** (our own `devtools.timeline.stack` category
makes Blink walk the JS stack on every Layout, and the sampler bills that to the forcing JS frame —
the same frame the real forced-layout cost lands on, so the two cannot be separated afterwards).
**Never move `cpu` onto `traceSpec`.** Riding the timing pass costs ~10% on wall, which
`--no-cpu-profile` buys back. `--no-isolate` collapses to the trace pass alone, so it yields no CPU
model and says so. Measurements: [docs/dev/cpu-profiling.md](docs/dev/cpu-profiling.md).

### Trace pipeline (trace/)

`parse.ts` (raw trace JSON → `NormalizedEvent[]`, `findWindow`/`findSteps` locate
`wpd:run`/`:step:N` marker windows) → `classify.ts` (event name/category → `EventKind`:
layout/style/paint/composite/invalidation/scripting/task/usertiming/other) → `stacks.ts`
(rewrites trace stack URLs back to local source paths; **async** because it resolves bundle
frames through sourcemaps via `sourcemap.ts`) → `analysis.ts` (`markForced`, `forcedLayouts`,
`longTasks`, `extractInvalidations`).

**Forced-reflow detection** is the key feature and depends on a non-obvious config: layout/style
events only carry a JS stack when JS forced them synchronously, and capturing that stack requires
the `disabled-by-default-devtools.timeline.stack` category in `trace/categories.ts`. `markForced`
flags layout/style events that have a resolved user stack (`e.at`).

Two things this rule is **not**, both documented in
[docs/dev/engine-mapping.md](docs/dev/engine-mapping.md):

- **Not DevTools' rule.** DevTools ignores the stack entirely and requires nesting inside a JS
  invocation event *plus* a >=30ms per-task aggregate. Ours flags cheap forced layouts DevTools
  stays silent on — defensible for a CI gate, but do not describe it as "what DevTools does".
- **Not what Firefox does.** Chrome's stack names the geometry **read** that forced the flush;
  Gecko's cause stack names the **write** that dirtied the DOM. Measured on the same probe: **zero**
  line overlap. `query blame --forced` therefore means a different thing per engine today.

### Output & consumption

- `metrics/summarize.ts` builds `RecordingSummary` from trace events + CDP deltas.
- `commands/digest.ts` builds the small `Digest` (the context-friendly entry point): slowest
  events with `id`s, blame, forced layouts, long tasks, invalidation rollup. **Agents/users
  should read the digest, not the multi-MB recording**, then drill via `query get <id>`.
- `commands/query.ts` = 5 verbs: `digest`, `index`, `events`, `blame`, `get`. `assert.ts` gates
  against thresholds (recording *or* StepIndex), `diff.ts` compares two recordings.
- `commands/resolve.ts`: the `latest` keyword resolves via a pointer file
  (`recordings/.wpd-last.json`) that `record` writes — **never resolve recordings by
  mtime**.
- `output/format.ts`: every output supports JSON or TOON (`--format toon`); recordings are
  read back auto-detecting the format. `output/ascii.ts`: terminal tables/sparklines (ANSI-aware:
  widths are measured by *visible* length via `output/color.ts`'s `visibleLength`, so colored cells
  stay aligned). `output/color.ts`: TTY-aware ANSI helpers; **disabled by default** (the library
  stays plain when called directly, so unit tests and programmatic/agent use get no escape codes).
  Only `cli.ts` opts in, via a `preAction` hook resolving the global `--color auto|always|never`
  (auto = `isTTY && !NO_COLOR`). Structured `--json`/`--format` output never calls the helpers, so it
  is plain regardless. Color lives only in the human report/table builders (`commands/cpu.ts`,
  `commands/record.ts`): heat-colored `self %`, cyan packages, dimmed paths/source/secondary counts,
  bold headline numbers.

### CPU profiling (on by default; `--no-cpu-profile` opts out)

For JS cost (render/reconcile/hot loops), the V8 sampling profiler runs via CDP
`Profiler.start/stop` (`metrics/cdp.ts`), bracketed around the timed window like the CDP counters.
It **rides the timing pass** rather than a pass of its own (see Two-pass isolation above): no extra
flow replay, at the cost of ~10% on wall. `--no-cpu-profile` restores a pristine timing pass.
`profile/cpuprofile.ts` turns the raw `.cpuprofile` into a **resolved, self-contained `CpuModel`**
(per-function self/total time + a thresholded call graph), reusing `makeSourceResolver` +
`SourceMapResolver` for source attribution. Self time rolls up by **package** (`packageRollup`,
pnpm-safe: last `node_modules/<pkg>` segment, and monorepo workspace packages via nearest
`package.json` name) or **file** (`fileRollup`); `query cpu --by package|file|function` picks the
lens. Two files are written: the raw
`.cpuprofile` (DevTools/Speedscope) and `<base>.cpu.json` (the model, read by the verbs). Resolution
happens at record time because the served-server URL is ephemeral; the model is sized by function
count, not sample count. Verbs: `query cpu` (bounded overview), `query frame <id>` (callers/callees
from the model's edges), `cpu-diff` (per-function/per-module self-time deltas, noise-filtered).
Non-obvious: CDP callFrame line/column are **0-based** (converted to 1-based in `resolveCallFrame`,
unlike the 1-based trace stack frames); puppeteer harness frames are dropped via `isToolFrameUrl`.
`SourceMapResolver` handles three map sources: local sidecar `.map`, inline data-URI, and **remote**
(for `--url` sites, `frame.remote` set in `makeSourceResolver`) by fetching the script, reading its
`sourceMappingURL` **or its `SourceMap`/`X-SourceMap` response header** (production builds often
strip the comment and keep the header), and fetching the map (5s timeout). Minification is
irrelevant once the map resolves: a minified single bundle splits per package normally.
**ONE resolver per run**, constructed in `record()` and threaded through `runPass` ->
`attachStacks` (x2) and `buildCpuModel` (both take it as an optional param defaulting to a fresh
instance, so `runtime/node.ts` and programmatic callers are unaffected): it shares the cache (a
remote script+map is fetched once, not once per pass) and, critically, the **diagnostics**. Every
`loadMap` attempt records an outcome (`no-sourcemap-url` / `script-fetch-failed` /
`map-fetch-failed` / `map-parse-failed`); `maps.diagnostics()` returns them grouped by reason.
Swallowing a failure (a bare `catch { return null }`) makes it invisible, which reads as "the
feature does not exist": frames keep minified names and the per-package rollup silently reports one
bundle-shaped bucket. So `record()` mutates `meta.sourcemaps` + pushes a note (WARNING only when 0
of N resolved) **after** `buildCpuModel` but **before** any artifact is serialized -- that ordering
is load-bearing, since `meta` is shared by reference with every artifact. An unmapped remote frame
buckets by **origin** (`(cdn.example.com)`), never `"app"`: blaming unmapped third-party code on the
user's own bundle is exactly the mis-attribution `classifyPseudoUrl` already guards against. Local
source paths are resolved with a `/private` symlink fallback (`resolveOriginalSource`) because
bundlers record sources against the symlinked cwd while Node canonicalizes it; remote frames get
string-based package attribution (no fs). Resolved local source paths (`event.at`/`stack[].source` and cpu
`source`/`file`) are stored **relative to root** via `relativizeSource` *after* fs-dependent
resolution: smaller files, portable recordings, and stable `cpu-diff`/`functionJoinKey` joins across
machines (the `/private` mismatch stops breaking joins). `node:` builtins, remote urls, and paths
outside root stay absolute; artifact back-pointers (`recording`/`digest`/`profile`, the `latest`
pointer) stay absolute for cwd-independent re-opening -- but the terminal report prints them through
`displayPath` (relative to cwd when shorter). Display and storage answer different questions: stored
absolute so any cwd can reopen them, shown relative because an absolute path is noise to read and
puts your home directory into every pasted report, screenshot and recorded terminal. On-disk numbers are rounded to 4 decimals in
`serialize` (drops binary-float dust; the raw `.cpuprofile` is written via direct `JSON.stringify`
and stays exact). Display names prefer the sourcemap's original identifier (`pos.name`)
over the minified V8 name (kept as `CpuFunction.minified`), which also makes `cpu-diff` join stably
across different minified builds.

**Node runtime (`--target node`)**: a CPU-only lane that skips Chrome entirely. `runtime/node.ts`
(`recordNode`) imports the module *in this process* and profiles `run()` with node's built-in
`inspector` Session (`Profiler.start/stop` returns the same `RawCpuProfile` shape as CDP), bracketed
around the timed loop so only `run()` + callees are sampled. It reuses `buildCpuModel` unchanged via
`{ runtime: "node" }`, which swaps `makeSourceResolver` for `makeNodeSourceResolver` (rewrites
`file://` frames to local paths; `node:` builtins fall to the `(node)` package bucket in
`resolveCallFrame`). The tool's own loop frames are dropped by extending `isToolFrameUrl` to match
`/runtime/node.`. CPU-only means no Recording rendering counts: `recordAndReport` dispatches to
`recordNode` + `printNodeReport` (CPU headline + per-iteration timing, no DOM tables). The CLI sets
`runtime: "node"` from `--target node` and errors on browser-only flags (`--url/--html/...`).
`meta.runtime` records the lane; `meta.passes` is `["node-cpu"]`.

**Firefox backend (`--target firefox`)**: a second browser lane driven over WebDriver BiDi (no
CDP). `browser/backend.ts` `capsFor()` is a plain caps object (`cdpCounts/trace/throttle/
cpuProfile/geckoProfiler`) so `runPass` stays one function with capability guards, not a class
tree. `browser/launch.ts` returns `client: CDPSession | null` (null on firefox); every CDP call
site (`enableMetrics`/`snapshotMetrics`/throttle/`page.tracing`/`startCpuProfile`) is gated by the
caps or a null check (never `client!`), and `runDriver` takes a nullable client (per-step
`cdpDelta` becomes `{}`). Firefox has **no** CDP counters, trace, invalidationTracking, or
throttling; the CLI errors on those flags and `meta.notes` says so loudly (never fake zeros).
**INP is NOT in that list** — it never came from CDP, it is an in-page Event Timing observer in
`driver.ts`, ungated by caps, and it works. `meta.browser` is `"firefox"` (absent = chrome, so old
recordings stay valid).

Pass plan `["timing","gecko"]` (the gecko pass is not opt-in; the CLI refuses `--no-cpu-profile`
here, because without it a firefox recording reports every rendering count as 0). The **gecko pass** launches
Firefox with the Gecko profiler env vars, runs the flow, closes the browser (which flushes a
shutdown dump), then `waitForGeckoDump` polls the file to stable before parsing. The dump stays a
**path** on `PassResult` (never a retained string) and is `copyFile`d to the artifact: a 16M-entry
ring buffer serializes to a very large file (16MB+ even for a trivial probe). `--cpu-interval` (us)
is converted to Gecko's ms and clamped up to `GECKO_MIN_INTERVAL_MS`; `sampleIntervalUs` is read
back from the dump's `meta.interval` (what the sampler *actually* ran at), never hardcoded.

`profile/gecko.ts` converts the raw dump (v34) to a standard `RawCpuProfile` fed to `buildCpuModel`
unchanged, plus `NormalizedEvent[]` from Reflow/Styles markers shaped as `args.data.stackTrace` so
the existing `attachStacks`->`markForced`->blame pipeline works untouched. One gecko pass thus
yields CPU + blame. `parseGecko` **throws** on a missing `JavaScript` category or an empty thread
list: both would otherwise yield an empty-but-valid model reporting ~0 scripting time, the fake zero
this lane refuses to emit. `isToolFrameUrl` also drops `/__wpd_blank__` (BiDi attributes bench
harness frames to the served host page). Fixture: a trimmed real dump at
`test/fixtures/gecko-shutdown.trimmed.json`; e2e is self-skipping (`test/firefox.e2e.test.mjs`,
`npm run test:e2e:firefox`), NOT wired into `WPD_E2E_REQUIRED`.

**Before touching any of this, read [docs/dev/](docs/dev/README.md)** — the raw-format schemas, the
INP measurements, the Gecko<->Blink name map, and the two known-wrong-today behaviours
(Firefox blame names the write not the read; `forcedLayoutMs` under-reports ~7x) all live there with
the probes that establish them.

## Conventions / gotchas

- ESM throughout: relative imports **must** use `.js` extensions in `.ts` source (NodeNext).
- Naming is standardized on **layout** (not "reflow") everywhere except the idiom *forced
  reflow*; **paint** (not "repaint"). Don't reintroduce the old names.
- `EventKind` strings, the `wpd:*` mark namespace, and the trace category list are the
  coupling points across files; change them in one place (`classify.ts` / `categories.ts`).
- **No single-letter identifiers.** Locals, params, loop counters, `for...of`/`catch` bindings,
  destructured aliases, and sort-comparator params all get descriptive names (`event` not `e`,
  `group` not `g`, `frame` not `f`, `(left, right)` not `(a, b)`, `index` not `i`). This holds
  even inside browser-serialized functions (harness/driver/settle), where names don't affect
  serialization. Exported names, type names, and object property keys are exempt.
- **No em-dashes or AI-prose in comments.** Use ASCII punctuation (`:`, `;`, `()`, `.`) and keep
  comments terse and technical; drop chatty tells (`à la`, `Best-guess`, `Nudge the engine`).
  The standalone `"—"` used as a missing-value placeholder in table *output* is allowed.
- **No archeology.** Comments and docs describe the code as it is now, never how it used to be.
  Cut past-tense narration ("used to", "was null before", "until 0.5.0", "the bug this fixes",
  "measured before this was fixed"), version/PR numbers used as rationale, and incident logs.
  **Keep every `[measured]` number and the prohibition it justifies** -- those are why the code is
  the way it is -- but phrase them as present-tense constraints: "Never move `cpu` onto `traceSpec`:
  sampling during the trace pass inflates self-time +21%", not "it had its own pass until 0.5.0".
  The test: would someone implementing this from scratch today still write the sentence? If it only
  makes sense as "here is what we changed", it belongs in the changeset and the PR description,
  which is where history lives. This applies to `docs/dev/` too: state the finding, not its
  discovery story.
- Per the user's global rule: use `trash`, never `rm -rf`.
- **Changesets are release notes, not design docs.** A changeset becomes a `CHANGELOG.md` entry read
  by someone deciding whether to upgrade: say what changed, what breaks, and what to do about it.
  Budget **~5 lines, ~15 for a breaking change**. The reasoning (why the bug existed, what was
  measured, what was ruled out) belongs in the PR description and the code comments, both of which
  outlive the changeset. Lead with **Breaking:** where it applies, and order a release's changesets
  breaking-first.
- **Cross-engine / profiling work**: `docs/dev/` ([index](docs/dev/README.md)) holds the measured
  facts the code depends on but cannot state itself. Read the relevant one BEFORE touching that
  code: `gecko-profile-format.md` (raw v34 schemas, marker phases, cause-stack encoding, line/col
  base) for the Gecko converter; `engine-mapping.md` (Gecko<->Blink names, blame semantics, what is
  actually comparable) before any cross-engine claim; `cpu-profiling.md` (pass plan, sampler
  contamination, what `selfMs` includes) before changing passes or the interval;
  `rendering-counts.md` (what each count counts, which ones reproduce, why there is no composite
  count) before adding a name to `classify.ts` or gating a count; `frame-floor.md` (the one-frame
  floor on `wall`/`INP`, and why the headless mode sets its height) before changing the headless
  option or adding a headless flag.
- **Claims about engine behaviour need a probe, not a mechanism.** A plausible mechanism is not
  evidence, however obviously true it reads: sourcemaps, INP, Gecko cause stacks and sampler
  isolation all behave in ways a mechanism alone predicts wrongly. Run `examples/forces-layout.mjs`
  in both engines and look at the output before writing the sentence (`docs/dev/README.md` has the
  rule and its corollaries).

## Regenerating the README demo (`examples/demo-gif/`)

The README hero is a [VHS](https://github.com/charmbracelet/vhs) terminal recording. The tape and a
how-to live in `examples/demo-gif/` (`demo.tape` + `README.md`); the rendered `demo.gif` is
git-ignored and hosted via a GitHub user-attachments URL (not committed, so the npm tarball stays
lean). **See `examples/demo-gif/README.md` for the render/publish steps.** Internal notes below.

What it shows: the `--target node` CPU lane attributing SSR `renderToString` self-time to
`react-dom` vs a styling library vs your component, down to a source line, via `query cpu`. It runs
**`examples/ssr-demo`** (in this repo, JSX-free so no build step): `react-dom` ~44% vs
`tailwind-merge` ~22% vs `app` ~9%, with `tailwind-merge get (lib/lru-cache.ts:35)` the single
hottest function (~21%) as the punchline.

**Keep this demo runnable from a clean checkout**; that property is the point, not the exact
percentages. A demo that depends on a pre-compiled bundle from a private repo can only be
re-rendered by one person on one machine, and rots unnoticed until the published GIF demonstrates a
flag that no longer exists.

Tape gotchas, if you tweak `demo.tape`:

- **`Sleep` must outlast the process.** VHS fires the next keystroke after the `Sleep`, not when
  the command exits. The `record` step needs a Sleep longer than its real runtime (~a few seconds).
- **`--iterations 250`** is about `(node) post (node:inspector)`, the profiler's own cost on this
  lane. It is a **fixed ~23ms** regardless of workload, so the only way to shrink it is more real
  work: at 80 iterations it is the single hottest function (~18-46%) and buries the punchline; at
  250 it drops to ~7% and `tailwind-merge get` takes the top row. If you shrink the workload, re-check
  that row before publishing.
- **`NODE_ENV=production` is load-bearing** (hidden in the tape). Without it React resolves to its
  development build: `react` outranks `react-dom`, and the profile shows a cost nobody ships.
- **`FontSize 18` + `Width 1580`** avoid clipping; the widest line is the `record` report's longest
  dimmed file-path + annotation (`Digest: ... rendering metrics are not collected`), not the table.
  Those paths print relative to cwd (`displayPath`), which is what keeps them on one line -- absolute
  paths wrap, and put the recorder's home directory into the GIF.
- The record output is wiped with a hidden `clear` before `query cpu` so the final frame focuses on
  the result alone.
- **Color is automatic**: VHS records in a real PTY, so `process.stdout.isTTY` is true and the
  default `--color auto` colorizes (heat-colored `self %`, cyan packages, dimmed paths/source/`fns`,
  bold headline). No flag in the tape, and real terminals get the same.
- The GIF (~300K) ships as-is; `gifsicle -O3` shrinks it losslessly if ever needed (WebP saved only
  ~10%, not worth a second artifact).
