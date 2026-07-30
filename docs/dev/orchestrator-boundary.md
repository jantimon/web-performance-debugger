# The orchestrator boundary: what wpd leaves to the caller, and why (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file states what wpd deliberately does not do, so a feature request can be answered with a link
> instead of an argument. It is the standing scope decision, not a wishlist.

Related: [core-features.md](./core-features.md) (what wpd does do, and where the field stands). The
README's [run-group section](../../README.md#run-groups-two-questions-one-workload) holds the
run-group case the third test below turns on.

**In this file**

- [What wpd is, and what it is not](#what-wpd-is-and-what-it-is-not)
- [The lean-surface test](#the-lean-surface-test)
- [What the orchestrator owns](#what-the-orchestrator-owns)
- [What wpd owes in exchange](#what-wpd-owes-in-exchange)
- [Why each evaluated surface stands where it does](#why-each-evaluated-surface-stands-where-it-does)

**Sources.** The scope decisions are maintainer choices, not engine probes: the third-party
classification flag and the doctor/init/compare/HTML-report asks that all stay out. The
surfaces-evaluated register at the end adds [measured] tooling facts (the pre-commit and knip timings,
the sandbox/trace deadlock) whose detail lives in the technical home cited there, plus two addon
verdicts (Next.js, GTM) backed by capture probes with the load-bearing numbers stated inline. Stated
throughout as present-tense scope.

## What wpd is, and what it is not

wpd is a precision measurement instrument for professionals and the orchestrators working for them:
an agent, a CI script, or the person at the terminal. It **finds and investigates** — it names the
line that forced the layout, the package that owns the milliseconds, the count that reproduces. It
**does not grade, rank, or guide.**

So it is not a compare library, not a comparison-website engine, not Lighthouse. Those tools score a
site against a rubric and tell you what to do next. wpd hands you exact, measurement-tagged numbers
and the JSON to act on them. The judgment — is this good, is it better, what should change — belongs
to the caller, who holds context wpd does not.

## The lean-surface test

Every proposed feature passes three questions before it earns a flag:

1. **Is the fact already derivable from existing output through the JSON contract?** Then the
   orchestrator derives it. No new flag ships to re-expose data the artifact already carries.
2. **Is it measurement, or is it judgment?** Measurement and attribution are facts, and facts ship.
   Judgment and synthesis are editorial, and editorial never ships from the tool.
3. **Does it remove bookkeeping wpd itself created?** That is the strongest case for building it. Run
   groups exist because the one-capture-per-run split is wpd's own constraint, so wpd owns the
   manifest that stitches the members back together.

Correctness and honesty fixes to existing surface are never "features" under this test.
An n/a-FAIL that should have fired, a fake zero, a broken measurement tag: those are defects, and a
defect outranks any feature on this page.

## What the orchestrator owns

Each of these stays out of wpd for a stated reason, not by neglect.

- **Question-to-command mapping** (doctor, init, intent flags, recommenders). Picking the command for
  a situation is judgment about the user's situation. The README maps symptoms to commands as
  documentation; anything smarter is the orchestrator reading that same table.
- **Environment preflight.** The orchestrator owns its environment. wpd owes a precise failure
  message when something it needs is missing — and delivers one — not a product that diagnoses the
  machine.
- **Flow scaffolding and templates.** A driver module is the orchestrator's code about its own app.
  wpd owes a small, stable `run` contract for it, not a generator that writes it.
- **Site-interaction mechanics** (consent dialogs, logins, bot-interstitial clicks). This is workload
  authorship, the same boundary as scaffolding: the orchestrator writes what its app needs driven.
- **N-way and cross-site comparison, scorecards, reports** (including HTML rendering). Comparing
  different workloads needs judgment about what is comparable, which is why wpd refuses to gate across
  workloads at all. An "advisory" comparison view would present that judgment as measurement and
  read as a verdict wpd cannot defend. The three-shop dogfood is the proof: an orchestrator
  built a defensible comparison on wpd's JSON in an afternoon, supplying the human-grade
  comparability judgment wpd could not.
- **Classification lists** (trackers, first-party vs third-party editorial). Origin buckets are facts
  wpd already emits. "This origin is a tracker" is editorial the orchestrator brings.
- **Cross-run and cross-version baseline management** beyond the honest schema-epoch gate. Where
  baselines live and how long they are kept is storage policy the orchestrator owns. wpd owes a
  refusal to misparse an old artifact and a stable epoch marker, nothing more.

## What wpd owes in exchange

The boundary is honest, not lazy, only because wpd holds up its side. It owes the orchestrator:

- a **typed, stable JSON/TOON contract** for every artifact and every structured output;
- **honest refusals** — an n/a-FAIL, a comparability gate — never a fake zero or fake cross-engine
  parity;
- **how every number was measured**: capture mode, member, and trust tier;
- **primitives that survive real pages**: redirects, cross-document navigations, bot protection;
- **machine-detectable failure**: a non-zero exit on every gate the orchestrator can branch on.

When this contract breaks, it is the highest-priority defect, not a feature request. Everything the
orchestrator builds stands on these guarantees, so a silent drift in the JSON shape or a swallowed
failure is worse than a missing feature: it breaks callers that were right to trust the number.

## Why each evaluated surface stands where it does

A register of surfaces already weighed, so a settled question stays settled. Each states why a surface
exists, or why an absent one stays absent. A defect against these is still a defect; a request to
reopen one needs a new fact, not a re-argument.

**Present surfaces.**

- **`--cpu-throttle` exists** because a dev machine runs 4-10x faster than the mid-range phones where
  INP problems actually live, and throttling is wpd's one lever on that device gap. It is CDP applied
  throttling, which the field calls a coarse model of a real phone, not a device emulator
  ([measurement-ecosystem.md](./measurement-ecosystem.md#lighthouses-default-throttling-is-simulated)):
  it closes part of the gap. What it does to each trust tier IS measured
  ([cpu-profiling.md](./cpu-profiling.md#what---cpu-throttle-does-to-each-trust-tier)): exact counts
  stay byte-identical, per-function attribution shares hold within noise (0.65pp max drift at 4x), and
  the multiplier lands cleanly on CPU self-time (~4x). The one boundary is calibration: a multiplier is
  relative to the host, so a throttled number compares only against another run on the same machine,
  and wpd does not normalize for host speed. So it is a lever the caller reaches for knowingly, not a
  default.
- **`meta.hostCpuIndex` exists** because self-time ms are host-relative, so a `cpu-diff` across two
  machines is mostly the machine gap. wpd measures a host-speed scalar (a fixed node microbenchmark
  before the capture, `benchmarkIndex`'s idea implemented independently) and stamps it beside the
  numbers; `diff`/`cpu-diff` WARN when two indices are more than 25% apart
  ([cpu-profiling.md](./cpu-profiling.md#the-host-cpu-index)). It is the honest fact + gate, not
  normalization: the self-time stays raw and same-host-honest, and the axis advises rather than blocks
  (a host difference is environmental, not a config wpd applied), so a same-machine gate is never
  refused.
- **`query events` and `query get` exist** as the forensic escape hatch. When a curated aggregation is
  distrusted, `events` lists the raw flushes with ids, and `get` renders one event's full stack and
  args with resolved source paths. In a drill against the raw JSON, these beat `jq` for semantics (a
  resolved read-site, a decoded invalidation) while `jq` beats them for a gross count over the array —
  both true, so both stay: the curated verbs for the answer, the raw verbs for the audit.

**Absent surfaces.**

- **No git hooks.** CI already gates lint, format, build, knip, and the unit suite. A hook installs into
  the shared `.git/hooks`, which every parallel worktree of this repo shares, so it would impose a
  local gate on unrelated work. A check-only pre-commit ran ~0.67s but duplicates what CI already
  enforces, so it buys latency, not coverage: evaluated, not adopted.
- **No Next.js addon.** The capture already covers it. An App Router `Link` click classifies as a soft
  navigation, Chrome's own engine heuristic agrees, and the React addon composes unchanged (per-step
  commit counts land on the route change). At file granularity the profiler already separates Next's
  internals once sourcemaps resolve: RSC payload decode (`react-server-dom` client), hydration
  (`react-dom-client`), the App Router reducer, and the prefetch/segment cache each resolve to a
  distinct named file. An addon would only re-group the profiler's own output, and that grouping is
  caller synthesis. Three constraints stay worth knowing: production Next emits zero
  `performance.mark`/`measure` (no marks-to-spans shortcut), App Router exposes no router-events
  emitter, and without served sourcemaps every Next frame is an anonymous chunk line
  (`productionBrowserSourceMaps` defaults off): evaluated, not adopted.
- **No Google Tag Manager addon.** Per-tag and per-trigger cost is unreachable from any capture
  [measured against a production GA4 container]: `gtm.js` is minified with no sourcemap, every tag
  shares the one `googletagmanager.com` origin bucket, and GTM's push/eval machinery dominates the
  per-event cost — an event that fires no tag costs the same ~2 ms [measured] as a real tag event. The
  one reachable remainder, a dataLayer event-name timeline via a `push` wrapper, is a label, not a cost
  split, and duplicates a named `measureStep`. A genuinely heavy tag already surfaces: an external tag
  script is named at URL granularity by LoAF and the hot list, and an inline Custom-HTML tag lands in
  `(native)` with LoAF blaming the dispatching listener: evaluated, not adopted.

**Adopted process gates.**

- **knip gates CI** (`npm run knip`, `knip.json`). It is tuned to zero false positives and catches a
  dead export the moment it is reintroduced, at ~1.3s. That cost earns its place because a silently
  dead export is exactly the drift the lean-surface test exists to catch. See the knip note in
  [CLAUDE.md](../../CLAUDE.md) for the `@testOnly` convention that keeps a test-only export honest.
- **The e2e suite runs sandbox-off in CI.** Full Chrome's sandbox deadlocks with CDP trace capture on
  the Linux runners: a no-trace record completes sandboxed, but any trace-mode record (`--breakdown` or
  `--deep`) hangs, and the unsandboxed launch completes. The documented escape —
  `--disable-browser-sandbox` / `WPD_DISABLE_BROWSER_SANDBOX=1` — is the fix, and local (macOS) runs
  stay sandboxed. The [measured] table and mechanism live in
  [trace-buffer.md](./trace-buffer.md#cdp-trace-capture-deadlocks-under-the-chrome-sandbox-on-the-linux-ci-runners).
- **Every CI job carries `timeout-minutes`, and the e2e harness kills its children at the OS level.**
  The e2e tests drive the CLI through a blocking `spawnSync`, which pins the test process's event loop,
  so node's own per-test timeout timers cannot fire while a child runs. A child wedged on a stuck Chrome
  would otherwise hang the whole job silently toward the runner's 6h ceiling. `spawnSync`'s own
  `timeout` + `killSignal: SIGKILL` kills the wedged child (the error names the invocation), and the
  job-level `timeout-minutes` is the outer backstop, so a wedge fails fast and legibly instead of
  burning hours.
