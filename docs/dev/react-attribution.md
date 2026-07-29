# What a React app looks like to wpd's existing capture (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file records how a React app's work already shows up in the traces and profiles wpd captures today,
> and which of those signals are dev-build-gated, so a React-aware surface (a `--framework` flag, a
> per-component read, a commit-count metric) is built on measured facts rather than a mechanism. Read
> it before adding any React-aware output, or before claiming what a React app shows wpd today.

**In this file:** [React needs no new capture](#react-needs-no-new-capture)
· [the trace channels a React app writes to](#the-trace-channels-a-react-app-writes-to-both-dev-gated)
· [the persisted TimeStamp shape under `--deep`](#the-persisted-timestamp-shape-under---deep)
· [node-lane function names by version and build](#node-lane-function-names-by-react-version-and-build)
· [framework detection metadata: the pre-load hook](#framework-detection-metadata-the-pre-load-global-hook)
· [the anchor allowlist is fragile across majors](#the-anchor-allowlist-is-fragile-across-majors)
· [what wpd stores today: the addon seam](#what-wpd-stores-today-the-addon-seam)
· [what is not established yet](#what-is-not-established-yet)

**Provenance.** Facts are **[measured]** on Chrome 151 (Puppeteer 25.4.0), react 19.2.8 and react
18.3.1, against a driven counter app (dev and production builds) and `examples/ssr-demo` on the node
lane, unless tagged **[source]** (read out of the React source or the bippy README, cited inline).
Where a probe refuted an earlier reading, the measured result is what stands here. Related:
[cpu-attribution.md](./cpu-attribution.md) (which spans carry CPU samples, the node SSR lane),
[cpu-profiling.md](./cpu-profiling.md) (the capture modes, what node-lane self-time measures),
[trace-buffer.md](./trace-buffer.md) (the `--deep` event log that stores these events),
[orchestrator-boundary.md](./orchestrator-boundary.md) (why framework metadata is a fact wpd may
stamp, and per-component render UX is not).

## React needs no new capture

A React app's own instrumentation lands in channels wpd already records: the DevTools timeline trace
(both the `--breakdown` and `--deep` category sets), the `blink.user_timing` `performance.measure`
stream, and the node CPU lane. So the near-term React story is a **reading** problem, not a capture
problem: the data is in the artifact today, and surfacing it is a classify/parse read plus a rollup,
never a new browser pass. What follows is which signals are present and which build gates them.

## The trace channels a React app writes to (both dev-gated)

React 19.2's Performance Tracks write to two trace channels wpd captures, and **both are fully
dev-gated**.

- **`console.timeStamp` Performance Tracks.** React 19.2's primary tracks API is the extended
  `console.timeStamp(label, start, end, track, trackGroup, color)`, not `performance.measure`
  (**[source]**, facebook/react PR #32736; `react-reconciler/src/ReactFiberPerformanceTrack.js`
  defines `COMPONENTS_TRACK = 'Components ⚛'`, `LANES_TRACK_GROUP = 'Scheduler ⚛'`, lanes
  Blocking/Transition/Suspense/Idle). That call **emits `TimeStamp` trace events under
  `devtools.timeline`**, which is in wpd's `--breakdown` and `--deep` category sets alike. **[measured]**
  a driven dev-build interaction produced **57 TimeStamp events** over 6 clicks, carrying the full track
  metadata (`Scheduler ⚛` lanes, `Components ⚛`, Render/Commit/Event phases) in `args.data.track`. So
  the tracks stream is ingestible from the trace wpd already records; no injection is needed to see it.
- **The `performance.measure` channel is richer than the tracks alone.** The same dev interaction
  emitted **~1700 per-component `Item` measures** on `blink.user_timing` (zero-width-prefixed labels),
  which wpd's `--breakdown` measure-span path already folds: they arrive as `performance.measure` spans
  and `query spans` merges the repeated label to its lower-median-by-wall occurrence
  ([cpu-attribution.md](./cpu-attribution.md#which-spans-get-cpu-attribution)).
- **Production emits neither.** On the production build both channels read **0** (the dev bundle makes
  46 `console.timeStamp` calls, the prod bundle 0). A dev-build React profile therefore carries phase
  timing a shipped build never emits, the same dev-cost trap the node lane shows below.

## The persisted TimeStamp shape under `--deep`

A `--deep` recording **persists** the React `TimeStamp` events today. `classify.ts` maps a `TimeStamp`
event (name `TimeStamp`, category `devtools.timeline`) to `kind: "other"` (it matches no
layout/style/paint/usertiming row), and `--deep` stores the full event log with `args` intact
([trace-buffer.md](./trace-buffer.md#the-remaining-ceiling-the---deep-recording-serializes-to-one-string)),
so `args.data.track` survives to the artifact and is reachable through `query get` / `query events`.

The consequence for future work: folding React's phase timing onto driver-step spans is a **read of a
field wpd already stores** (`args.data.track.trackGroup == "Scheduler ⚛"` on the persisted TimeStamp
events), not a capture change. It is dev-build-only for the reason above, and Firefox parity is
unverified (the gecko lane's React tracks are not probed).

## Node-lane function names by React version and build

The node SSR lane (`--target node`) resolves react-dom's server-render frames, and how readable those
frames are depends on the React **major** and the build:

- **React 19 production SSR ships unmangled server builds.** **[measured]** react-dom 19's
  `.production` server build carries **181 named functions** (its client production build 514), so the
  node-lane phase map (`renderElement` / `renderWithHooks` / `pushStartInstance` / `flushSegment` /
  `flushSubtree`, **[source]** react source) resolves **in production** on 19: no dev build, no
  sourcemaps needed. Per-function phase attribution inside react-dom is available on a shipped 19 SSR
  profile.
- **React 18 production SSR is mangled.** On 18 the production server build is one-letter names
  (`Fb`/`Ib`/...), so the node lane gives package and file granularity but not per-function phase names
  there. The **package rollup still holds**: `examples/ssr-demo` on 18 prod reads react-dom 50.1% /
  tailwind-merge 26.4%, with `tailwind-merge`'s `get (lib/lru-cache.ts:35)` still the hottest line.
- **Dev builds price a cost nobody ships.** A React dev build adds validation bookkeeping: **[measured]**
  react self-time reads **682 ms dev vs 179 ms prod** on the same SSR workload. This is why the demo and
  the node-lane copy pin `NODE_ENV=production` — a dev profile ranks and sizes react work a shipped
  build never pays.

## Framework detection metadata: the pre-load global hook

Installing a `__REACT_DEVTOOLS_GLOBAL_HOOK__` payload via `evaluateOnNewDocument` (before react-dom
executes) yields **build-independent, exact-tier** facts (**[source]** for the hook shape, bippy
README; **[measured]** for the counts on the driven app):

- **Detection + identity.** React registers reconcilers into `hook.renderers` (a Map carrying
  `version`, `rendererPackageName`, `reconcilerVersion`), so `--framework auto` can read
  present/absent + version + renderer as recording metadata.
- **`bundleType` is the cheapest dev/prod signal.** The injected payload sees `bundleType`
  (`DEV=1`/`PROD=0`) with no fiber walk, so a recording can stamp the build honestly. Test string for
  the ledger: **bundleType DEV=1/PROD=0**.
- **Per-step commit count is exact on both builds.** `onCommitFiberRoot` fires once per committed
  update: **[measured]** 5 clicks produced exactly 5 commits on **dev and production** alike. Only
  `actualDuration` is dev-gated (5.4 ms dev, `undefined` prod), so a per-step commit **count** is an
  exact-tier metric while per-component render **timing** from the hook is dev-only.

This is factual metadata (which framework, which version, which build, how many commits), the
measurement side of the [orchestrator boundary](./orchestrator-boundary.md#what-wpd-is-and-what-it-is-not).
Per-component render UX (why-rendered, highlight-on-render) stays with react-scan / React DevTools;
wpd does not rebuild it ([core-features.md](./core-features.md), feature 7's re-render-count note).

## The anchor allowlist is fragile across majors

Any name-based fiber-work-loop recovery must be a **minimal, per-major-verified allowlist**, not an
exhaustive map. **[measured]** across 18 -> 19: react-dom ships **no sourcemaps** in either major, the
server-render anchors are stable, but two of ten client work-loop anchors **renamed**:

- `workLoopConcurrent` -> `workLoopConcurrentByScheduler`
- `performConcurrentWorkOnRoot` -> `performWorkOnRoot` / `performWorkOnRootViaSchedulerTask`

So a hard-coded internal-name list silently loses a fraction of its anchors on a major bump. Keep any
such list short and re-verify it against each React major's build before trusting it.

## What wpd stores today: the addon seam

React support is an **optional addon**, never core. All React code lives under `src/addons/react/` and
`src/addons/react-dev/`, behind one narrow registry interface (`src/model/addon.ts` `Addon`, wired in
`src/addons/registry.ts`). The core (record/query/driver) calls the addons only through that interface;
it imports no addon internals. `--framework off` runs zero addon code, and an empty registry leaves
every recording byte-identical to one wpd wrote before addons existed. Each addon READS what the
capture already recorded and attaches facts to a span's `addons` slot (`Span.addons`, keyed by addon
name); it never changes what is captured.

The `react` addon stores build-INDEPENDENT facts:

- **Detection** (`ReactFacts.detected`/`version`/`rendererPackageName`/`build`), from the pre-load
  `__REACT_DEVTOOLS_GLOBAL_HOOK__` mini-hook (`hook.ts`, installed via `evaluateOnNewDocument` on every
  browser lane, before app code). `build` is `bundleType` (DEV=1 -> "development", PROD=0 ->
  "production"), the cheapest dev/prod signal. Rides the run span. Node has no page hook, so detection
  is absent there (never a fabricated value).
- **Commit count** (`ReactFacts.commitCount`), from `onCommitFiberRoot`: exact-count tier,
  build-independent. Cumulative on the run span; per-step on each driver step (its own window, read
  through the driver's per-step channel, iteration 0).
- **Server phases** (`ReactFacts.phases`), node lane only: react-dom self-time rolled onto the minimal
  server-phase anchor allowlist (`phases.ts`). Absent when no anchor resolves (React 18 production is
  mangled), with a run-level note when react-dom frames are present but unresolved.

The `react-dev` addon stores dev-build-GATED facts:

- **React Performance Tracks** (`ReactDevFacts`), from the persisted `TimeStamp` events (chrome
  `--deep`), classified per span window into per-track counts + ms (`classify.ts`). Gated on the
  `react` addon having detected a `development` build AND entries being present; absent otherwise. The
  per-component `performance.measure` stream is a separate, richer channel `query spans` already folds,
  so it is not duplicated.

The facts surface under `query span <label>` in a labeled `React (addon)` block and additively in the
`--format json` anatomy (`SpanAnatomy.addons`).

## What is not established yet

Stated so a reader does not assume parity wpd has not probed. These are open, not claims:

- **Firefox / gecko-lane React tracks** are unverified; the trace-channel facts above are Chrome-only.
- **Stream-writing vs rendering magnitude** on `renderToPipeableStream` (whether node stream cost
  dominates react-dom render cost) is unmeasured on wpd's node lane.
- **INP handler recovery under React's root event delegation**, **concurrent-mode LoAF fragmentation**,
  and **hydration-mismatch doubling** are unprobed; none has a measured wpd reading, so none is a claim
  here.
- **Bundled browser production names**: a bundler's terser pass re-mangles react-dom even on 19, so the
  unmangled-19 fact is a node-lane property (direct `require`), not a guarantee for a browser bundle.
