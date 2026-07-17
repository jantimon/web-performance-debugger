# @jantimon/web-performance-debugger

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/2375c323-59f5-4e65-9b21-3eef00a59281"
    alt="wpd query cpu attributes SSR renderToString self-time to react-dom, the styling library (tailwind-merge), and your component, each down to a source line"
    width="900">
</p>

Trace every rendering and JS cost back to the **source line** that caused it, with numbers you can
trust. It drives real Chrome or Firefox (or pure Node), runs headless, and is built to gate in CI

Run it with `npx @jantimon/web-performance-debugger ...`, or install it and use the short `wpd`

## Requirements

- **Node 24+**
- **Chrome** is downloaded automatically by Puppeteer on install. To skip the browser entirely, use
  the `--runtime node` lane (CPU profiling only, no DOM/layout/paint)
- **Firefox** is optional (`--browser firefox`): install it once with
  `npx puppeteer browsers install firefox`. See
  [What each target gives you](#what-each-target-gives-you)
- For `--url`, **your dev/preview server must already be running** at that URL; wpd does not start it
- `--html` files, and `--bench` modules, must live **under the current working directory** (they are
  served to the browser from there). Driver and `--runtime node` modules are imported in Node and can
  live anywhere

## 30-second quickstart

Every run starts from a small JS file you write that exports a `run` function (the contract:
[Your `run` module](#your-run-module)). Pick the lane by what you are measuring:

- **A real user flow in a real app** → the default **driver** lane: `run` gets a Puppeteer `page`
  and drives your `--url`
- **An isolated DOM-touching snippet** → `--bench`: `run` executes inside the page, repeated with
  `--iterations`
- **Pure JS, no DOM (SSR, hot loops)** → `--runtime node`: no browser at all

```bash
# 1. forced-layout (thrashing) attribution, in-page:
npx @jantimon/web-performance-debugger record probe.mjs --bench --iterations 5
npx @jantimon/web-performance-debugger query blame latest --forced

# 2. pure-JS cost, no browser:
npx @jantimon/web-performance-debugger record render.entry.js --runtime node --iterations 50
npx @jantimon/web-performance-debugger query cpu latest
```

By default `record` runs your flow **twice**: once with tracing off for clean timing, once fully
instrumented for counts and attribution (that split is why the numbers stay honest, see
[the trust table](#the-numbers-and-how-far-to-trust-them)). It writes into `./recordings/` (or
name the run with `--out`): the full recording (`<timestamp>.json`), a small **digest** next to it
(the summary and worst offenders, each carrying an `id` to drill into), a `.cpu.json` model when
CPU profiling, and a per-step index for driver runs. A `latest` pointer tracks the newest run, so
every `query` verb accepts `latest` instead of a file path. Start at the digest, then drill in by
id

## Your `run` module

`record <module>` takes a plain JS file and imports it as an ESM module (`.mjs`, or `.js` in a
`"type": "module"` package). It is not a script that runs top-to-bottom: wpd calls the hooks it
exports, so only `run` is measured. It can export up to three hooks:

```js
export async function prepare(arg) {} // optional, before the measured window (alias: setup)
export async function run(arg) {}     // the measured part
export async function cleanup(arg) {} // optional, after the window (alias: teardown)
```

`prepare` and `cleanup` run **outside** the measured window, so setup and teardown never pollute
the numbers: once around all `--iterations`, per pass. Because `record` replays the whole flow for
each of its 2-3 passes, hooks should be idempotent (safe to run again on a fresh browser). All
three hooks receive the same argument, which depends on the lane. Note the asymmetry: in driver
mode `ctx` is a *property* of the argument; in the other lanes it *is* the argument

- **driver** (default): `run({ page, ctx, measureStep })` executes in Node, `page` is a Puppeteer page
- **`--bench`**: `run(ctx)` executes inside the browser page, with live `document`/`window`
- **`--runtime node`**: `run(ctx)` executes in this Node process

`ctx` starts as an empty object and is shared across the hooks: stash things in `prepare` (a
handle, a prebuilt DOM node, test data) and read them in `run`. `--iterations` / `--warmup`
(defaults 1 / 0) repeat `run` in the bench and node lanes and are **ignored in driver mode** (a
driver flow runs once per pass); `record` prints a note if you pass them anyway

In `--bench` the module is imported *inside the page*, so it must live under the current working
directory to be servable. Driver and `--runtime node` modules are imported in Node and can live
anywhere

## Which problem do you have?

| Symptom | Start here |
| --- | --- |
| A page janks on a click or interaction | `record` a flow, then `query index` |
| A line forces synchronous layout (thrashing) | `query blame --forced` |
| SSR or a hot JS loop is slow | `record --runtime node` |
| Which dependency dominates CPU time | `query cpu` |
| Did my change regress a budget | `assert`, `diff`, `cpu-diff` |

Each section below is one of these problems: reproduce it, read the result, fix the line

### Compared to the tools you already have

- **Chrome DevTools**: the same underlying data, but scripted and repeatable instead of a manual
  session, and already attributed to source lines instead of a flame chart to read. When you do
  want the flame chart, the raw `.cpuprofile` wpd writes opens right in DevTools
- **Lighthouse**: audits a page load and scores it. wpd measures the specific interaction or
  module *you* define, names the source line responsible, and fails CI when it regresses
- **React Profiler**: component-level render timing inside React. wpd is framework-agnostic
  self-time across the whole stack (react-dom, your styling library, your code, each as its own
  bucket), plus rendering signals React cannot see, like forced layout

## A line forces synchronous layout

Reading geometry (`offsetTop`, `getBoundingClientRect`, ...) right after a DOM write forces a
synchronous reflow. `--bench` runs a module's `run()` inside the page, so you can reproduce the work
in isolation:

```js
// probe.mjs
export function run() {
  const el = document.body.appendChild(document.createElement("div"));
  for (let i = 0; i < 100; i++) {
    el.style.width = i + "px"; // write
    void el.offsetWidth;       // read -> forced layout
  }
}
```

```bash
wpd record probe.mjs --bench --iterations 5

wpd query blame latest --forced
```

```
count  ms     kinds         source
─────  ─────  ────────────  ──────────────
1000   9.97   style,layout  probe.mjs:6:13
```

Line 6, `void el.offsetWidth`, caught red-handed: 100 loop reads forcing style + layout, times 5
iterations. `blame --all` lists every attributed line with a `forced` column, so "ran but never
forced" is a real answer too, not a guess

## A page janks on a real interaction

By default `record` drives the page through Puppeteer: your `run` receives `{ page, ctx, measureStep }`,
and each `measureStep` becomes one report: counts plus INP (Interaction to Next Paint, the time
from the interaction until the next frame reaches the screen)

```js
// flow.mjs
export async function run({ page, measureStep }) {
  await measureStep("open menu", () => page.click("#menu"));
  await measureStep("type query", () => page.type("#search", "shoes"), {
    until: "#results", // selector, async fn, or promise; omit for a rAF+idle settle
  });
}
```

```bash
wpd record flow.mjs --url http://localhost:3000

wpd query index latest
```

```
#  label       wall ms  inp ms  layout  forced  paint  layoutInval
0  open menu   31.2     24      3       0       5      4
1  type query  88.6     56      9       2       18     12
```

`wall ms` is the whole step (action + settle); `inp ms` is the user-perceived latency inside it. A
step can have a long wall but a fine INP when the work happens off the interaction path

Omitting `until` waits for the page to **settle**: two animation frames, each followed by an idle
callback, which covers the usual state-update → render → cleanup pattern. Pass `until` when your
step ends on something specific: a selector to wait for, or a function or promise that wpd simply
awaits

Works against `--url` (any local or remote server) or `--html somefile.html`. Each step also gets its
own digest you can drill into

**Behind a login?** Add `--no-headless` to sign in by hand and `--user-data-dir ./.wpd-profile` to
persist that session (without it, the default two-pass run opens a fresh browser per pass and makes
you log in twice). Gate the login in your driver so it only waits when not yet authenticated, and do
any iframe/list waiting there too

Make a `page.goto` its own step to measure a **cold boot**. Drop `--url` so the page starts blank
(otherwise it pre-navigates before tracing); everything from navigation through first render lands in
that step:

```js
export async function run({ page, measureStep }) {
  await measureStep("boot", () => page.goto("http://localhost:3000", { waitUntil: "load" }), {
    until: "#app", // wait for your mounted root; omit for a rAF+idle settle
  });
}
```

## SSR or a hot JS loop is slow

When the cost is JavaScript, profile self-time per function and per package. `--runtime node` runs
`run()` in this Node process (no browser, no DOM): that is where SSR runs in production, and it
resolves `node_modules` directly without bundling to a browser module

```js
// render.entry.js
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import Page from "./your-compiled-output.js";

export function run() { 
  for (let i = 0; i < 50; i++) 
    renderToString(createElement(Page)); 
}
```

In a real app, `./your-compiled-output.js` is your component compiled to plain JS (node can't
import JSX/TS directly). Any bundler works; the requirements are plain ESM output, a sourcemap
(for line attribution), and dependencies kept **external**, so node resolves `react-dom` & co from
`node_modules` and wpd attributes them per package (a bundled-in dependency gets blamed on your
app bucket instead). With esbuild:

```bash
esbuild src/pages/Product.tsx --bundle --packages=external --platform=node \
  --format=esm --sourcemap --outfile=your-compiled-output.js
```

```bash
wpd record render.entry.js --runtime node --iterations 50
# hot functions + by-package rollup
wpd query cpu   latest
# drill one function; 0 = the id column of `query cpu`
wpd query frame latest 0  
```

```
CPU profile: 268.4 ms JS self-time, sampled · 5360 samples

package    self ms  self %  fns
─────────  ───────  ──────  ───
react-dom  171.2    63.8%   38
next-yak   31.7     11.8%   9
app        24.1     9.0%    12

id  self ms  self %  total ms  package    function (source)
0   88.4     32.9%   96.8      react-dom  renderToString (react-dom-server.js:4123)
```

The headline (`268.4 ms JS self-time`) is the **total** JS self-time across all sampled iterations
(here, 50), not a per-iteration or mean figure; divide by `--iterations` for a per-call cost. Because
it is a total, comparing two builds is only fair when both runs use the **same `--iterations` and
`--warmup`** (warmup iterations are excluded from the sampled window). `self %` is each function's
share of that self-time. In the sample, `next-yak` is a compile-time CSS-in-JS dependency and
`app` is your own code

Two lanes measure CPU self-time; pick by where the code runs in production:

| Your code | Lane |
| --- | --- |
| Pure JS that runs in Node in production (SSR, tooling) | `--runtime node` |
| JS that touches the DOM, or that ships to the browser | `--bench --cpu-profile` |

For the browser lane, bundle to one ESM module with sourcemaps:

```bash
esbuild render.entry.js --bundle --format=esm --sourcemap \
  --define:process.env.NODE_ENV='"production"' --outfile=render.mjs
wpd record render.mjs --bench --cpu-profile --iterations 50
```

Either lane writes a `.cpu.json` model (read by the verbs) and a raw `.cpuprofile` that opens in
Chrome DevTools (Performance, Load profile) or Speedscope. On a `--url` site each remote bundle's
sourcemap is auto-fetched (from its `sourceMappingURL` comment, or the `SourceMap` response header
if the build stripped the comment), so **minification is not a problem**: a minified single bundle
still splits per package, as long as its map is reachable. See
[When per-package attribution can't work](#when-per-package-attribution-cant-work) for when it isn't.
For compile-time CSS-in-JS (next-yak, Linaria, ...) bundle from your build's already-compiled output,
not raw source: wpd profiles what you ship

### When per-package attribution can't work

Splitting a bundle by package needs its sourcemap. When a map can't be fetched, wpd says so instead
of guessing: the run prints a `Sourcemaps: 0/1 resolved` line, `meta.sourcemaps` records every
script it tried and why each failed, and the affected frames are bucketed by **origin**
(`(cdn.example.com)`) rather than blamed on your `app`:

```
package            self ms  self %  fns
─────────────────  ───────  ──────  ───
(127.0.0.1:51986)  7.5      6.2%    64
Sourcemaps: 0/1 resolved  ← no-sourcemap-url — packages below are minified bundles, not real packages
```

| `meta.sourcemaps.failed` reason | What to do |
| --- | --- |
| `no-sourcemap-url` | The bundle has no `sourceMappingURL` comment and no `SourceMap` header. Turn sourcemaps on in your production build, or serve the header |
| `map-fetch-failed` | It names a `.map` that isn't deployed (commonly uploaded to an error tracker instead). Serve it, even if only on a preview deploy |
| `script-fetch-failed` | wpd couldn't fetch the script itself: auth, CORS, or bot protection. Profile a preview deploy without the gate |
| `map-parse-failed` | The `.map` isn't a readable sourcemap |

A partial failure is normal and healthy: third-party scripts (analytics, chat widgets) rarely ship
maps, and bucketing them by origin is the honest answer — their cost is real, but it is not yours.
Only `0 of N` means the package table can't be believed at all

## Did my change regress a budget

`assert` fails the build when a budget is blown; `diff` and `cpu-diff` compare two recordings.
Name each run with `--out` (the recording is written to exactly that path; the digest and the
`.cpu.json` model land next to it), or just rely on `latest`:

```bash
wpd record probe.mjs --bench --out runs/before.json
# ...apply your change, rebuild...
wpd record probe.mjs --bench --out runs/after.json

# exit 1 on violation:
wpd assert   latest --max-forced 0 --max-inp 200
wpd diff     runs/before.json runs/after.json --fail-on-regression
# per-function self-time deltas, noise filtered
wpd cpu-diff runs/before.json runs/after.json --fail-on-regression
```

## Read a result

`record` prints a summary and tells you what to look at next (for example, `⚠ layout thrashing: run
query blame --forced`). A full recording can be megabytes, so drill from the small digest by event
id. For the thrashing probe above, `query digest latest` prints (trimmed):

```
Hotspots

forced layout/style      1000  (9.97 ms)
long tasks ≥50ms         0  (longest 5.6 ms)
wall                     18.09 ms
  ⚠ layout thrashing — run `query blame --forced` to see the source lines

Layout thrashing — forced layout/style by source:
count  ms    source
─────  ────  ──────────────
1000   9.97  probe.mjs:6:13

Slowest events:
id    kind   name              ms     source
────  ─────  ────────────────  ─────  ──────────────
100   style  UpdateLayoutTree  0.984  probe.mjs:6:13
```

Every row carries an `id`: `query get latest 100` prints that `UpdateLayoutTree` event with its
full stack and args

```bash
# summary + thrashing + long tasks + slowest events
wpd query digest latest            
# rendering work grouped by source line
wpd query blame  latest --forced   
wpd query events latest --kind task --top 10
# one event: full stack + args (the id comes from the digest or an events row)
wpd query get    latest 100        
```

## Reference

### What each target gives you

wpd is additive: the core promise (attribute cost to the source line that caused it) works
everywhere, and each richer target stacks more signals on top

**Target Node (`--runtime node`), no browser at all:** CPU self-time attributed to source line,
file, and owning package, plus per-iteration timing and `cpu-diff` regression gates. If your cost
is pure JS (SSR, hot loops), this is already the whole story

**Target a browser (`--browser chrome`, default, or `--browser firefox`): all of that, plus the
real DOM.** Drive real user flows (`measureStep`) or benchmark DOM-touching modules in-page
(`--bench`), measure wall time per step, take screenshots, and get **forced layout/style blame**
pointing at the offending statement. The same modules, recording format, and query verbs work in
both browsers, so you can verify an optimization in both engines instead of tuning for a Chromium
quirk. On Firefox, **add `--cpu-profile`** — without it a Firefox run measures timing only. It also
writes `<base>.geckoprofile.json`, ready to open at profiler.firefox.com

**Target Chrome: all of that, plus the exact CDP layer on top** (the last rows below). The flags
that need CDP error out on other targets, and a Firefox recording names in `meta.notes` both what
it measured differently and what it did not measure at all. Read that note before trusting a
number: a metric Firefox cannot measure is currently reported as **`0`**, which looks identical to
a genuinely clean run

| Signal | node | firefox | chrome |
| --- | --- | --- | --- |
| CPU self-time by package / file / function | ✓ (V8) | ✓ (Gecko) | ✓ (V8) |
| Wall / per-iteration timing | ✓ | ✓ | ✓ |
| Real user flows, in-page bench, screenshots | — | ✓ | ✓ |
| Forced layout/style blame to source | — | ✓ (with `--cpu-profile`) | ✓ |
| INP per step | — | ✓ | ✓ |
| Layout / style / forced-layout counts | — | ~ (Gecko, with `--cpu-profile`) | ✓ (CDP) |
| Paint / composite counts + invalidation rollup | — | — | ✓ (CDP + trace) |
| Long tasks | — | — | ✓ |
| `--cpu-throttle` / `--network` slowdowns | — | — | ✓ |

`~` means measured, but not by the same mechanism: Firefox counts layout/style from the Gecko
profiler's Reflow/Styles markers rather than CDP counters, and Gecko batches layout differently
than Blink. Those counts are real and useful **against another Firefox run**; comparing them to
Chrome's counts compares two different definitions. Everything marked `—` is reported as `0` on
that target

**Forced-layout blame currently answers a different question per engine.** Chrome names the
geometry **read** that forced the flush (`el.offsetWidth`). Firefox names the **write** that dirtied
the DOM (`el.style.width = ...`), because Gecko records who invalidated rather than who forced. Both
are real lines in your thrashing loop, but they are not the same line, so **do not diff the two
engines' `blame` tables against each other**. Firefox's forced-layout *milliseconds* also
under-report. Until this is fixed, `query cpu` is the better cross-engine view of forced layout: it
prices the forcing line on both engines and the two agree closely

INP comes from an in-page Event Timing observer, so **both engines measure it** (long tasks do not:
they are counted from the DevTools trace, which Firefox has no equivalent of). Both span the
interaction through the next paint and round to 8 ms, but they are **not interchangeable**: for
identical work Firefox reports a systematically lower number than Chrome, because presentation delay
is genuinely engine-specific. Compare a browser against itself across your change, not one engine
against the other

```bash
# the same probe in both engines. Compare each engine against ITSELF across your change;
# `query cpu` (not `blame`) is what lines up between the two — see the note above:
wpd record examples/forces-layout.mjs --bench --cpu-profile
wpd query cpu latest

wpd record examples/forces-layout.mjs --bench --cpu-profile --browser firefox
wpd query cpu latest
```

### The query verbs

| Verb | Shows |
| --- | --- |
| `digest <file>` | entry point: summary, thrashing, long tasks, slowest events |
| `index <file>` | per-step table (driver runs) |
| `events <file>` | the classified event log (`--kind`, `--name`, `--forced`, `--top`, `--sort`) |
| `blame <file>` | events grouped by source line (`--forced`, `--all`, `--kind`, `--top`) |
| `get <file> <id>` | one event, full stack and args |
| `cpu <file>` | hot functions + rollup (`--by package\|file\|function`, `--top`) |
| `frame <file> <id>` | one CPU function: its callers and callees |

Any `<file>` may be `latest`. Verbs emit JSON with `--json` or `--format toon` (`get` takes
`--format` only)

Human output is colorized when stdout is a terminal. Control it with `--color auto|always|never`
(default `auto`); `NO_COLOR` is honored, and piped, redirected, and `--json`/`--format` output is
always plain, so CI and scripts are unaffected

### The numbers, and how far to trust them

| Signal | Source | Trust |
| --- | --- | --- |
| Counts (layout / paint / style / invalidation) | CDP | exact: compare freely |
| Wall and INP times | `performance.now()`, browser-clamped | directional: good for "~2x worse?", not "1.3 ms" |
| CPU self-time | the sampler's own clock (V8 microsecond; Gecko ~1 ms floor on Firefox) | real: trustworthy in aggregate (a few % noise) |

**In a browser, `self ms` is not only JavaScript.** It is your JS *plus the synchronous engine work
that JS triggered*: force a layout by reading `offsetWidth`, and the reflow is billed to the line
that read it. That is usually what you want — it prices "what do I save by deleting this line?" —
and it is why a `query cpu` row can dwarf the JavaScript actually on that line. `--runtime node` has
no DOM, so there it really is pure JS.

The two default passes exist to keep this table honest: heavy instrumentation distorts timing, so
timing is measured with tracing off and the counts/attribution in a separate instrumented pass.
`--cpu-profile` adds a third, isolated sampling pass; `--no-isolate` collapses everything into one
faster but noisier pass. Slow things down to surface jank with `--cpu-throttle 4` or
`--network slow-3g`

**`summary.wallMs` is not your interaction.** It is the whole `wpd:run` window of one pass:
navigation, `prepare`, every step, and the `--settle` wait. On a driver flow that is routinely
orders of magnitude larger than the thing you clicked. For per-interaction wall read
`summary.perStep` (labelled, one entry per `measureStep`) or `query index`, both of which report
each step's own window:

```json
"perStep": [
  { "label": "open menu",  "perIteration": [31.2], "stats": null },
  { "label": "type query", "perIteration": [88.6], "stats": null }
]
```

Each step keeps its **raw samples** rather than only a statistic, and aggregates only against
itself: `stats` is that step's own min/median/mean/max, `null` below 2 samples. There is
deliberately no median *across* steps — "mount" and "inp" measure different work, so pooling them
would produce a real-looking number that means nothing. A driver flow runs once per pass today, so
`perIteration` holds one sample per step; treat it as directional, not a precise median. In
`--bench` / `--runtime node`, `--iterations` fills the top-level `summary.perIteration` /
`summary.stats` instead, and those stay empty in driver mode

### Consuming the JSON

Every artifact and `--format json|toon` output is typed. Import the types from the package root:

```ts
import type { CpuModel, Recording, Digest, CpuOverview } from "@jantimon/web-performance-debugger";

const model: CpuModel = JSON.parse(await readFile("run.cpu.json", "utf8"));
```

| File / output | Type |
| --- | --- |
| `.cpu.json` (CPU model) | `CpuModel` (functions: `CpuFunction`, edges: `CpuEdge`) |
| recording `.json` / `.toon` | `Recording` (events: `NormalizedEvent`) |
| `.digest.json` | `Digest` |
| `.index.json` (stepped runs) | `StepIndex` |
| `query cpu` / `frame` / `blame` | `CpuOverview` / `FrameQueryResult` / `BlameEntry[]` |
| `cpu-diff` | `CpuDiffResult` |
| `query get` / `events` | `NormalizedEvent` / `NormalizedEvent[]` |

Notes: `selfMs`/`scriptingMs`/etc. are rounded to 4 decimals on disk (the raw `.cpuprofile` stays
exact); TOON encodes the same shape, so the same types apply. Source paths (`source`/`file`/`at`) are
relative to the recording root; back-pointers (`profile`/`recording`) are absolute. These root-level
types are covered by semver; breaking field changes ship as a major (`SCHEMA_VERSION`)
