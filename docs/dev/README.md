# Developer notes (internal)

> **Not user documentation.** Nothing here is needed to *use* wpd — read the
> [README](../../README.md) for that, or [CLAUDE.md](../../CLAUDE.md) for the architecture map.
> These files record empirically-verified facts that the code depends on but cannot state itself,
> so that whoever touches that code next does not have to re-derive them from a browser.

Everything here is **measured, not read off vendor docs**. Both engines' public docs are silent or
wrong on most of this. Claims are marked **[measured]** (reproduced locally, usually against
`examples/forces-layout.mjs` in both engines) or **[source]** (read out of mozilla-central /
chromium at tip-of-tree, with a permalink).

| File | Read it before |
| --- | --- |
| [engine-mapping.md](./engine-mapping.md) | touching `trace/classify.ts` or `profile/gecko.ts`, or claiming any number is comparable across engines |
| [gecko-profile-format.md](./gecko-profile-format.md) | touching the Gecko converter, or debugging a Firefox dump that stopped parsing |
| [cpu-profiling.md](./cpu-profiling.md) | changing the pass plan, the sampler interval, or how `selfMs` is described |
| [driver-timing.md](./driver-timing.md) | touching `browser/driver.ts`, or presenting a step's `wallMs` as a cost |
| [frame-floor.md](./frame-floor.md) | changing the headless mode, adding a headless flag, or explaining why libraries with different cost report the same `wallMs` |
| [rendering-counts.md](./rendering-counts.md) | adding a name to `trace/classify.ts`, gating a count in `diff.ts`/`assert.ts`, or calling a count "exact" |

## The four things most likely to bite you

1. **`query blame --forced` means a different thing per engine.** Chrome's stack names the geometry
   **read** that forced the flush; Gecko's cause stack names the **write** that dirtied the DOM.
   Measured: zero line overlap on the same probe.
   [Details](./engine-mapping.md#forced-layout-blame-differs-by-engine).
2. **`selfMs` on the browser lanes is not pure JS.** It is JS *plus the synchronous engine work JS
   triggered* — a forced layout shows up as self-time on the line that forced it (~85% of the
   probe's "JS" time is reflow). Only `--target node` measures pure JS.
   [Details](./cpu-profiling.md#what-self-time-actually-includes).
3. **The CPU pass is isolated from *tracing*, not from the timing pass.** Sampling during the trace
   pass inflates self-time +21% because our own `devtools.timeline.stack` category makes Blink walk
   the JS stack on every Layout. [Details](./cpu-profiling.md#why-the-cpu-pass-is-separate-tracing-contaminates-sampling).
4. **A driver step's `wallMs` is mostly the driver.** It is measured node-side around the action and
   its settle, so identical work reads 40.5 ms via `page.click`, 31.9 ms via `page.evaluate` and
   1.1 ms in `--bench`. `page.click` alone costs ~20 ms; the settle floor is ~31 ms. Use
   `interaction.processingMs` or the per-step counts for what the page did.
   [Details](./driver-timing.md#wallms-is-a-bound-on-the-step-not-the-cost-of-the-page).

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
