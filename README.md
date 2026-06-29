# @jantimon/web-performance-debugger

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/2375c323-59f5-4e65-9b21-3eef00a59281"
    alt="wpd query cpu attributes SSR renderToString self-time to react-dom, the styling library (tailwind-merge), and your component, each down to a source line"
    width="900">
</p>

Trace every rendering and JS cost back to the **source line** that caused it, with numbers you can
trust. It drives real Chrome (or pure Node), runs headless, and is built to gate in CI.

Run it with `npx @jantimon/web-performance-debugger ...`, or install it and use the short `wpd`.

## Requirements

- **Node 24+.**
- **Chrome** is downloaded automatically by Puppeteer on install. To skip the browser entirely, use
  the `--runtime node` lane (CPU profiling only, no DOM/layout/paint).
- For `--url`, **your dev/preview server must already be running** at that URL; wpd does not start it.
- Modules and `--html` files must live **under the current working directory** (they are served to
  the browser from there).

## 30-second quickstart

```bash
# 1. forced-layout (thrashing) attribution, in-page:
npx @jantimon/web-performance-debugger record probe.mjs --bench --iterations 5
npx @jantimon/web-performance-debugger query blame latest --forced

# 2. pure-JS cost, no browser:
npx @jantimon/web-performance-debugger record render.entry.js --runtime node --iterations 50
npx @jantimon/web-performance-debugger query cpu latest
```

`record` writes a small **digest** plus a `latest` pointer; the `query` verbs read `latest` (or any
file path). Start at the digest, then drill in by id.

## Which problem do you have?

| Symptom | Start here |
| --- | --- |
| A page janks on a click or interaction | `record` a flow, then `query index` |
| A line forces synchronous layout (thrashing) | `query blame --forced` |
| SSR or a hot JS loop is slow | `record --runtime node` |
| Which dependency dominates CPU time | `query cpu` |
| Did my change regress a budget | `assert`, `diff`, `cpu-diff` |

Each section below is one of these problems: reproduce it, read the result, fix the line.

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
─────  ─────  ────────────  ─────────────────
200    12.4   style,layout  probe.mjs:5:10
```

Line 5, `void el.offsetWidth`, caught red-handed. `blame --all` lists every attributed line with a
`forced` column, so "ran but never forced" is a real answer too, not a guess.

## A page janks on a real interaction

By default `record` drives the page through Puppeteer: your `run` receives `{ page, ctx, measureStep }`,
and each `measureStep` becomes one report (counts plus INP).

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

Works against `--url` (any local or remote server) or `--html somefile.html`. Each step also gets its
own digest you can drill into.

**Behind a login?** Add `--no-headless` to sign in by hand and `--user-data-dir ./.wpd-profile` to
persist that session (without it, the default two-pass run opens a fresh browser per pass and makes
you log in twice). Gate the login in your driver so it only waits when not yet authenticated, and do
any iframe/list waiting there too.

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
resolves `node_modules` directly without bundling to a browser module.

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

```bash
wpd record render.entry.js --runtime node --iterations 50
# hot functions + by-package rollup
wpd query cpu   latest
# drill one function: callers + callees      
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
share of that self-time.

Need the browser's V8 instead (the code touches the DOM, or you want it where it ships)? Bundle to
one ESM module with sourcemaps and use `--bench --cpu-profile`:

```bash
esbuild render.entry.js --bundle --format=esm --sourcemap \
  --define:process.env.NODE_ENV='"production"' --outfile=render.mjs
wpd record render.mjs --bench --cpu-profile --iterations 50
```

Either lane writes a `.cpu.json` model (read by the verbs) and a raw `.cpuprofile` that opens in
Chrome DevTools (Performance, Load profile) or Speedscope. On a `--url` site each remote bundle's
sourcemap is auto-fetched from its `sourceMappingURL`; with no map you still get a ranked
hot-function list, just without per-package attribution. For compile-time CSS-in-JS (next-yak,
Linaria, ...) bundle from your build's already-compiled output, not raw source: wpd profiles what you
ship.

## Did my change regress a budget

`assert` fails the build when a budget is blown; `diff` and `cpu-diff` compare two recordings.

```bash
# exit 1 on violation:
wpd assert  latest --max-forced 0 --max-inp 200      
wpd diff     before.json after.json --fail-on-regression
# per-function self-time deltas, noise filtered
wpd cpu-diff before.json after.json --fail-on-regression   
```

Give each run a name with `--out` so you can compare by path instead of `latest`:

```bash
wpd record a.mjs --runtime node --out runs/a
wpd record b.mjs --runtime node --out runs/b
wpd cpu-diff runs/a runs/b
```

## Read a result

`record` prints a summary and tells you what to look at next (for example, `⚠ layout thrashing: run
query blame --forced`). A full recording can be megabytes, so drill from the small digest by event
id. `latest` always points at your most recent run.

```bash
# summary + thrashing + long tasks + slowest events
wpd query digest latest            
# rendering work grouped by source line
wpd query blame  latest --forced   
wpd query events latest --kind task --top 10
# one event: full stack + args
wpd query get    latest 42         
```

## Reference

### The three lanes

| Lane | Flag | `run` contract | Measures |
| --- | --- | --- | --- |
| driver | (default) | `run({ page, ctx, measureStep })` in Node | rendering work + INP per step; cold boot |
| bench | `--bench` | `run()` inside the page | rendering work + CPU, iterated in isolation |
| node | `--runtime node` | `run()` in this Node process | CPU self-time only (no DOM) |

`--iterations` / `--warmup` apply to `bench` and `node`. All lanes support optional `prepare` /
`cleanup` exports (aliases `setup` / `teardown`).

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
`--format` only).

Human output is colorized when stdout is a terminal. Control it with `--color auto|always|never`
(default `auto`); `NO_COLOR` is honored, and piped, redirected, and `--json`/`--format` output is
always plain, so CI and scripts are unaffected.

### The numbers, and how far to trust them

| Signal | Source | Trust |
| --- | --- | --- |
| Counts (layout / paint / style / invalidation) | CDP | exact: compare freely |
| Wall and INP times | `performance.now()`, Chrome-clamped | directional: good for "~2x worse?", not "1.3 ms" |
| CPU self-time | the V8 sampler's own microsecond clock | real: trustworthy in aggregate (a few % noise) |

To keep timing honest, `record` runs twice by default: once with tracing off (clean timing) and once
with full instrumentation (the counts and source attribution). `--cpu-profile` adds a third, isolated
sampling pass. `--no-isolate` collapses to one faster but noisier pass. Slow things down to surface
jank with `--cpu-throttle 4` or `--network slow-3g`.

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
types are covered by semver; breaking field changes ship as a major (`SCHEMA_VERSION`).
