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

## Known-wrong things these notes replaced

Kept deliberately: each was written down confidently, shipped, and turned out to be false. They are
the shape of mistake this project keeps making — a plausible mechanism, asserted without a probe.

- "Gecko's cause stack is the same 'JS on the stack == forced' approximation as Chrome's" — it is
  the opposite end of the story, and the note's own cited evidence (`Node.appendChild`) showed it.
- "CPU sampling is heavy, so it gets its own isolated pass" — sampling is cheap; tracing
  contaminating the sampler is the actual reason.
- "Firefox does not populate Event Timing entries, so INP stays null" — false, and it reached users
  via `meta.notes` before being caught.
- "`--cpu-profile` is the right tool for comparing pure-JS cost" — true only for `--target node`.
- "no sourcemap resolved" was treated as "your package rollup is a lie". Different questions: plain
  unbundled source has no map because it needs none, and its frames resolve fine. The warning was
  wrong for years but invisible, because it only reached people who had opted into profiling a
  bundle. Making profiling default-on pointed it at plain source and the false positive became the
  common case.

- "A driver step's wall is inflated by the CDP round trip." Plausible, and the shape of the number
  agreed. Measured: the round trip is **~0.5 ms**, i.e. noise. The cost is `page.click` itself
  (~20 ms of input dispatch) and the ~31 ms settle floor. The proposed fix followed from the wrong
  mechanism, and would have shipped an "action ms" column that was ~95% Puppeteer.

The lesson each time: **run the probe in both engines before writing the sentence.** Two corollaries
the later ones add: **a default does not just change behaviour, it changes which of your latent bugs
are load-bearing** (flipping one is a good moment to re-read every warning it unmasks); and **a
diagnosis that predicts the right magnitude can still name the wrong cause** -- "wall is too big"
and "the round trip is why" are separate claims, and only the second one needed the probe.
