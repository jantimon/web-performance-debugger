# @jantimon/web-performance-debugger

[![npm version](https://img.shields.io/npm/v/@jantimon/web-performance-debugger)](https://www.npmjs.com/package/@jantimon/web-performance-debugger)
[![CI](https://github.com/jantimon/web-performance-debugger/actions/workflows/ci.yml/badge.svg)](https://github.com/jantimon/web-performance-debugger/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@jantimon/web-performance-debugger)](https://www.npmjs.com/package/@jantimon/web-performance-debugger)
[![license](https://img.shields.io/npm/l/@jantimon/web-performance-debugger)](https://github.com/jantimon/web-performance-debugger/blob/main/LICENSE)

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/9da693d1-b04f-4a72-b971-f2886df14742"
    alt="A browser window, an arrow to a terminal running wpd record --breakdown, an arrow to a stacked bar of style, layout, js and other slices, captioned: the sum of slices plus idle equals wall"
    width="900">
</p>

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/8fb5cea7-c51a-41b7-b834-2e5cf2cc3d0b"
    alt="wpd query cpu attributes SSR renderToString self-time to react-dom (43.8%), the styling library tailwind-merge (24.2%), and your own component, each down to a source line — the hottest function is tailwind-merge's LRU cache lookup at lib/lru-cache.ts:35"
    width="900">
</p>

`wpd` measures where a page's time goes and names the source line responsible. Every number says how
it was measured and how far to trust it. It drives real Chrome or Firefox (or pure Node)
and attributes **layout, paint, style, and invalidation work — plus CPU self-time — back to the source
line that caused it**. It **finds and
investigates**; it does not grade, rank, or recommend. So it is not Lighthouse and not a
website-comparison tool: it hands you exact, measurement-tagged numbers and the JSON to act on them,
and the judgment stays with you.

<p align="center">
  <img src="https://github.com/user-attachments/assets/25d1e68e-dcb6-4fca-b57a-75561f6342f8" alt="Chrome logo, hand-drawn" height="64">
  <img src="https://github.com/user-attachments/assets/dafc7978-b897-443a-a999-92d8b70572ff" alt="Firefox logo, hand-drawn" height="64">
  <img src="https://github.com/user-attachments/assets/41fc3dfd-61e2-4edd-a1e2-22127b29b02e" alt="Node.js logo, hand-drawn" height="64">
</p>

It decomposes one measured span into slices that tile it exactly:

```
run (run, 5.9 ms, sum of 5 iterations)
slice   ms   %
──────  ───  ─────  ───────────────────────────────
js      2.3  39.3%  wpd-examples 2.3
style   1.4  23.9%
layout  2.1  36.3%
paint   0    0%
gc      0    0%
other   0    0.5%   (task remainder + unclassified)
idle    0    0%     (waiting, not work)
```

`Σ slices + idle = wall`, exactly. No unexplained time: JS is split by owning package, style and
layout carry real milliseconds, and the part that was just waiting for the next frame is `idle`, not
a vague "browser" bucket that reads like work. Above is a real forced-layout probe, so style + layout
dominate; on a typical interaction most of the wall is `idle` (the frame wait) and `wpd` says so.

## Install

```bash
npm i -g @jantimon/web-performance-debugger   # installs the `wpd` command (long form: `web-performance-debugger`)
# or run without installing:
npx @jantimon/web-performance-debugger record --url http://localhost:5173 --breakdown
```

Needs **Node 24+**. Chrome downloads on install (skip it with the CPU-only `--target node` lane);
Firefox is optional. The pnpm caveats and how to point wpd at your own browser are in
[Requirements](#requirements).

## At a glance

- **Names the line a grade can't:** a page score like Lighthouse tells you the page is slow, not which
  line of your code made it slow. wpd decomposes one real interaction, page load, or SSR render into
  slices that tile the wall exactly (`Σ slices + idle = wall`), and names the source line, package, and
  count behind each -- across Chrome, Firefox, and Node. Forced layout, CPU self-time, allocation, and
  rendering counts, attributed to code, not graded.
- **How far to trust each number:** every load-bearing figure is measured in both engines, tagged with
  its source and trust tier, and drift-tested in CI. [How wpd verifies its numbers](https://github.com/jantimon/web-performance-debugger/blob/main/docs/verification.md).
- **Try it now:** `npx @jantimon/web-performance-debugger record --url http://localhost:5173 --breakdown`

## Contents

- [Your first run](#your-first-run)
- [Choose a lane: where your code runs](#choose-a-lane-where-your-code-runs)
- [Choose a capture: what you want to know](#choose-a-capture-what-you-want-to-know)
  - [Run groups: two questions, one workload](#run-groups-two-questions-one-workload)
  - [Firefox and node](#firefox-and-node)
- [Read the results](#read-the-results)
  - [The reconciling bar, and reading idle](#the-reconciling-bar-and-reading-idle)
  - [Forced-layout blame](#forced-layout-blame)
  - [CPU self-time (SSR and hot loops)](#cpu-self-time-ssr-and-hot-loops)
  - [Allocation attribution](#allocation-attribution---alloc-which-dependency-allocates)
  - [Driving a real interaction](#driving-a-real-interaction)
- [Repetition and CI gating](#repetition-and-ci-gating)
  - [Gating a budget: assert, diff, cpu-diff](#gating-a-budget-assert-diff-cpu-diff)
- [What one record writes](#what-one-record-writes)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)
  - [The query verbs](#the-query-verbs)
  - [The numbers, and how far to trust them](#the-numbers-and-how-far-to-trust-them)
  - [What each target gives you](#what-each-target-gives-you)
  - [Consuming the JSON](#consuming-the-json)
- [How wpd verifies its numbers](https://github.com/jantimon/web-performance-debugger/blob/main/docs/verification.md) · [Contributing](https://github.com/jantimon/web-performance-debugger/blob/main/CONTRIBUTING.md) · [Driving wpd from an agent](https://github.com/jantimon/web-performance-debugger/blob/main/AGENTS.md) · [Security](https://github.com/jantimon/web-performance-debugger/blob/main/SECURITY.md)

## Your first run

The fastest start needs no file at all: point `wpd` at a URL your dev/preview server is already
serving, and it profiles the page's own boot (navigate, then settle) as one `load` step.

```bash
# zero authoring: the built-in load flow, then read the boot's breakdown
npx @jantimon/web-performance-debugger record --url http://localhost:5173 --breakdown
npx @jantimon/web-performance-debugger query spans latest
```

```
run (run, 64.1 ms)
slice   ms    %
──────  ────  ─────  ──────────────────────────────────────────────────────────────────────
js      14.2  22.2%  react-dom 7.6 · react-counter-example 4 · (native) 2.2 · scheduler 0.3
style   1.6   2.5%
layout  8.5   13.2%
paint   0.7   1%
gc      0     0%
other   12.7  19.8%  (task remainder + unclassified)
idle    26.5  41.2%  (waiting, not work)
```

`--url` names the host page — a live URL or a local HTML file path — and wpd tells the two apart.
(A host with no scheme like `localhost:5173` gets `http://` assumed.) Default gives the boot's
four-slice CPU bar; `--breakdown` adds the
reconciling js/style/layout/paint bar and exact counts above; `--deep` adds forced-layout blame.

**The boot wall ends at the idle settle, which on a streamed SPA is before LCP.** The `load` step's
window closes when the page goes idle (two quiet frames), so on a page that keeps streaming content in,
the reported wall is *up to first idle*, not *fully loaded* — it can read well below LCP. Read the
**counts** and the **boot LCP** (`step.lcp`, on the `load` step) as the completeness signals, and treat
a high `~N% idle` tag on the bar as the tell that the window closed early. The wall is honest about what
it measured; it is not "the page is up in N ms".

**If wpd's own navigation lands on a bot-challenge interstitial** (Cloudflare, DataDome, and the like)
instead of the site, `record` refuses *before* measuring — a non-zero exit, an evidence-listed error
naming the signals that fired and the challenge origin observed, and a `<recording>.wall.png` screenshot
saved as proof — rather than reporting the challenge page's numbers as the site's. Detection is
conservative (it keys on the rendered interstitial, never on a captcha script a normal form embeds).
wpd never bypasses, waits out, or solves a challenge. To measure the challenge page itself on purpose,
pass `--allow-bot-wall`; the recording then carries a loud note that its numbers describe that page.
The same check runs on a `page.goto` your own driver module performs, so a hand-authored flow that
navigates onto a wall is refused exactly like the built-in flow, not measured as the site.

A page load has no interaction, so `INP` stays null there. To measure a click, a re-render, or SSR
you write a small `run` function and pick a **lane** by where the code runs, then a **capture** by
what you want to know. That is the whole model:

1. [Choose a lane](#choose-a-lane-where-your-code-runs) — driver, bench, or node.
2. [Choose a capture](#choose-a-capture-what-you-want-to-know) — default, `--breakdown`, or `--deep`.
3. [Read the results](#read-the-results) — `query spans`, then drill in.

## Choose a lane: where your code runs

`record <module>` imports a plain ESM file (`.mjs`, or `.js` in a `"type": "module"` package) and
calls the hooks it exports — it is not a top-to-bottom script. Only `run` is measured:

```js
export async function prepare(arg) {} // optional, before the measured window (alias: setup)
export async function run(arg) {}     // the measured part
export async function cleanup(arg) {} // optional, after the window (alias: teardown)
```

`prepare` and `cleanup` run **outside** the measured window (once around all `--iterations`), so
setup and teardown never pollute the numbers. All three hooks receive the same argument, and `ctx` (an
empty object shared across the hooks — stash a handle or test data in `prepare`, read it in `run`)
is a *property* of that argument in driver mode but *is* the argument in the other lanes. Pick the
lane by where your workload runs in production:

| What you are measuring | Lane | `run` receives |
| --- | --- | --- |
| A real click / navigation in an app | **driver** (default) | `{ page, ctx, measureStep }` — runs in Node, drives Puppeteer |
| A small DOM operation in isolation | **`--bench`** | `ctx` — runs inside the page, with live `document`/`window` |
| DOM-free Node / SSR code | **`--target node`** | `ctx` — runs in this Node process, no browser |

```js
// driver: flow.mjs — each measureStep becomes one step span with counts + INP
export async function run({ page, measureStep }) {
  await measureStep("open menu", () => page.click("#menu"));
  await measureStep("type query", () => page.type("#search", "shoes"), {
    until: "#results", // selector, async fn, or promise; omit for a rAF+idle settle
  });
}
```

```js
// bench: probe.mjs — run() executes in the page, repeated with --iterations
export function run() {
  const el = document.body.appendChild(document.createElement("div"));
  for (let i = 0; i < 100; i++) {
    el.style.width = i + "px"; // write
    void el.offsetWidth;       // read -> forced layout
  }
}
```

```js
// node: render.entry.js — run() executes in this process, no DOM
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import Page from "./your-compiled-output.js";
export function run() {
  for (let i = 0; i < 50; i++) renderToString(createElement(Page));
}
```

```bash
wpd record examples/counter-steps.mjs --url examples/react-counter/dist/index.html   # driver
wpd record probe.mjs --bench --iterations 5                                           # bench
wpd record render.entry.js --target node --iterations 50                              # node
```

A module + `--url` runs it against that host; a module + no `--url` runs it against a blank page.
`--bench` modules and a local-HTML `--url` are served to the browser, so they must live **under the
current working directory**; driver and `--target node` modules are imported in Node and can live
anywhere, and a `--bench` module has **no `process.env`** (route parameters through the URL or page
globals). Under bare `npx` (no local install), an `import` of the package **inside your module** does
not resolve — the module is imported from your cwd, which has no `node_modules` for the package; use the
helpers wpd injects into `run`'s argument (`waitForStable`), or `npm install` the package locally.
Driving a real interaction has a few sharp edges — settle timing, clicking a page that never stops
re-rendering, logins — collected in [driving a real interaction](#driving-a-real-interaction).

## Choose a capture: what you want to know

Every `record` invocation is **exactly one capture pass** — one browser launch, one run of the flow.
A capture mode picks *what* that pass captures. They are mutually exclusive: each answers a different
question with different instrumentation, and wanting two answers means running `wpd` twice (or a
[run group](#run-groups-two-questions-one-workload)).

<img src="https://github.com/user-attachments/assets/25d1e68e-dcb6-4fca-b57a-75561f6342f8" alt="" height="20"> On **Chrome**:

| Capture mode (chrome) | CPU sampler | Reconciling bar | Rendering counts | Forced-layout blame | Speed |
| --- | :---: | :---: | :---: | :---: | --- |
| **no measurement** *(not a mode)* | — | — | — | — | 🏆 baseline |
| **default** (no flag) | ✅ | — | — | — | 🐌 Δ ~4-7% |
| **`--breakdown`** | ✅ | ✅ | ✅ | ◐ sampled | 🐌🐌 Δ ~25% |
| **`--deep`** | — | — | ✅ | ✅ exact | 🐌🐌🐌 Δ ~70% |

- **no measurement** — plain browser, no trace, no CPU sampler: just the wall, the baseline the Speed
  column is measured against. Not a flag you pass.
- **default** — the CPU sampler only: the four-slice CPU bar (`js · browser · gc · idle`) and the run
  span's hot functions, the cleanest wall, no rendering counts.
- **`--breakdown`** — a light trace fused with the CPU sampler: the reconciling **seven-slice bar**
  per span (`js·style·layout·paint·gc·other·idle`, `Σ + idle = wall`) plus exact layout/style/paint
  counts. It also answers `query blame --forced` with the read that forced each flush, **sampled** from
  the CPU profile's per-sample executing line (a sampled estimate; a sub-interval flush is marked
  low-confidence). The exact forced **count** still needs the `.stack` trace (a Chrome trace option that
  records the JS stack on every layout/style event) — record `--deep` for that.
- **`--deep`** — the full trace (`.stack` + invalidations) with the CPU sampler off: the
  **attribution report** — forced-by read-sites, dirtied-by writes, the thrash detector, invalidation
  rollup, exact counts, long tasks. Span wall but no slice ms, and no CPU model. On heavy production
  pages, **budget `--deep` as effectively single-iteration**: it stores the full event log, which grows
  with the trace, and a recording whose log would exceed the ~512 MB a single JSON string can hold is
  refused early with a clear message (drop to `--iterations 1`, scope the flow, or use `--breakdown`).

**Speed** is the median wall-time overhead each mode adds over the no-measurement baseline, on a
mid-size mixed JS + layout workload (`examples/probes/capture-mode-speed.mjs`). It is directional and
machine-dependent: the ordering holds, the exact percentages will not, and the trace-based modes cost
more the more the page renders.

The CPU sampler's ~4-7% cost is systematic, so it cancels in `diff`/`cpu-diff` (both sides carry it).
wpd has no sampler-free wall mode: a bare benchmark wall is absolute-wall benchmarking, which wpd does
not measure — the wall is directional, and the attribution (line, package, count) is the product. To
compare two runs, record both in the same mode and `diff` them.

The split is what keeps the numbers honest. The CPU sampler must never ride a `.stack` trace (it
inflates sampled self-time +21%, billing the trace's own stack-walk to the JS frame that forced a
layout), so `--breakdown` samples only the light no-`.stack` trace and `--deep` runs the CPU sampler
off. For the same reason `--deep` suppresses slice durations: the `.stack` trace inflates style recalc
up to +38%, and a distorted millisecond is worse than none — so `--deep` leads with identities and
exact counts, and shows span wall (the honest window width) but no slice ms.

### Run groups: two questions, one workload

**Want the bar and the blame?** Record both into one **run group** — the sanctioned two-question path:

```bash
wpd record probe.mjs --bench --members breakdown,deep --group perf   # two captures, one manifest
wpd query spans  latest                                              # the bar (from the breakdown member)
wpd query span   latest run                                          # STITCHED: bar+hot from breakdown, counts+forced from deep
wpd assert       latest --max-slice js=5 --max-forced 0              # each threshold gated on the member that measured it
```

A group is N separate, unfused captures of **one** workload recorded as siblings under a
`<name>.group.json` manifest. It holds no summary or aggregate of its own — nothing is ever averaged
across members: the group verbs draw each panel from the member that measured it and tag it, and a
threshold whose axis no member measured is a loud `n/a` FAIL, never a silent pass. Add a single
recording to a group with `record … --group <name>` (the join refuses a member whose
workload/iterations/etc differ; only the capture mode may). `diff groupA groupB` fans out over members
paired by capture mode.

### Firefox and node

<img src="https://github.com/user-attachments/assets/dafc7978-b897-443a-a999-92d8b70572ff" alt="" height="20"> On **Firefox** every mode is the same one capture, so the table reports what that capture yields
rather than what you switch on:

| Capture mode (firefox) | Accepted | CPU samples | Reconciling bar | Rendering counts | Read-site blame | Dirtied-by writes | Speed |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | --- |
| **default** (no flag) | ✅ gecko pass | ✅ | ✅ | ✅ | ✅ | — | 🐌🐌🐌 Δ ~150% |
| **`--deep`** | ✅ same capture | ✅ | ✅ | ✅ | ✅ | ✅ | same capture, same cost |
| **`--breakdown`** | not available* | | | | | | |

\* The Firefox lane is one Gecko-profiler pass — the only source of its CPU samples, markers,
reconciling bar, and read-site blame. It offers no separate light trace to pick (what `--breakdown`
picks on chrome), so the flag has nothing to select.

`--target firefox` entangles samples and markers at profiler startup, so the capture modes are
reporting tiers over that one capture. That pass has no sampler-free counterpart, so even Firefox's
fastest capture pays for it: **🐌🐌🐌 Δ ~150%** over a plain Firefox launch, and `--deep` is the same
capture at the same cost. The tax is reflow-weighted, not flat — each synchronous reflow's marker
captures a JS cause stack (the blame signal), so the probe's reflow-heavy workload pays ~150% while
pure-JS work pays ~5% ([details](https://github.com/jantimon/web-performance-debugger/blob/main/docs/dev/firefox-cpu.md)). Neither engine offers a sampler-free wall,
so every wall is directional over a real attribution, not a benchmark wall. `--target node` is
a CPU-only lane with the four-slice bar. See [what each target gives you](#what-each-target-gives-you).

## Read the results

**Read `query spans` first, then drill in — never the multi-MB recording file.** `query spans` is the
compact overview; `query span <label>` is one span's full anatomy; `query cpu` / `query blame` answer
the CPU and forced-layout questions; `query get <id>` returns a raw event. Every verb accepts `latest`
in place of a file path, and **every verb emits `--format toon` or `--format json`** — agents and
scripts should consume those, reading `query spans` then drilling with `query span`, not parsing the
recording. ([TOON](https://github.com/toon-format/toon) is a compact, JSON-shaped text format that
spends fewer tokens than JSON, so an agent pays less to read the same shape.)

### The reconciling bar, and reading idle

`--breakdown` tiles each span (the `run` window, a driver step, a `performance.measure`) into the
seven-slice bar. Run the bench probe from [the lanes above](#choose-a-lane-where-your-code-runs):

```bash
wpd record probe.mjs --bench --breakdown --iterations 5
wpd query spans latest
```

```
run (run, 5.9 ms, sum of 5 iterations)
slice   ms   %
──────  ───  ─────  ───────────────────────────────
js      2.3  39.3%  wpd-examples 2.3
style   1.4  23.9%
layout  2.1  36.3%
paint   0    0%
gc      0    0%
other   0    0.5%   (task remainder + unclassified)
idle    0    0%     (waiting, not work)
```

Style + layout are 60% of this span: the read-after-write loop pays for a synchronous flush every
iteration. `idle` is 0 because a tight loop never yields to the frame; on a real interaction `idle` is
usually the largest slice (the wait for the next paint), and naming it as idle rather than folding it
into work is the whole point. Every slice is disjoint main-thread self-time from the trace, so the sum
is exact by construction, not a proportional allocation. `--breakdown` also reports **exact counts**
(layout/style/paint), main-thread windowed — trace-derived and exact, with wall-tier (~1%) ms:

```
metric        count  ms
────────────  ─────  ────
layout        500    2.21
style recalc  500    1.43
paint         2      0.03
```

`query span <label>` drills into one span. On a driver boot it tags a settle-dominated wall with its
idle share, and a repeated step's wall with the fact that it is a median, so the number is not
misread:

```
span run (run · chrome · sum of 1 iteration(s))
wall: 185.29 ms · ~87% idle (window, not work)

span first increment (step · chrome · first of 5 iteration(s))
wall: 27.51 ms · median of 5 samples
```

### Forced-layout blame

Reading geometry (`offsetTop`, `getBoundingClientRect`, ...) right after a DOM write forces a
synchronous layout flush (a forced reflow). `--deep` reports who read, who wrote, and whether the two
interleaved into thrashing:

```bash
wpd record probe.mjs --bench --deep --iterations 5
wpd query blame latest --forced
```

```
id   count  ms    kinds         source
───  ─────  ────  ────────────  ──────────────────────
842  1000   8.11  style,layout  examples/probe.mjs:5:13
  drill the raw flush: query get <id> (query events to browse the log)

dirtied-by (the write that forced each read):
  examples/probe.mjs:5:13
    ↳ dirtied by examples/probe.mjs:2:28 (Node was inserted into tree)
    ↳ dirtied by examples/probe.mjs:4:20 (Inline CSS style declaration was mutated)
```

Line 5 is `void el.offsetWidth`: 100 loop reads forcing style + layout, times 5 iterations, with the
writes that dirtied it named underneath (chrome `--deep` names both ends). Each row's `id` is the
widest flush at that line: `query get <id>` returns its raw event (stack + args), and `query events`
browses or filters the whole classified log (`--kind layout`, `--top`). Sampled `--breakdown` blame
rows carry no id (their events are synthesized), so the column reads `—` there, and their `count` is a
sampling-frequency signal (how often a sample landed on that read line inside a forced flush), not a
flush count — never compare it to `--deep`'s exact count; record `--deep` for the flush count.
`blame --all` lists every attributed line with a `forced` column, so "ran but never forced" is a real
answer too. `record --deep` also prints the layout-thrashing interleave when it finds one — the
write→read→write→read signature where each read re-flushes a layout the prior write dirtied:

```
⚠ layout thrashed 1000x during this run  (a write re-dirtied a just-read layout; forced re-flush)
```

`query span latest run` shows the same anatomy scoped to the run window (counts, forced read-sites
with their dirtied-by writes, and the thrash rollup).

### CPU self-time (SSR and hot loops)

When the cost is JavaScript, profile self-time per function and per package. `--target node` runs
`run()` in this Node process (no browser, no DOM) — that is where SSR runs in production, and it
resolves `node_modules` directly:

```bash
(cd examples/ssr-demo && npm install)   # the example has its own deps
NODE_ENV=production wpd record examples/ssr-demo/demo.mjs --target node --iterations 250
wpd query cpu latest
```

`NODE_ENV=production` is load-bearing: without it React resolves to its development build and the
profile shows a cost nobody ships. The `record` report leads with the CPU headline and the by-package
rollup (the same rollup `query cpu` prints on demand):

```
CPU profile: 283.8 ms JS self-time, sampled · 1170 samples (run 'query cpu latest' to drill):

package         self ms  self %  fns
──────────────  ───────  ──────  ───
react-dom       144      50.7%   25
tailwind-merge  76       26.8%   25
wpd-ssr-demo    34.2     12%     6
react           20.8     7.3%    1
```

`query cpu` prints the four-slice bar and `--by function` ranks the hottest lines (the `id` column
feeds `query frame <id>` for callers/callees):

```
id  self ms  self %  total ms  package         function (source)
0   70.5     24.8%   70.5      tailwind-merge  get (lib/lru-cache.ts:35)
1   27.7     9.8%    40.3      react-dom       w (cjs/react-dom-server-legacy.node.production.min.js:24)
```

Its headline names the divisor and the split: `283.8 ms JS self-time (summed over the whole window
across 250 iterations, divide by 250 for a per-iteration figure) · of 304.3 ms non-idle sampled`. The
figure is the **total** JS self-time across all sampled iterations, not a per-iteration one — so
comparing two builds is fair only when both use the **same `--iterations` and `--warmup`**. It is JS
self-time only; the larger non-idle total also carries gc and browser/engine work, which the bar
splits out of the `js` slice.

**In a browser, `self ms` is not only JavaScript.** It is your JS *plus the synchronous engine work
that JS triggered*: force a layout by reading `offsetWidth`, and the reflow is billed to the line that
read it (measured: ~85% of the layout probe's "JS" self-time is the reflow). That is usually what you
want — it prices "what do I save by deleting this line?" `--target node` has no DOM, so there `self ms`
really is pure JS. For the browser lane, bundle to one ESM module with sourcemaps and keep
dependencies external so each package resolves to its own bucket:

```bash
esbuild render.entry.js --bundle --format=esm --sourcemap \
  --define:process.env.NODE_ENV='"production"' --outfile=render.mjs
wpd record render.mjs --bench --iterations 50
wpd query cpu latest
```

On a live-URL `--url`, each remote bundle's sourcemap is auto-fetched, so **minification is not a
problem**: a minified single bundle still splits per package, as long as its map is reachable. Either
lane also writes a raw `.cpuprofile` that opens in Chrome DevTools (Performance → Load profile) or
Speedscope. See [when per-package attribution can't work](#when-per-package-attribution-cant-work) for
when a map cannot be fetched.

### Allocation attribution (`--alloc`): which dependency allocates

`--target node --alloc` answers a different question than CPU: **which dependency allocates** during
`run()`. It runs V8's heap sampler (instead of the CPU sampler) around the same timed loop and rolls
allocated bytes up per package/file/function, read with `query alloc`:

```bash
NODE_ENV=production wpd record examples/ssr-demo/demo.mjs --target node --alloc --iterations 250
wpd query alloc latest
```

```
Allocation sampling: 616.3 MB allocated (sampled, summed over the whole window across 250 iterations
  (divide by 250 for a per-iteration figure)) · 16889 samples @ 32.0 KB interval · GC-inclusive

By package (allocated bytes):
package         bytes     share  fns
──────────────  ────────  ─────  ───
react-dom       340.9 MB  55.3%  22
wpd-ssr-demo    238.4 MB  38.7%  6
tailwind-merge  3.1 MB    0.5%   19
```

Allocation **inverts the CPU story** on this workload: `tailwind-merge` is a quarter of the CPU (its
LRU-cache lookup is the hottest function above) but half a percent of the allocation, while your own
component (`wpd-ssr-demo`) is a tenth of the CPU and over a third of the allocation, because every
`createElement` returns a fresh object tree. A CPU profile alone would point you at the wrong thing.

`--alloc` is a dedicated capture mode: the CPU sampler runs OFF (a co-riding heap sampler inflates CPU
self-time, and wpd reports no perturbed numbers), so an `--alloc` recording has no CPU model — record a
plain `--target node` run for that. **Allocated bytes are sampled (GC-inclusive) on V8's allocation
clock: trustworthy in aggregate as per-package shares and ratios (~5% ratio fidelity); the absolute
byte total is directional (~10-20%), not exact.** The raw `.heapprofile` opens in Chrome DevTools >
Memory. Chrome/firefox heap and retained-object/leak analysis are out of scope: `--alloc` prices
allocation volume by owner, not retention.

### Driving a real interaction

By default `record` drives the page through Puppeteer, and each `measureStep` becomes one **step
span** — counts plus INP (Interaction to Next Paint), and the reconciling bar per step under
`--breakdown`:

```
first increment (step, 31.9 ms)
slice   ms    %
──────  ────  ─────  ───────────────────────────────
js      2.5   7.9%   react-dom 2.3 · (native) 0.2
style   0.1   0.3%
layout  0.1   0.3%
paint   0.1   0.3%
gc      0     0%
other   3.7   11.7%  (task remainder + unclassified)
idle    25.4  79.5%  (waiting, not work)
```

Almost 80% of this step is `idle` — the frame wait — and only 2.5 ms is JS. That is the point of the
bar: it stops you optimizing a re-render that was never the cost. `record` also prints the Core Web
Vitals split of a slow interaction:

```
Where that interaction's time went (in-page, Core Web Vitals split)

input delay         1 ms    (main thread busy at input)
processing          1.2 ms  (your event handlers)
presentation delay  21.8 ms (rendering the result)
```

A slow interaction is slow because the main thread was busy when the input landed, because your
handler ran long, or because rendering the result did. A `—` means no interaction crossed the 16 ms
floor the Event Timing spec sets, so nothing was measured. A step also carries any **Long Animation
Frames** it triggered (Chrome), naming the scripts that made a frame slow — this attributes a step's
cost to source even in the default capture mode, and `query span <step>` prints the blamed scripts
under the interaction split.

**Synthetic web vitals: boot LCP and per-step CLS.** wpd measures Core Web Vitals **synthetically**
in headless Chrome — one lab reading of the metric, not field data. A step that boots a fresh document
carries its **boot LCP** (`step.lcp`): the largest contentful paint's element (`url`/`size`/`tag`),
frozen at the first interaction. LCP swings run to run, so under `--iterations N` it is **per-iteration
sampled** — `lcp.perIteration` is the render-time series (an iteration that fired no entry stays
`null`, never 0) and `lcp.stats` its min/median/max, the same treatment `wall` gets; `query span`
prints the spread beside the median. A step also carries **CLS** (Cumulative Layout Shift,
`step.layoutShift`, Chrome only): the
spec **session-window maximum** (session windows gap-capped at 1 s, window-capped at 5 s, shifts within
500 ms of an input excluded), **on the step's own window** — not the page lifetime — with the top
shifting elements attributed (`tag#id`, the rects they moved). The boot/load step is where CLS shows;
a page that keeps shifting after the step settles needs an `until` to bring those shifts into a window.
Firefox has no `layout-shift` entry type, so CLS is absent there rather than a fake 0. **Field / RUM
data (CrUX, real-user CLS) is out of scope** — that is the calling orchestrator's job; wpd reports the
synthetic lab number and attributes it to source.

`inp ms` and the CWV split are measured **in-page**, so they describe the page, not the driver. A
step's `wallMs` is the page's own window too — the trace-clock span between the step's marks under
`--breakdown`/`--deep`, or the page's `performance.now` delta in the default capture mode — never the
node-side `page.click` bound (in no renderer timeline). The stored span records which clock priced it
in `wallClock`.

**Settle and the frame floor.** Omitting `until` waits for the page to **settle**: two animation
frames, each followed by an idle callback, which covers the usual state-update → render → cleanup
pattern. Pass `until` when your step ends on something specific: a selector, or a function/promise wpd
awaits. A function `until` is awaited **exactly once** after the action, not polled, so the step ends
the moment it resolves — compose your waits inside the function (or wait on landed content), because an
`until` that resolves early ends the step early. The settle floor is two frames — ~31 ms on Chrome's
built-in headless (full Chrome, ~60 Hz), and about the same on Firefox on a CI or idle-panel host,
whose cadence tracks the display refresh (~60 Hz there, not the 120 Hz a live ProMotion panel shows).
`wall`/`INP` carry the one-frame ~16.6 ms floor, so a sub-frame re-render reads as the frame time; read
the counts, the bar, or `interaction.processingMs` for the work itself. (How the floor is set, for
maintainers: [docs/dev/frame-floor.md](https://github.com/jantimon/web-performance-debugger/blob/main/docs/dev/frame-floor.md),
internal engineering notes.)

**Streamed / soft navigations.** The default settle resolves the moment the page goes briefly idle,
which on a streamed SPA route change can be *before* the content lands. Wait on the landed content, or
use `waitForStable`, which waits for a selector and then for the DOM to stop mutating. It arrives in
`run`'s argument, so your module imports nothing:

```js
export async function run({ page, measureStep, waitForStable }) {
  await measureStep("open product", () => page.click(".product-link"), {
    until: waitForStable(page, { selector: "#add-to-cart", quietMs: 200 }),
  });
}
```

It is opt-in: it trades a longer, more variable wall (the `quietMs` tail rides every step) for catching
the whole transition. If the DOM never goes quiet within `timeoutMs` (default 30000) — a countdown, a
poll, injected content that never stops — it fails loudly rather than pricing the whole cap as a
settled wall; lower `quietMs` if the lull requirement is too strict, raise `timeoutMs` if the
transition is just slow, or gate on a `selector` instead. `waitForStable` is also an
`import { waitForStable } from "@jantimon/web-performance-debugger"` for a module you install, but the
injected form needs no dependency.

**Hard navigations.** A step that reloads or navigates to a new document (a cold boot, a `page.goto`)
reports `wall: —` in the sampler-only default capture mode: the step spans two
documents, and one `performance.now` clock cannot measure across them. Record with `--breakdown` or
`--deep` to price it — those windows sit on the trace clock, which does span the swap. The counts, bar,
and boot LCP are unaffected.

**How a step is classified, and the engine's own verdict.** Every driver step is labelled
`none`/`hard`/`soft`/`soft-hash` from two reads it already takes — the URL and the document clock — so
an SPA route change shows up as `soft` on any browser. On a Chrome that ships the Soft Navigations API
(151+, default-on) wpd *also* reads Chrome's own soft-navigation verdict, opportunistically: no flags,
no change to the browser, and nothing recorded where the engine stays silent. `query span <step>` shows
both. They usually agree; where they split — a **programmatic** `pushState` moves the URL but Chrome's
heuristic, which needs a real user interaction, ignores it — the step notes both verdicts so you see a
route the engine's metrics will miss, rather than one number hiding the gap.

**Per-route web vitals for a soft navigation (Chrome 151+).** When a driver step soft-navigates and
Chrome's heuristic fires, the step also carries the **route transition's own** LCP, CLS, and INP in
`step.softNav`, sliced by the soft nav's `navigationId` and anchored to the route's start (the route
clock, not the boot clock). `softNav.routeLcp` is the route's largest paint (`tag`/`url`/`size`, and
`routeMs` into the route); `softNav.routeCls` is the shifts that landed after the route change (the same
session-window maximum boot CLS uses); `softNav.routeInpMs` is the worst interaction after the route —
the click that *triggered* the route keeps the pre-nav id, so it stays in the step's main `inp` rather
than here. It is opportunistic: a programmatic or untrusted-click route, an older Chrome, or Firefox
fires no engine entry, so `softNav` is simply absent, never a fabricated 0. `query span <step>` prints
the route numbers under the step; multiple soft navs in one step report the first and count the rest.

**Clicking a page that never stops re-rendering.** Prefer a stable selector and `page.click('#id')`. A
raw element handle throws `Node is detached from document` when the app re-renders between grabbing the
node and clicking it, and `page.locator(sel).click()` can hang on its actionability wait when the page
never settles. `page.click` on a stable id sidesteps both, and it is **trusted**: it produces an INP
entry, where a synthetic `page.evaluate(() => element.click())` produces none (so `inpMs` stays
`null`).

**Behind a login?** Add `--no-headless` to sign in by hand and `--user-data-dir ./.wpd-profile` to
persist that session. Gate the login in your driver so it only waits when not yet authenticated. That
profile dir stores real browser state — cookies, logins, history — so point it at a throwaway dir
dedicated to wpd, never your everyday profile, and add it to `.gitignore` so a session token never
lands in a commit.

A real-site interaction driver needs **per-site selector knowledge** — the search box, the menu
trigger, the result container — and a live DOM reveals those only when you read it (a search field
hidden behind an icon click, a container that streams in). The example below uses placeholder selectors
for exactly that reason: budget selector-reversing time per site, there is no record-and-replay helper.

**wpd retries its own machinery's races, never the site's refusals.** A transient cross-process boot or
a headless frame stall is wpd's to recover, so the built-in `--url` flow retries it silently. A
navigation timeout, an HTTP/2 stream reset, or a self-navigating anti-bot interstitial is the *site's*
behavior, and retrying it is a measurement decision (the second hit is warm, cookied, and differently
bot-scored) — so the built-in flow surfaces it and points you here, to a driver module where you own
the timeout, the backoff, the headers, and the wait, rather than deciding it for you.

**A full production journey** ties these patterns together. This stays README material, not a
committed example — a live third-party DOM is not stable enough to keep a runnable fixture green — so
copy it and replace the placeholder selectors with your own:

```js
// journey.mjs — a multi-step journey against your own site. #search / .result / #detail are
// PLACEHOLDER selectors: replace them. Run without --url so the boot step measures a cold navigation:
//   wpd record journey.mjs --breakdown --iterations 10 --warmup 2
// waitForStable arrives in run's argument, so this module imports nothing and runs under bare npx.

const SITE = "https://example.com"; // replace with your site

// A production CDN occasionally resets an HTTP/2 stream on first hit; retry with escalating backoff.
async function gotoWithRetry(page, url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.goto(url, { waitUntil: "load" });
    } catch (error) {
      if (attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
}

export async function prepare({ page }) {
  // Untimed warm-up: DNS/TLS and first-hit CDN flakiness stay OUTSIDE the measured window.
  await gotoWithRetry(page, SITE);
}

export async function run({ page, measureStep, waitForStable }) {
  // Cold boot as its own step: no --url, so every iteration measures a fresh navigation.
  await measureStep("boot", () => gotoWithRetry(page, SITE));

  // Streamed results: wait for the container, then for the DOM to stop mutating.
  await measureStep("search", () => page.type("#search", "example query"), {
    until: waitForStable(page, { selector: ".result", quietMs: 200 }),
  });

  // In-page dialog: wait on a URL-hash / overlay condition, not a settle.
  await measureStep("open detail", () => page.click(".result"), {
    until: () => page.waitForFunction(() => location.hash === "#detail"),
  });
}
```

### What a span's numbers represent

Each `query spans` entry carries `aggregation` and `iterations`, which say what the numbers mean when
`--iterations` repeats the flow:

- **`sum`** — the run span: its window covers the whole loop, so its slices/counts are a **total**
  across every iteration.
- **`first`** — a driver step, or an unrepeated `performance.measure`: the numbers describe **one**
  iteration. A step's wall/INP is the median of its samples, but its counts and bar come from the
  **first** timed iteration (counts never scale with `--iterations`).
- **`median`** — a `performance.measure` label that recurred: the lower-median-by-wall occurrence,
  **verbatim** (a real reconciling sample, not per-slice averages), with `samples`/`wallMinMs`/
  `wallMaxMs` disclosing the spread.

One recording mixes these, and `aggregation` is how a consumer tells them apart. Human output appends
the contract to each bar, e.g. `run (run, 5.9 ms, sum of 5 iterations)`. Output is colorized when
stdout is a terminal; control it with `--color auto|always|never` (`NO_COLOR` honored), and piped,
redirected, and `--format` output is always plain, so CI and scripts are unaffected.

Not every span carries a CPU/hot-functions number: the run span does in every sampling capture mode,
steps only under chrome `--breakdown`, measures under chrome `--breakdown` and firefox, and none under
`--deep`. On the CPU-only lanes (chrome default, `--target node`, Firefox without user
measures) there is no stored per-span bar, so `query spans` synthesizes the run span from the CPU
model's sampled window (labeled `sampled window`, JSON `source: "cpu-model"`), whose `wallMs` differs
from the sum of the timed `run()` samples. (How the sampled window is built, for maintainers:
[docs/dev/cpu-attribution.md](https://github.com/jantimon/web-performance-debugger/blob/main/docs/dev/cpu-attribution.md#which-spans-get-cpu-attribution),
internal engineering notes.)

### Framework addons (React)

wpd stays a general profiler; framework support is an **optional addon**, on by default via
`--framework auto` and switched off with `--framework off`. An addon only READS what the capture
already recorded and adds facts to a span's `addons` slot; it never changes what is measured, and a run
against an app with no detected framework carries no framework vocabulary at all. `--framework off`
guarantees zero addon code runs.

The React addon adds measured facts, never editorial. What you get depends on the build, stated
plainly:

- **Detection + commit counts work everywhere React runs (dev or production).** On the browser lanes a
  pre-load hook reports whether React is present, its version, the renderer package, and the build
  (`development`/`production`), plus an exact per-step **commit count** (`onCommitFiberRoot` fires once
  per committed update). These need no sampler and no trace, so they ride every capture mode.
- **Node-lane server phases (`--target node`) work on React 19 production, not React 18.** When the
  CPU profile resolves react-dom's server-render frames, self-time rolls onto the stable server-phase
  anchors (`renderWithHooks`, `renderElement`, ...). React 19 ships those names unmangled in its
  production server build; React 18 production is mangled, so the phases are honestly **absent** there
  (per-package attribution still holds).
- **React Performance Tracks are dev-only, on chrome `--deep`.** A development/profiling build writes
  `console.timeStamp` track events wpd already stores; the `react-dev` addon classifies them into
  per-track Render/Commit/Event facts. **A production browser build emits none**, so this is absent on
  a shipped build (as it should be) and only appears when the React addon detected a development build.

The facts surface under `query span <label>` in a clearly-labeled `React (addon)` block, and additively
in the `--format json` anatomy under `addons`. (How each fact is detected and classified, for
maintainers: [docs/dev/react-attribution.md](https://github.com/jantimon/web-performance-debugger/blob/main/docs/dev/react-attribution.md),
internal engineering notes.)

## Repetition and CI gating

### Measuring more than once

One reading of `wall ms` cannot tell a regression from noise: it is a single sample of a clock Chrome
deliberately clamps. `--iterations N` repeats `run` and re-measures every step, so each reports the
**median** of its samples, with `--warmup M` for untimed runs first (defaults 1 / 0):

```bash
wpd record flow.mjs --url http://localhost:3000 --iterations 20 --warmup 3
```

Repetition repairs clock noise and a cold first sample; it cannot repair a bimodal step. So each step
keeps its **raw samples** (`spans[].perIteration`), because a median hides the bimodality that usually
is the finding — a median of 40 ms next to a max of 255 ms says one iteration was cold. `spans[].stats`
is that step's own min/median/mean/max. There is deliberately no median *across* steps: "mount" and "inp"
measure different work, so pooling them would produce a real-looking number that means nothing.

**How many runs?** A single reading can sit anywhere in the run-to-run spread, so on its own it
misleads; the median of a few runs is far steadier — about twice as stable at five runs as at one.
Lighthouse measures the same effect: its score's confidence interval narrows from roughly ±15 points
at 1 run to ±8 at 5 ([variability docs](https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md)).
wpd's per-step medians already consume `--iterations`, so `--iterations 5` is the calibration knob.

Each iteration must measure the **same steps** — wpd fails the run rather than report a median over
fewer samples than it claims. On a flaky production site, add `--keep-partial`: if a **later**
iteration fails, wpd keeps the completed iterations and writes the recording with a loud note naming
the failed iteration and step (`meta.iterations` is the completed count). A failure in the **first**
iteration still errors — there is nothing honest to salvage from a flow that never completed once.

Match `--iterations` to the phase: a phase that can only happen once per page (a first mount) runs
with `--iterations 1` (repeat it by running `record` again); a phase you can repeat in place (an
INP-style re-render, a cache probe) iterates in-page, each pass a fresh sample. **Counts do not scale
with `--iterations`** on a step (they describe its first timed iteration, so an `assert --max-layouts`
gate keeps its meaning); the *run* span's counts are a total across iterations, and `query spans`
labels the run span `sum` and a step `first`.

### Gating a budget: assert, diff, cpu-diff

`assert` fails the build when a budget is blown; `diff` and `cpu-diff` compare two recordings. Slice ms
comes from `--breakdown` and forced counts from `--deep`, so record each capture mode you need and gate
each threshold on the capture mode that measured it:

```bash
wpd record probe.mjs --bench --breakdown --out runs/after.json
wpd record probe.mjs --bench --deep      --out runs/after.deep.json

wpd assert   runs/after.json      --max-layouts 120 --max-slice layout=2  # --breakdown: counts + slice ms
wpd assert   runs/after.deep.json --max-forced 0                          # --deep: forced counts
wpd diff     runs/before.json runs/after.json --fail-on-regression        # same capture mode on both sides
wpd cpu-diff runs/before.json runs/after.json --fail-on-regression        # per-function self-time deltas
```

`assert` gates the exact counts (`--max-forced`, `--max-layouts`, `--max-paints`,
`--max-layout-invalidations`, `--max-style-invalidations`, `--max-long-tasks`) plus directional timing
and slice budgets (`--max-inp`, `--max-wall`, and `--max-slice <name>=<ms>`, repeatable, defaulting to
the run span; `--label` targets another span). A budget on a metric the capture mode didn't measure —
`--max-slice layout` in the default mode, or `--max-forced` on a `--breakdown` recording — is a **loud
FAIL** (`n/a`), never a silent pass:

```
target  metric               value  max
──────  ───────────────────  ─────  ───  ────
run     forced layout/style  1000   0    FAIL
run     layouts              500    50   FAIL

✗ 2 assertion(s) failed:
  ✗ run: forced layout/style 1000 > 0
  ✗ run: layouts 500 > 50
```

`assert --format json` (or `toon`) emits the same result as a typed `AssertView` — a row per threshold
(`axis`, `budget`, measured `value` or `null`, `verdict`), the overall `passed`, and the `violations` —
so a PR-comment script consumes the verdict without scraping the table. The exit code is unchanged (0 =
all passed, 1 = any failed), so a `--format json` gate fails the build exactly as the human one does.

On `diff`, only the exact counts gate `--fail-on-regression`; wall, INP and JS self-time are
directional, so they print but never fail the build. `cpu-diff --fail-on-regression` gates on **net JS
self-time** (the JS-only headline the per-function and per-package rows sum to), so a change that is
entirely GC/native or sampler noise does not trip it. And a gate **refuses** across an incompatible
capture rather than fabricate a regression: a different
browser/runtime/capture-mode/workload/`--iterations`/`--warmup`/headless flavour/`--cpu-throttle`
names the mismatch and declines to gate. The **workload** is the executed flow (lane + host page +
module), not just the target string, so a different module — or the built-in load flow — against the
*same* host page is a different workload and refuses.

Never run two measurement processes at once on the same machine: concurrent runs contend for the CPU
and contaminate self-time and wall alike, so scale a CI matrix across machines, not across cores on one
([Lighthouse variability](https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md)).

### Running wpd in CI

`wpd` pins the Chrome build it drives (through a pinned Puppeteer), so `npm ci` downloads that exact
Chrome the first time. The download is small and fast — on a hosted GitHub-Actions runner it is about
1-2s, not worth caching. On a **slow or bandwidth-limited runner, a self-hosted runner, or a wide
matrix** where that download repeats, cache it, keyed on the resolved browser build so a Puppeteer
bump invalidates the cache automatically:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: npm
# Cache the pinned browser, keyed on the Puppeteer version in the lockfile (its build == wpd's build).
- id: pptr
  run: echo "v=$(node -p "require('puppeteer/package.json').version")" >> "$GITHUB_OUTPUT"
- uses: actions/cache@v4
  with:
    path: ~/.cache/puppeteer
    key: puppeteer-${{ runner.os }}-${{ steps.pptr.outputs.v }}
- run: npm ci   # installs the pinned Chrome into ~/.cache/puppeteer (a cache hit skips the download)
```

**A preinstalled browser (`PUPPETEER_EXECUTABLE_PATH`) is for the count-tier gates only.** Pointing
wpd at the runner's system Chrome (or a container's, via `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`)
skips the download entirely, but you own the version then. Exact **counts** (layouts, styles, paints,
forced-layout) and the frame floor survive a Chrome bump, so a count `assert`/`diff` gate stays valid
across versions. Directional numbers (renderTime, INP, slice ms) can shift with the engine, so keep the
**same browser build on both sides** of a `diff`/`cpu-diff`. wpd now stamps the resolved build on every
recording (`meta.browserVersion`) and the comparability check **warns** — not blocks — when two
recordings' engine milestones differ, so a cross-version gate is never silently trusted.

## What one record writes

One `record` writes into `./recordings/` by default (or exactly the `--out` path you name). Every file
sits together; the only thing kept out of your tree is the `latest` pointer:

| File | When | Where |
| --- | --- | --- |
| recording `<timestamp>.json` | every run — `spans[]` (run + steps + measures, carrying the counts/timing) + `meta` (+ `events[]` under `--deep`/firefox) | `./recordings/` or `--out` |
| `<base>.cpuprofile` | chrome/node CPU capture (raw, for DevTools/Speedscope) | next to the recording |
| `<base>.geckoprofile.json` | firefox (raw Gecko dump, for profiler.firefox.com) | next to the recording |
| `<base>.cpu.json` | CPU capture — the resolved `CpuModel` the verbs read | next to the recording |
| `<base>.group.json` | `--group`/`--members` — the run-group manifest | beside its members |
| `latest` pointer | every run — resolves the `latest` keyword | `$XDG_STATE_HOME/wpd/pointers/<cwd-hash>.json` (never in your tree) |

The pointer is keyed by the resolved cwd and stored out-of-tree, so recording with `--out` elsewhere
never drops a `recordings/` dir into a consumer's cwd. `latest` resolves through it, never by mtime;
when the newest run formed or extended a group, `latest` resolves to the group manifest.

## Troubleshooting

Each common failure has a home in the sections above; find your symptom here, then read the linked
section for the fix. wpd refuses rather than fake a number, so most of these are deliberate stops, not
bugs.

| Symptom | Cause | Where to read |
| --- | --- | --- |
| `record --url` exits non-zero before measuring and saves a `.wall.png` | it navigated onto a bot-challenge wall (Cloudflare, DataDome) and will not report that page as the site | [Your first run](#your-first-run) |
| A step reports `wall: —` | a hard navigation across two documents; the default clock cannot span it — record `--breakdown` or `--deep` | [Driving a real interaction](#driving-a-real-interaction) |
| `inpMs` is `null` after a click | a synthetic `element.click()` produces no INP entry; use `page.click` on a stable id | [Driving a real interaction](#driving-a-real-interaction) |
| The interaction split shows `—` or `0 ms` | no interaction crossed the 16 ms Event Timing floor, so nothing was measured | [Driving a real interaction](#driving-a-real-interaction) |
| Chrome will not launch (sandbox error) | the sandbox cannot start here — pass `--disable-browser-sandbox` only in a trusted, isolated environment | [Requirements](#requirements) |
| No Chrome downloaded under pnpm | pnpm blocks Puppeteer's install step; you must allow the build | [Requirements](#requirements) |
| Minified names, one `app` bucket, or a `Sourcemaps: 0/1 resolved` line | a sourcemap could not be fetched | [When per-package attribution can't work](#when-per-package-attribution-cant-work) |
| A `diff`/`cpu-diff` or `assert` refuses instead of returning a number | the two recordings are not comparable, or a gate hit a metric the capture mode did not measure — the message names it | [Gating a budget](#gating-a-budget-assert-diff-cpu-diff) |

## Reference

### Requirements

- **Node 24+** (the current LTS).
- **Chrome** is downloaded automatically by Puppeteer on install. To skip the browser entirely, use
  the `--target node` lane (CPU profiling only, no DOM/layout/paint).
- **chrome-headless-shell is dead weight.** wpd runs full Chrome (built-in headless or `--no-headless`),
  never chrome-headless-shell, but Puppeteer still downloads that binary by default. Skip it with
  `PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD=true` set for the install, or a `.puppeteerrc.cjs` in
  your project carrying `{ "chrome-headless-shell": { "skipDownload": true } }`.
- **pnpm users:** pnpm blocks Puppeteer's browser-download postinstall by default, so you must allow
  it or no Chrome lands. **pnpm 10:** `{ "pnpm": { "onlyBuiltDependencies": ["puppeteer"] } }` in
  `package.json`. **pnpm 11:** that field is gone (an install exits 1, `ERR_PNPM_IGNORED_BUILDS`, since
  `strictDepBuilds` now defaults on); allow the build in `pnpm-workspace.yaml` with the map form
  (`allowBuilds:` → `puppeteer: true`; the list form `- puppeteer` mis-parses), or run `pnpm
  approve-builds puppeteer`, which writes that entry for you. That exit-1 is an install-time failure, so
  it blocks the browserless `--target node` lane too: the install never finishes, so `wpd` never runs
  (a missing Chrome alone would only stop the browser lanes). pnpm 11 also holds back very fresh
  releases (`minimumReleaseAge`);
  if it skips a just-published wpd, wait it out or lower that setting. To supply your own browser, set
  `PUPPETEER_EXECUTABLE_PATH`, or run `npx puppeteer browsers install chrome`.
- **Firefox** is optional (`--target firefox`): `npx puppeteer browsers install firefox`.
- When `--url` is a URL, **your dev/preview server must already be running** at it; wpd does not start
  it. A `--url` local HTML file and `--bench` modules must live under the cwd.
- **Chrome launches sandboxed.** Where the sandbox cannot start (containers, restricted CI), wpd fails
  with a message naming the opt-in, `--disable-browser-sandbox`, rather than silently dropping the
  sandbox. Only pass it in a trusted, isolated environment (never with `--user-data-dir` or a
  non-loopback `--url`).

### The query verbs

| Verb | Shows |
| --- | --- |
| `spans <file>` | per-span reconciling bars (run + steps + `performance.measure`), one shape across targets (`--label <L>`, `--min-wall <ms>`, `--filter <text>`, `--frames`) |
| `span <file> <label>` | one span's full anatomy: bar, counts, INP, LoAF scripts, forced/dirtied-by, thrash, hot functions. `<label>` is bare or `kind:label` |
| `blame <file>` | events grouped by source line (`--forced`, `--all`, `--kind`, `--dirtied` on firefox `--deep`, `--top`) |
| `cpu <file>` | hot functions + rollup (`--by package\|file\|function`, `--top`) |
| `alloc <file>` | top allocating functions + by-package bytes, from a `--target node --alloc` recording (`--by package\|file\|function`, `--top`) |
| `frame <file> <id>` | one CPU function: its callers and callees |
| `get <file> <id>` | one raw event, full stack and args; needs `--deep`/firefox |
| `events <file>` | the classified event log (a niche raw-log view; `--kind`, `--name`, `--forced`); needs `--deep`/firefox |

`query events`/`get`/`blame` read the classified event log, which only `--deep` (chrome) and Firefox
store; in other capture modes they say so rather than report an empty page as clean. **`query spans`
is the one surface across every target**: one entry per span with the same slice keys whether the
recording came from chrome `--breakdown`, `--target firefox`, or `--target node`; a slice a lane could
not measure is an explicit `null`, never a fabricated `0`. When your own `performance.measure` spans
share a label, keep them sequential (wpd pairs a label's start and end first-in-first-out; give
overlapping regions distinct labels). When a tag manager floods the overview, cut it with
`--min-wall <ms>` and `--filter <text>` (the output states how many spans it hid).

### The numbers, and how far to trust them

| Signal | Source | Trust |
| --- | --- | --- |
| Counts (layout / style / paint / forced / invalidation) | DevTools trace, windowed to the main thread | exact: bit-identical across repeated runs; compare freely |
| Slice ms on a `--breakdown` bar (`style` / `layout` / `paint`) | trace `base::TimeTicks` (Chromium's internal monotonic clock), light trace only | wall-tier (~1%, directional); reconciles to `wall` exactly |
| Wall and INP times | `performance.now()`, browser-clamped | directional: good for "~2x worse?", not "1.3 ms". Carry the one-frame floor |
| CPU self-time | the sampler's own clock (V8 microsecond; Gecko ~1 ms floor on Firefox) | real: trustworthy in aggregate (a few % noise) |
| Allocated bytes (`--alloc`, node) | V8 heap sampler, GC-inclusive | per-package shares/ratios trustworthy (~5%); the absolute byte total is directional (~10-20%) |

- **Counts are exact, windowed to one main thread.** A cross-origin out-of-process iframe's layout is
  a separate off-thread count, never summed into the top span's wall.
- **`--deep` suppresses slice ms by design.** Its `.stack` trace inflates style recalc up to +38%, so
  a `--deep` recording reports counts and identities but `null` durations; the bar comes from
  `--breakdown`.
- **`inpMs` is the max duration over every Event Timing entry** in the window, rounded to 8 ms by the
  spec — a directional worst-interaction latency, not a sum.
- **`forcedLayoutCount` is a subset, never an addend.** A forced flush is already inside the
  layout/style counts (and `styleMs` / `layoutMs`), so **never sum forced onto style + layout**. It
  covers forced *style* recalc as well as forced *layout*, despite the name. The forced *milliseconds*
  are **not reported** on any lane: no engine can honestly price just the forced subset's duration
  (Chrome reads it only from `.stack`, which suppresses durations; Firefox's markers under-report it
  ~7x), so read the bar's `layout` slice for total layout ms and trust the forced *line*, not a
  forced-ms.
- **`Measured` is null-vs-0, everywhere.** Any count or slice a capture mode could not observe is an
  explicit `null` (not-measured), never a `0` (which reads as "measured clean"). A gate treats `null`
  as a loud failure, and a `diff` refuses to invent a delta from it. When you normalize across
  recordings of different capture modes, read `slice?.ms ?? 0` rather than treat null-vs-0 as a
  per-target signal — the same target can report `paint` as `null` on a run-only recording and a
  measured `0` once a stored breakdown exists.

### What each target gives you

wpd is additive: attributing cost to the source line works everywhere, and each richer target stacks
more signals on top.

| Signal | node | firefox | chrome |
| --- | --- | --- | --- |
| CPU self-time by package / file / function | ✓ (V8) | ✓ (Gecko) | ✓ (V8) |
| Four/seven-slice reconciling bar | ✓ (4) | ✓ (6) | ✓ (7, `--breakdown`) |
| Wall / per-iteration timing | ✓ | ✓ | ✓ |
| Real user flows, in-page bench | — | ✓ | ✓ |
| Forced layout/style blame to source | — | ✓ (sampled) | ✓ (`--deep`) |
| Dirtied-by write attribution | — | ✓ (first-invalidation, `--deep`) | ✓ (full set, `--deep`) |
| INP per step | — | ✓ | ✓ |
| Boot LCP (per-iteration sampled) | — | ✓ | ✓ |
| CLS per step (session-window max, attributed) | — | — | ✓ |
| Layout / style / forced-layout counts | — | ~ (Gecko markers) | ✓ (trace) |
| Paint counts + invalidation rollup + long tasks | — | — | ✓ (trace, `--breakdown`/`--deep`) |
| `--cpu-throttle` slowdown | — | — | ✓ |

**Node** (no browser): CPU self-time attributed to line/file/package, the four-slice bar,
per-iteration timing, and `cpu-diff` gates — its `js` slice really is pure JS. **A browser** adds the
real DOM: drive user flows or bench DOM-touching modules, get the reconciling bar (`--breakdown`) and
forced layout/style blame (`--deep`), the same modules and verbs in both engines. Firefox also writes
`<base>.geckoprofile.json` for profiler.firefox.com. **Chrome** adds the exact main-thread trace; the
CDP-only flags error out on Firefox, and a Firefox recording reports what it did not measure as `—`
(not-measured), never a fake `0`.

`~` means measured, but not by the same mechanism: Firefox counts layout/style from Gecko's
Reflow/Styles markers, and Gecko batches layout differently than Blink. Those counts are real
**against another Firefox run**; comparing them to Chrome's compares two different definitions. The
same holds across engines generally: **forced-layout blame names the same read line on both engines**
(12 of Chrome's 21 forced read lines matched on the thrashing probe), but Firefox samples it at
Gecko's ~1 ms granularity (a cheap read can be missed, the line can lag one statement); the
forced-layout *milliseconds* are not reported on either engine (Firefox's markers under-report the
forced subset ~7x, Chrome's `.stack` suppresses durations) — so trust the forced *line*, and read the
bar's `layout` slice for total layout ms. **CPU self-time** crosses engines **only for pure-JS work**
(`--target node`, or a browser lane that forces no layout): there both samplers time the same frame on
their own microsecond clock and Firefox reads ~0.83x Chrome (engine speed). The moment JS forces
layout, Firefox self-time runs **1.5–3x** Chrome's — the `js` feature captures a stack on every
reflow, billed to the forcing frame — so a reflow-heavy self-time is not a cross-engine number; compare
it within one engine. **INP** comes from an in-page Event Timing observer, so both engines measure it,
but for identical work Firefox reports a systematically lower number (presentation delay is
engine-specific): compare a browser against itself across your change, not one engine against the
other.

### When per-package attribution can't work

Splitting a bundle by package needs its sourcemap. When a map can't be fetched, wpd says so instead of
guessing: the run prints a `Sourcemaps: 0/1 resolved` line, `meta.sourcemaps` records every script it
tried and why, and the affected frames are bucketed by **origin** (`(cdn.example.com)`) rather than
blamed on your `app`.

| `meta.sourcemaps.failed` reason | What to do |
| --- | --- |
| `no-sourcemap-url` | No `sourceMappingURL` comment and no `SourceMap` header. Turn sourcemaps on in your production build, or serve the header |
| `map-fetch-failed` | It names a `.map` that isn't deployed (often uploaded to an error tracker). Serve it, even if only on a preview deploy |
| `script-fetch-failed` | wpd couldn't fetch the script: CORS or bot protection. Profile a preview deploy without the gate |
| `map-parse-failed` | The `.map` isn't a readable sourcemap |
| `auth-required` | The script or map returned 401/403 (a gated deploy). Profile a preview build served without the gate |
| `script-too-large` / `map-too-large` | The script (over 20 MB) or map (over 50 MB) exceeded the fetch cap. Serve a smaller/split bundle, or profile that package locally |
| `blocked-fetch` | The URL failed the fetch policy: a non-http(s) scheme, or a private/loopback host reached from a public page. Not fetched, by design |
| `fetch-budget-exhausted` | The run's 30 s total budget for remote sourcemap work ran out (a site with hundreds of scripts). Remaining frames keep minified names; re-run to resolve more |

Remote fetching is bounded on purpose: up to 4 concurrent fetches, a 20 MB script / 50 MB map size
cap, and a 30 s per-run budget. A partial failure is normal: third-party scripts (analytics, chat
widgets) rarely ship maps, and bucketing them by origin is the honest answer. The `N of M resolved`
ratio is not the trust signal — hand-written unbundled ESM resolves 0 of 1 and every frame still lands
on a real source line. The signal is the **WARNING** wpd prints, which fires only when a minified
bundle went unmapped or a remote frame fell back to an origin bucket.

**The origin buckets are themselves a signal.** They tell you which host served the cost, which is often
all a landscape read needs — and a bucket naming a challenge vendor (`(challenges.cloudflare.com)`,
`(geo.captcha-delivery.com)`, `(...hcaptcha.com)`) is a diagnostic that the page wpd measured is a
bot-challenge wall, not the store (the same evidence [bot-wall detection](#your-first-run) refuses on up
front).

On a `--url` run, `query cpu` tags each origin bucket with its **site relation** to the measured page —
`same-origin`, `same-site`, or `cross-site` — computed with the public-suffix list (registrable domain,
so `co.uk` is handled), and carried on the `byPackage` JSON as `siteRelation`. This is a URL-mechanical
fact and **only** that: it is not ownership and not "third-party". A cross-site CDN can be
first-party-owned — `assets.alicdn.com` is cross-site from `aliexpress.com` yet the same company runs
both. wpd states the mechanical relation and leaves the ownership call, which needs context wpd does not
have, to you.

### Consuming the JSON

Every artifact and `--format json|toon` output is typed. Import the types from the package root:

```ts
import type { Recording, Span, CpuModel, SpansResult } from "@jantimon/web-performance-debugger";
const rec: Recording = JSON.parse(await readFile("run.json", "utf8"));
```

| File / output | Type |
| --- | --- |
| recording `.json` (`spans[]` carry the counts/timing + `events[]` under `--deep`/firefox) | `Recording` (spans: `Span`, events: `NormalizedEvent`) |
| `.cpu.json` (CPU model) | `CpuModel` (functions: `CpuFunction`, edges: `CpuEdge`) |
| run-group `.group.json` manifest | `RunGroup` (members: `GroupMember`) |
| `query spans` | `SpansOutput` = `SpansResult` \| `GroupSpansResult` |
| `query span` | `SpanAnatomy`, or `GroupSpanStitch` on a run-group |
| `query cpu` / `frame` / `blame` | `CpuOverview` / `FrameQueryResult` / `BlameEntry[]` |
| `query get` / `events` | `NormalizedEvent` / `NormalizedEvent[]` |
| `cpu-diff` | `CpuDiffResult` |
| `assert` | `AssertView` (thresholds: `AssertThresholdRow`) |

**The one extract you probably want.** For a first/third-party cost read, take the per-package rollup
straight off `query cpu --format json` — no spelunking through the raw `.cpu.json`:

```bash
wpd query cpu latest --format json \
  | jq '.byPackage[] | {package: .key, selfMs, selfPct, siteRelation}'
```

Field names to know (they are not the obvious ones): a function's display name is `fn` (not `name`),
its self time is `selfMs`, its source is `source`/`file`; the JS headline is `jsSelfMs`; the by-package
split lives at `byPackage[]` (`key`/`selfMs`/`selfPct`, plus `siteRelation` on a `--url` origin bucket).
For per-span numbers, `query spans --format json` gives one `UnifiedSlices` shape (`js.byPackage`,
`style`, `layout`, …) across chrome/firefox/node — read that, never the multi-MB recording.

Recordings are self-describing: `meta.schemaVersion` stamps the on-disk schema epoch (currently
`"5"`), and a reader **rejects** any artifact from another epoch with a "recorded by an older wpd;
re-record" message rather than mis-parsing it into silent nulls. Numbers are rounded to 4 decimals on
disk (the raw `.cpuprofile` stays exact); TOON encodes the same shape, read back auto-detecting the
format.

### Stability and versioning

Since 1.0, semver covers the surfaces a pipeline or agent depends on:

- **CLI commands, flags, and exit codes** — a breaking change to any of them is a major release.
- **The root types and the `--format json|toon` view shapes** — fields may be added in a minor;
  renamed or removed only in a major.
- **The schema epoch** — a breaking change to the stored artifact shape bumps `meta.schemaVersion`
  and ships as a major. Old recordings then refuse to open with a re-record message; re-record
  stored baselines after such an upgrade.
- **Removed flags and verbs** keep a hidden stub that names the migration in its error, retired on
  the sunset policy stated in the contributing docs.

Measured numbers themselves are not semver: a browser or engine update can move a directional
number; the trust tiers and the comparability warnings say which numbers survive what.

### What wpd leaves to the caller

wpd finds and investigates; it does not grade, rank, or guide. Synthesis, N-way and cross-site
comparison reports (including graded HTML summaries), question-to-command recommenders, and orchestration
recipes stay with the caller, who holds the context and the comparability judgment wpd cannot defend.
In exchange wpd owes a typed, stable JSON/TOON contract, honest refusals (an n/a-FAIL, a comparability
gate — never a fake zero), a source and trust tier on every number, and a non-zero exit on every gate. The standing
scope boundary and the reasoning behind it: [docs/dev/orchestrator-boundary.md](https://github.com/jantimon/web-performance-debugger/blob/main/docs/dev/orchestrator-boundary.md).

### Compared to the tools you already have

- **Chrome DevTools**: the same underlying data, but scripted and repeatable instead of a manual
  session, and already attributed to source lines instead of a flame chart to read. When you do want
  the flame chart, the raw `.cpuprofile` wpd writes opens right in DevTools.
- **Lighthouse**: audits a page load and scores it. wpd measures the specific interaction or module
  *you* define, names the source line responsible, and fails CI when it regresses.
- **React Profiler**: component-level render timing inside React. wpd is framework-agnostic self-time
  across the whole stack (react-dom, your styling library, your code, each its own bucket), plus
  rendering signals React cannot see, like forced layout.
