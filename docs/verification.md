# How wpd verifies its numbers

A performance tool is only worth its trust tier. This page shows how `wpd` earns one: every
load-bearing number is measured, tagged with its provenance, checked against drift, and refused rather
than faked when the ground for it is missing. For the engine-level detail behind each point, the links
lead into `docs/dev/`.

## The probe rule

**A claim about engine behaviour needs a probe, not a mechanism.** A plausible mechanism is not
evidence. Sourcemaps, INP, Gecko cause stacks, and sampler isolation each behave in ways a mechanism
alone predicts wrongly, so no number in `wpd` rests on "this should be true". Each rests on running
`examples/forces-layout.mjs` in both engines and reading the output. That is the whole discipline, and
it is why the numbers hold. The rule and its corollaries:
[docs/dev/README.md](dev/README.md#how-to-add-a-claim-here).

## Every fact is tagged, and kept from drifting

The developer notes carry only measured facts, each tagged:

- **[measured]** -- reproduced locally, usually against the forced-layout probe in both engines.
- **[source]** -- read from mozilla-central or chromium at tip of tree, with a permalink.

The load-bearing numbers live in one ledger, [docs/dev/facts.md](dev/facts.md), with the source files
and docs that must agree on each. **A unit test reads that ledger and asserts every listed file still
contains the number**, so changing a figure in one place and not the others fails the build. The
numbers cannot quietly rot.

## Refusal over fabrication

When `wpd` cannot honestly measure something, it says so instead of printing a zero:

- A count or slice a capture mode did not observe is an explicit **`null`** (not-measured), never `0`
  (which reads as "measured clean").
- A CI gate on a metric the capture did not measure is a **loud `n/a` FAIL**, never a silent pass.
- A `diff`/`cpu-diff` across an incompatible pair (a different browser, runtime, capture mode,
  workload, or iteration count) **names the mismatch and declines to gate**, rather than subtracting
  two things that do not compare.

## Trust tiers

Not every number carries the same weight, and `wpd` never pretends otherwise. Each output states its
tier:

| Signal | Source | Trust |
| --- | --- | --- |
| Counts (layout / style / paint / forced / invalidation) | DevTools trace, windowed to the main thread | **exact:** bit-identical across repeated runs |
| Slice ms on a `--breakdown` bar | trace `base::TimeTicks`, light trace only | **wall-tier** (~1%, directional); reconciles to `wall` exactly |
| Wall and INP times | `performance.now()`, browser-clamped | **directional:** good for "~2x worse?", not "1.3 ms" |
| CPU self-time | the sampler's own microsecond clock | **real:** trustworthy in aggregate (a few % noise) |

The full table and its caveats: [README, The numbers](../README.md#the-numbers-and-how-far-to-trust-them).

## Three things the probes actually found

The design is shaped by measured results that a mechanism would have gotten wrong. Three examples:

### The CPU sampler must not ride a `.stack` trace

Forced-layout blame needs the `disabled-by-default-devtools.timeline.stack` trace category, which makes
Blink walk the JS stack on every layout. Run the CPU sampler on that same trace and it bills the walk
to the JS frame that forced the layout: **sampled self-time inflates +21%**, and the `.stack` trace
also inflates real style-recalc duration about **4.6x** (CDP ~234 ms against ~51 ms). So `--deep`,
which needs `.stack`, runs the sampler **off** and suppresses slice milliseconds; `--breakdown` samples
only a light no-`.stack` trace. One capture answers one question, cleanly, rather than one fused pass
quietly distorting both. [docs/dev/cpu-profiling.md](dev/cpu-profiling.md#why-the-sampler-never-rides-a-stack-trace).

### Firefox under-reports forced-layout milliseconds, so `wpd` does not report them

Firefox names forced layouts through Gecko's Reflow markers, which price only part of each flush: on
the probe the marker-derived forced duration runs about **7x low** against Chrome. A plausible number
that is 7x wrong is worse than none, so **`forcedLayoutMs` is not reported on any lane** (Chrome reads
it only from `.stack`, which suppresses durations; Firefox under-reports it). `wpd` keeps the forced
*line* (the read site, which does reproduce: 12 of Chrome's 21 forced read lines matched exactly on
Firefox) and points you at the reconciling bar's `layout` slice for total layout ms.
[docs/dev/blame-semantics.md](dev/blame-semantics.md#forced-layout-blame-differs-by-engine).

### CPU self-time crosses engines only for pure JS

For pure-JS work both samplers time the same frame on their own clock, and Firefox reads about **0.83x**
Chrome (engine speed). The moment JS forces layout, Firefox self-time runs **1.5-3x** Chrome's, because
its `js` profiler feature captures a stack on every reflow and bills it to the forcing frame. So a
reflow-heavy self-time is not a cross-engine number, and `wpd` says which comparisons hold and which do
not rather than letting you subtract them. [docs/dev/engine-mapping.md](dev/engine-mapping.md#what-is-actually-comparable-across-engines).

---

`docs/dev/` is the internal engineering record, not user documentation, but it is public: the evidence
is there to read.
