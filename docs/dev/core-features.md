# Core features: market position, demand evidence, honest ratings

What makes a developer pick wpd over the alternatives, feature by feature: what each does, why
it earns its place, where the rest of the field stands, and a rating on a bad / okayish / good /
best-in-class scale. Ratings are calibrated against verified competitor capabilities and demand
evidence (issue threads, vendor docs, published measurements). External links and market claims
are a 2026-07 snapshot; re-verify before quoting them in user-facing copy.

Two findings repeat across every feature:

- **The pain is articulated; the solution shape is not.** Users voice the problems loudly
  ("forced reflow took 48ms", "why does my score change every run", "which dependency is slow")
  but almost never request wpd's specific answer (line blame, trust tiers, package tables,
  reconciling bars). Positioning must connect to the pains users name, not the mechanisms wpd
  ships.
- **Attribution is the moat; formats are commodity.** Summarized, token-lean, agent-readable
  output is table stakes since Google's chrome-devtools-mcp (2025). No competitor gives wpd's
  attribution semantics: the source line that forced the layout, the package that owns the
  milliseconds, the count that reproduces exactly, and a stated trust tier on every number.

---

## 1. Forced-layout blame at source-line granularity: best in class

**What.** Flags layout/style work that JS forced synchronously and names the read site
(`file.ts:42`; on Firefox also the property, e.g. `offsetWidth`), including through minified
bundles via sourcemaps, headless, gateable with `--max-forced`.

