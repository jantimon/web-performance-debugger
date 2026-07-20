# Developer notes (internal)

> **Not user documentation.** Nothing here is needed to *use* wpd — read the
> [README](../../README.md) for that, or [CLAUDE.md](../../CLAUDE.md) for the architecture map.
> These files record empirically-verified facts that the code depends on but cannot state itself,
> so that whoever touches that code next does not have to re-derive them from a browser.

Everything here is **measured, not read off vendor docs** (with one flagged exception, the
market-research row below). Both engines' public docs are silent or wrong on most of this. Claims
are marked **[measured]** (reproduced locally, usually against `examples/forces-layout.mjs` in
both engines) or **[source]** (read out of mozilla-central / chromium at tip-of-tree, with a
permalink).

| File | Read it before |
| --- | --- |
| [engine-mapping.md](./engine-mapping.md) | touching `trace/classify.ts` or `profile/gecko.ts`, or claiming any number is comparable across engines |
| [gecko-profile-format.md](./gecko-profile-format.md) | touching the Gecko converter, or debugging a Firefox dump that stopped parsing |
| [cpu-profiling.md](./cpu-profiling.md) | changing the rung ladder, the sampler interval, or how `selfMs` is described |
| [driver-timing.md](./driver-timing.md) | touching `browser/driver.ts`, or presenting a step's `wallMs` as a cost |
| [frame-floor.md](./frame-floor.md) | changing the headless mode, adding a headless flag, or explaining why libraries with different cost report the same `wallMs` |
| [rendering-counts.md](./rendering-counts.md) | adding a name to `trace/classify.ts`, gating a count in `diff.ts`/`assert.ts`, or calling a count "exact" |
| [facts.md](./facts.md) | changing any load-bearing measured number (a ledger of them + the files that must agree, checked by a unit test) |
| [core-features.md](./core-features.md) | writing user-facing copy, prioritizing features, or claiming a capability is unique. The one file here whose evidence is market research (competitor docs and issue threads, link-verified and dated) rather than engine probes |

## The four things most likely to bite you

1. **Counts TOTAL across `--iterations` on every counting rung.** Every invocation is exactly ONE
   pass, which runs every iteration for the wall samples, so `layout/style/paint/forced` are totals,
   not one iteration's work, so `assert --max-layouts` silently scales with `--iterations`.
   `countScopeNote` says so; use `--iterations 1` to assert on counts. And a `Measured<>` field a rung
   did not measure is `null`, never 0 (`--breakdown` reports `forcedLayoutCount`/`forcedLayoutMs` as
   `null`, since forced needs `.stack`): `assert` FAILs on `null`, so `assert --max-forced 0` fails
   under `--breakdown` by design, rather than passing on a fake 0. Firefox is the same model: its
   unmeasured counts (paint, invalidations, long tasks) report `null`/`—`, never a fake 0.
2. **`selfMs` on the browser lanes is not pure JS.** It is JS *plus the synchronous engine work JS
   triggered* — a forced layout shows up as self-time on the line that forced it (~85% of the
   probe's "JS" time is reflow). Only `--target node` measures pure JS.
   [Details](./cpu-profiling.md#what-self-time-actually-includes).
3. **The sampler never rides a `.stack` trace.** Sampling on a `.stack` trace inflates self-time +21%,
   because our own `devtools.timeline.stack` category makes Blink walk the JS stack on every Layout and
   bill it to the forcing JS frame. So the sampler rides only the light `--breakdown` trace or no trace
   (default); `--deep`, which needs `.stack`, runs it OFF.
   [Details](./cpu-profiling.md#why-the-sampler-never-rides-a-stack-trace).
4. **A driver step's `wallMs` is the page clock, and mostly its settle.** The stored wall is the page's
   own clock (the trace-clock window between the step's marks on `--breakdown`/`--deep`, else the
   page's `performance.now` delta), not a node-side bound. That bound would read 40.5 ms via
   `page.click`, 31.9 ms via `page.evaluate`, 1.1 ms in `--bench`, because it carries the tool's
   dispatch in no renderer timeline. Even on the page clock the window includes the deliberate settle
   (floor ~31 ms under new-headless `--headless-mode new`, ~half on the default shell mode), so use
   `interaction.processingMs` or the per-step counts for what the page did.
   [Details](./driver-timing.md#a-driver-steps-wallms-is-the-pages-own-clock-not-a-node-side-bound).

## How to add a claim here

**Run the probe in both engines before writing the sentence.** A plausible mechanism is not
evidence: engine behaviour is only knowable by measuring it, and the notes above exist because the
obvious answer and the measured one differ often enough that the difference is the point.

Two corollaries worth applying:

- **A diagnosis that predicts the right magnitude can still name the wrong cause.** "This wall is
  too big" and "the CDP round trip is why" are separate claims; only the second needs a probe. A fix
  derived from an unmeasured mechanism ships the wrong column even when the symptom was real.
- **A default does not just change behaviour, it changes which latent bugs are load-bearing.** A
  warning that only fires for opted-in users is barely tested; flipping the default is the moment to
  re-read every warning it now reaches.
