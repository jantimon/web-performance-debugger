# Allocation profiling: the `--alloc` node lane (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file records why `--alloc` is a dedicated capture mode with the CPU sampler OFF, what its numbers
> mean, and the measurements behind both, so the next person does not fuse the two samplers and ship a
> perturbed number.

**In this file:** [what `--alloc` is](#what---alloc-is)
· [the GC-inclusion flags are mandatory](#the-gc-inclusion-flags-are-mandatory)
· [sampled allocation is an unbiased estimator](#sampled-allocation-is-an-unbiased-estimator)
· [why the CPU sampler runs OFF](#why-the-cpu-sampler-runs-off-the-dedicated-mode)
· [the split is interval-independent](#the-package-split-is-interval-independent)
· [allocation inverts the CPU story](#allocation-inverts-the-cpu-story)
· [trust tiers](#trust-tiers)

**Provenance.** All numbers below are `[measured]` on Node 24.13, macOS/arm64. The sampler-behaviour
figures (flags, estimator, interval sweep, co-ride contamination) are from the probe scripts
`q1-churn`..`q5-interval` (a synthetic churn workload for q1/q2, `examples/ssr-demo` for q3/q4/q5); the
inversion figures are the shipped tool on `examples/ssr-demo` at `--iterations 250`, `NODE_ENV=production`.

## What `--alloc` is

`wpd record <module> --target node --alloc` answers a question the CPU lane cannot: **which dependency
allocates** during `run()` (e.g. an SSR `renderToString`). It runs V8's heap SAMPLING profiler
(`HeapProfiler.startSampling`) around the same timed `run()` loop the CPU lane uses, attributes each
sample's bytes to the frame that allocated them, and rolls that up by package/file/function through the
SAME resolver the CPU model uses (`resolveCallFrame`), so an allocation's package matches
`query cpu --by package`'s spelling. Read it with `query alloc --by package|file|function`.

It is a **dedicated capture mode**: one heap-sampling pass, the CPU profiler OFF, so CPU self-time and a
`CpuModel` are NOT measured on an `--alloc` recording (absent per the `Measured` honesty convention,
never a perturbed-but-disclosed number). `meta.capture` is `"node-alloc"`; the artifacts are a raw
`<base>.heapprofile` (loads in Chrome DevTools > Memory) and a resolved `<base>.alloc.json`
(`AllocModel`). `query cpu`/`cpu-diff` on an `--alloc` recording refuse and point at `query alloc`
(there is no alloc-diff in v1); `query alloc` on a CPU recording points back at `query cpu`.

## The GC-inclusion flags are mandatory

**[measured, Node 24.13]** `HeapProfiler.startSampling` defaults to a LIVE-only view: it counts only
objects still on the heap at `stopSampling`. For allocation profiling that is the wrong signal, because
the interesting allocation is the short-lived garbage a render produces and a GC then reclaims. On a
pure-churn probe (allocate a mix of strings/objects/arrays, drop every reference, force GC):

| flags | sampled |
| --- | --- |
| both off (default, live-only) | **0 MB** |
| `includeObjectsCollectedByMajorGC` only | partial |
| `includeObjectsCollectedByMinorGC` only | partial |
| **both on (shipped)** | **58 MB** (the full churn) |

So `--alloc` sets BOTH `includeObjectsCollectedByMajorGC: true` and
`includeObjectsCollectedByMinorGC: true`, always. With them off the profile reads ~0 for a workload
that allocates heavily, which would read as "this code allocates nothing" -- the fake zero this tool
refuses. This is stated present-tense in `runtime/node-alloc.ts` and pinned in `facts.md`.

## Sampled allocation is an unbiased estimator

**[measured]** Heap sampling records a Poisson sample every ~`samplingInterval` bytes allocated, so the
byte totals are an ESTIMATE, not a census. But the estimate is unbiased: on a probe where workload B
allocates a designed **10x** of workload A, the sampled ratio reads **9.46x** (median of 8 interleaved
runs), and the sampled grand total tracks an independent real-heap estimate at **sampled/real 0.93**. So
the RATIOS and SHARES a reader compares (react-dom vs app, this build vs that) are trustworthy; the
absolute byte total is a directional estimate, off by ~10-20% (see [trust tiers](#trust-tiers)).

## Why the CPU sampler runs OFF (the dedicated mode)

**[measured]** The heap sampler is not free to co-ride the CPU sampler: allocation bookkeeping steals
time the CPU profiler then mis-attributes. Running both on the `ssr-demo` loop and measuring the CPU
sampler's `jsSelfMs` perturbation as the heap interval coarsens:

| heap interval | CPU self-time perturbation (heap co-riding) |
| --- | --- |
| 16 KB | **+26.5%** |
| 32 KB | **+11.3%** |
| 128 KB | +2.8% |
| 512 KB | within noise |

Even 128 KB costs +2.8%, and the interval `--alloc` samples at (32 KB, for the resolution below) costs
+11.3%. wpd's standing rule is that it **refuses a perturbed number rather than footnoting it**. This is
the THIRD instance of that exact pattern, so `--alloc` is a dedicated mode by the same reasoning the
other two are:

- the CPU sampler never rides a `.stack` trace (+21% self-time), so it rides the light `--breakdown`
  trace or none;
- `--deep` suppresses slice ms (the `.stack` trace inflates style recalc up to +38%);
- `--alloc` runs the CPU sampler OFF (the heap sampler inflates CPU self-time +11.3% at 32 KB).

Fusing an alloc bar onto a CPU recording would hand back exactly the perturbed self-time the first two
rules exist to avoid, so there is no fused mode. A user who wants both records twice.

## The package split is interval-independent

**[measured]** The heap interval sets sample density, not the answer. Across a 16x interval change the
per-package SPLIT on `ssr-demo` is stable: **react-dom ~55% / app ~38%** is identical at 512 KB and at
32 KB, and the run-to-run spread of the react-dom share TIGHTENS from **4.3pp at 512 KB to 0.6pp at 32
KB** (finer interval, more samples, less quantization). So `--alloc` fixes the interval at **32 KB**: fine
enough for stable per-function resolution and full churn recovery, coarse enough that the sampling
overhead stays ~10% of wall. Since the split does not move with the interval, the fixed value is not a
tuning knob worth exposing in v1.

## Allocation inverts the CPU story

**[measured]** On `ssr-demo`, allocation and CPU disagree about who is expensive, which is the whole
reason the lane exists -- a CPU profile alone would send you to optimize the wrong thing:

| package | CPU self-time share | allocation share |
| --- | --- | --- |
| react-dom | 50.6% | 55.3% |
| tailwind-merge | **24.5%** | **0.5%** |
| wpd-ssr-demo (app) | **11.6%** | **38.7%** |

`tailwind-merge` is a quarter of the CPU (its LRU-cache `get` is the single hottest function) but
allocates almost nothing -- it is cache-bound compute. The app component (`Button`/`Row`) is a tenth of
the CPU but over a third of the allocation, because every `createElement` returns a fresh object tree.
The two lanes name different owners; `--alloc` is what surfaces the second.

## Trust tiers

Allocation numbers sit on their own trust tier, distinct from the CPU lane's profiler-clock ms:

- **per-package/per-function SHARES and RATIOS** are trustworthy in aggregate (~5% ratio fidelity, from
  the 9.46x-vs-10x estimator check). This is the product: which dependency allocates, and by how much
  relative to the others.
- **the absolute byte TOTAL is directional** (~10-20%): a sampled estimate of allocation volume, not an
  exact heap census. Read it for order-of-magnitude and cross-run direction, never as a precise figure.

The report footer and `meta.notes` state this in one sentence: *"Allocated bytes are sampled
(GC-inclusive) on V8's allocation clock. Trustworthy in aggregate as per-package shares and ratios (~5%
ratio fidelity); the absolute byte total is directional (~10-20%), not exact."* The per-iteration wall
is kept and honest as "time under allocation sampling" (systematic ~+10% overhead at 32 KB), comparable
alloc-vs-alloc; the comparability gate refuses a `diff`/`cpu-diff` between an `--alloc` recording and any
other capture mode on the `capture-mode` axis (`node-alloc` vs anything), so no cross-mode number is
ever gated.