**Why it wins.** The two existing tools that give a source line do not fit CI, and the tools
that fit CI do not give a line. Chrome DevTools' Forced Reflow insight (Chrome 134+) shows a
stack trace, but only interactively and only above a 30ms per-reflow criterion
([docs](https://developer.chrome.com/docs/performance/insights/forced-reflow)); no static lint
for forced-reflow detection exists. wpd's cell is unoccupied: line-level, headless/CI, sub-30ms
sensitive, cross-engine.

**Use cases:** layout-thrashing hunts, CI thrashing gates, verifying read/write batching
refactors, localizing a `[Violation] Forced reflow` warning to a dependency.

**Demand.** Real but latent. The canonical
[paulirish gist](https://gist.github.com/paulirish/5d52fb081b3570c81e3a) proves broad interest;
the recurring field pattern is consumers seeing the violation and filing it upstream because they
cannot localize it (radix-ui/primitives#1634, tabulator#2661). The minified-dependency case is
where users actually suffer, and it is wpd's strongest wedge.

**Positioning cautions.** Never claim "DevTools only gives a number": that is false since Chrome
134. Users conditioned by "took 48ms" expect a millisecond verdict; wpd's honest answer is the
line plus directional ms. Sell "where", not "how many ms".

## 2. CPU self-time by package / file / function: best in class

**What.** Sampling profiler (V8 or Gecko) with sourcemap resolution (local, inline, remote incl.
`SourceMap` response headers) rolled into stable package buckets, pnpm- and monorepo-aware,
minification-proof. One command answers "which dependency costs what ms".

**Why it wins.** The combination is the moat, not any single axis. Grafana/Pyroscope color
frames by package and Sentry keys frames by package internally (vendors validating the mental
model), but neither emits a per-package milliseconds table; the hosted profilers that come close
(Sentry, Datadog) require an SDK/agent and a backend. Bundle analyzers do exactly this rollup for
bytes; wpd is the same idea for time. Defensible one-liner: "source-map-explorer for CPU time",
local, zero-backend, CI-shaped.

**Use cases:** SSR cost comparison, dependency audits, library selection, attributing a
regression to a package bump.

**Demand.** Voiced as pain, not as a feature ask: react#20186 ("I see a component rendering
slowly but I don't know what is causing it", wanting app-vs-internals separation in minified
builds), recurring SSR `renderToString` threads that end in manual flamegraph reading.
Discoverability risk: "cost of a dependency" as a search phrase is owned by bundle-size tools.

**Expected-but-missing.** Every human-facing competitor is a GUI; the `.cpuprofile` handoff to
speedscope/DevTools is the mitigation and should be loud. Memory profiling and continuous/prod
profiling are out of scope; state the boundary.

## 3. The reconciling breakdown bar: best in class (narrow, precise claim)

**What.** `js · style · layout · paint · gc · other · idle = wall`, exactly, per span: the run,
each driver step, every user `performance.measure`. Idle is the honest remainder; residual zero. A
`measure` label that repeats across `--iterations` reports its lower-median-by-wall occurrence
verbatim (a real reconciling sample, so residual zero survives the merge), disclosed as
`aggregation: "median"` with the sample count and wall spread.

**Why it wins.** The concept is not novel: DevTools' Summary donut reconciles a selected range
with idle, in a GUI, manually. No tool products the combination of engine-work slices tiling an
**arbitrary user-named span**, residual-zero as a stated contract, machine-readable, cross-engine
(7 slices Chrome, 6 Firefox, 4 node). Lighthouse's main-thread breakdown is load-only with no
idle and no reconciliation; the DevTools INP insight splits phases, not engine work; LoAF
partitions frames, never user spans; Perfetto has the primitives but you write the SQL.

**Use cases:** mount/hydrate/INP decomposition, comparing CSS-in-JS techs, spotting
idle-dominated spans that are not CPU problems, explaining "fast function, slow interaction".

**Demand.** Nobody asks for "slices that sum exactly". Demand is voiced as "Idle and Other
confusion" (threads back to 2015), "presentation delay is the biggest INP phase and opaque"
(~42% of INP on average), and manual trace reading as the standard workaround. Messaging must
connect the bar to those named pains.

**Expected-but-missing.** The INP phase split (input delay / processing / presentation) is the
mental model the ecosystem trained users on; the bar answers an orthogonal question, and the two
should eventually be unified. Users will also ask what the idle is waiting on, a gap shared across
all tools rather than a wpd-specific weakness.

## 4. Measurement honesty (trust tiers, `Measured<T>`, disclosure notes): best in class

**What.** Every number carries a trust tier (counts exact; wall/INP directional on a clamped
clock and a frame floor; CPU self-time real on the profiler's own clock); not-measured is `null`
and `assert` fails loudly on it, never a fake 0; instrumentation cost is kept out of the measured
page; recordings carry disclosure notes (count scope, aggregation kind, sourcemap misses).

**Why it wins.** No mainstream web-perf tool assigns per-number trust tiers or reports null for
not-measured; the field's only honesty mechanism is "run it N times, take the median", which
addresses variance but not systematic observer effect. The market has already rewarded honesty
once in the adjacent microbench space: mitata displaces tinybench in the expert segment
specifically for flagging V8 deopts.

**Use cases:** CI budgets someone can defend, cross-tool disputes, any decision where a wrong
number is worse than no number.

**Demand.** Latent and post-hoc. Nobody shops for "the honest profiler", but the burned-user
content genre is large and durable ("why does my Lighthouse score change every run", "your
benchmark tool is lying to you", "a measurement without an error estimate is worthless").
Incumbents survive their own dishonesty through distribution; a challenger cannot, which makes
honesty a sharper wedge for wpd than the incumbents' indifference suggests.

**Positioning.** Honesty is the proof-of-credibility layer, not the tagline. Surface it exactly
where wpd's number disagrees with DevTools/Lighthouse: explaining why the other number is
optimistic is the moment latent demand becomes articulated.

## 5. Record-once artifacts + query surface (`spans`/`span`/`blame`/`cpu`/`get`, `diff`, `assert`): good

**What.** A recording is a portable JSON/TOON artifact; query it later by verb and id, diff two
runs, gate CI on thresholds. The `spans` overview is deliberately small; drilldown is by id.

**Why it wins.** Google's chrome-devtools-mcp validated the premise almost verbatim (a ~30MB
trace summarized to <4KB for the model), but it re-traces live and persists nothing: no artifact,
no re-query, no diff, no gate. Perfetto is the mirror image: keeps everything, pre-digests
nothing, and you write PerfettoSQL. The unoccupied intersection is a trace you can **keep**, query
by id, diff, and gate, with source attribution in the artifact.

**Use cases:** CI regression gates, PR before/after, sharing a repro, agent-driven perf
debugging.

**Why not best in class yet.** Diff and CI assertions are individually commoditized (Lighthouse
CI owns "budgets"; three tools diff Lighthouse runs); wpd's edge holds only where the diffed thing
is attributed (per-line, per-package). And the artifact's biggest consumers are gated on
distribution (see feature 10).

**Expected-but-missing.** History/trends over N commits (the most-loved github-action-benchmark
feature), a turnkey PR-comment GitHub Action, and a shareable-URL story for non-CLI stakeholders.

## 6. Three targets, one CLI (`--target chrome|firefox|node`): good

**What.** Same record/query surface for Chrome interaction/rendering profiling, Firefox (Gecko
profiler: CPU breakdown, layout/style markers, sampled read-site blame), and DOM-free node SSR
profiling. `query spans` folds all three onto one shape.

**Why it wins, unevenly.** The node SSR lane is a draw on its own: SSR self-time pain is
well-attested (Expedia/Walmart engineering posts, `renderToString` threads) and nobody pairs it
with browser profiling in one CLI. The Firefox lane is the boldest technical claim. browsertime
can capture a Gecko profile but only hands it to a web UI, and nothing else extracts comparable
metrics programmatically, but the audience is niche and shows up as Bugzilla repros (946167,
1209697: layout pathologies that reproduce only in Firefox), not as tool requests. Position it as
"when you hit it, nothing else finds it".

**Use cases:** SSR lanes without a browser, cross-engine sanity checks, Firefox-only jank,
one mental model across all three.

**The predictable objection.** "Why not Safari?" lands harder than Firefox enthusiasm. The answer
is a platform limitation, not a scope choice: WebKit exposes no headless deep-profiling hook to
anyone (Playwright profiles only Chromium; the Safari MCP server surfaces navigation/resource
timing only), so nobody holds the ground wpd is conceding.

## 7. Exact rendering counts (layout / style / paint): good

**What.** Counts that reproduce byte-identically run to run, assertable in CI
(`--max-layouts`, ...), source-attributed via blame, with paint counts the CDP metrics API does
not even expose.

**Why it wins.** The raw CDP counters sit in every Puppeteer install (`page.metrics()`), and a
dormant Jest wrapper technically asserts on them, but treats counts and wall time identically. The
insight wpd adds is absent from the entire flaky-perf-CI literature, which reaches for statistics
(medians, retries, quarantine) instead of exact metrics: **counts reproduce where milliseconds do
not, so gate on counts.** That framing is wpd-original on top of a real, felt-but-unnamed pain.

**Use cases:** "this PR must not add a layout pass" gates, invalidation regressions,
deterministic perf tests that do not erode trust.

**Positioning cautions.** The claim is "exact + source-attributed + trust-tiered", not "you can
assert on counts" (already possible, unused). Adjacent demand to acknowledge and point elsewhere:
component re-render counts (react-scan and friends) are a different axis (React tree, not the
rendering pipeline).

## 8. Real-interaction measurement (driver steps + lab INP + iterations): okayish

**What.** A user module drives the page (`measureStep(label, action)`); each step gets its own
window, in-page Event Timing INP, rendering counts, and median-of-iterations statistics. Median
sampling is uniform across the surface: driver steps median via `mergeSteps`, and a
`performance.measure` label repeated across iterations medians via `mergeSpanOccurrences` (the
lower-median-by-wall occurrence, verbatim), so a repeated interaction and a repeated in-`run()` phase
both report a median, not iteration 1 (the span path keeps a real reconciling sample; step
medians interpolate on even counts).

**Where the bar sits.** The INP era (Core Web Vital since March 2024) created real lab-INP
demand, and Lighthouse's lab score still proxies INP with TBT, so scripted lab INP fills an
acknowledged hole, and people hand-roll it today (Puppeteer + pasted web-vitals bundle,
run-10-take-P75). wpd's per-step structure with counts is competitive-to-ahead, and its
frame-floor disclosure is unique: every other tool silently ships frame-floored numbers.

**Why okayish anyway.** The statistical footing is the soft underbelly, and median sampling being
uniform across steps and measure spans does not close it: a lower-median point estimate is still not
an interval. tachometer's 95% confidence intervals with auto-sampling-until-significant and A/B
round-robin is the bar; median-of-iterations is the hand-rolled tier. Nobody asks for sub-frame INP
precision, so demand is for confidence in comparisons, which is reachable.

**Use cases:** interaction benchmarking, INP debugging in CI, step-level regressions.

**Expected-but-missing, ranked by demand:** confidence intervals / auto-sampling, interleaved
A/B mode, named throttling presets ("mobile 4x"), explicit warm/cold control, lab INP phase split
(input delay / processing / presentation, which is also where the frame floor lands, making the
honesty story legible).

## 9. `cpu-diff` (per-function deltas across builds): good

**What.** Noise-filtered self-time deltas between two recordings, joining on
sourcemap-original identifiers so two different minified builds still match.

**Why it wins.** Profile diffing is a well-trodden concept (pprof `-diff_base` set the precedent;
every continuous profiler has a compare view), but the specific slice is uncontested:
minification-proof joins for frontend JS (no tool found even claims it; name-joins produce garbage
when minified names change per build), as a free local CLI with zero infrastructure. Demand
receipts are crisp: Chrome DevTools has no profile diff (complained about since 2019, a prior
compare feature was removed), and speedscope's A/B request has been open and unimplemented since
2023.

**Use cases:** PR-level CPU regression detection, before/after of an optimization, "did the
dependency bump cost us".

**Expected-but-missing.** Users equate "profile diff" with a red/green differential flamegraph;
wpd ships a table (mitigation: the `.cpuprofile` pair opens in any viewer). The beloved CI shape
is "auto-comment the delta on the PR" plus history over commits, the same Action gap as features 5
and 7.

## 10. Agent-era consumption (digest sizing, ids, TOON, notes): good design, gated on distribution

**What.** Output built for LLM agents: a digest sized for a context window, id-based drilldown,
plain JSON/TOON, no ANSI, machine-checkable assert, disclosure notes an agent can read instead of
hallucinating caveats.

**The verdict from the field.** The design is independently endorsed: Anthropic's tool-writing
guidance and the MCP-optimization literature recommend this shape, and TOON specifically is cited
for 50-70% token savings. The thesis is validated, not early: Google's chrome-devtools-mcp shipped
summary + id-drilldown + token-minimized encoding in 2025 and owns the category's mindshare.
Agent-readable output is commodity; wpd's differentiation for agents is the same as for humans,
attribution the official server structurally lacks ("delete this line, save X ms" vs
Core-Web-Vitals insights) plus the persisted, re-queryable artifact.

**The gap is distribution, not design.** Agents discover MCP servers, not CLIs. Ranked moves from
the research: (1) an MCP server wrapping the existing verbs, highest leverage by far; (2) position
on attribution, not format; (3) human-readable labels alongside drilldown ids (measured to improve
retrieval precision over opaque ids); (4) a `concise|detailed` verbosity knob mirroring the
recommended `response_format` pattern; (5) an agent-facing skill file externalizing the "read the
`spans` overview, drill by id, never the raw recording" rule.

---

## Cross-cutting conclusions

- **Lead with attribution, prove with honesty.** The four best-in-class features (1-4) share one
  shape: they name the responsible code and state how much to trust the number. Honesty converts
  the expert user and survives scrutiny; it belongs in "why you can trust this", not the tagline.
- **Three lanes independently point at the same two integrations:** a PR-comment GitHub Action
  (features 5, 7, 9) and an MCP server (features 5, 10). They are distribution for capability that
  already exists, and each was flagged as the single most common glue users build by hand.
- **The statistics gap is the one place a competitor is simply better** (tachometer, feature 8).
  Everything else is either unoccupied ground or a GUI-vs-CLI trade wpd makes deliberately.
- **Vocabulary matters:** users say "reflow" (wpd says layout), search "cost of a dependency"
  (finds size tools), and think in INP phases (wpd bars engine slices). User-facing copy should
  bridge from the words users use to the model wpd ships.
</content>
</invoke>
