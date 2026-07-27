# What the major measurement tools do, as context for wpd's choices (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file records what the established web-performance tools actually do — headless, throttling, frame
> cadence, variance — so a methodology choice here can be checked against the field instead of argued
> from first principles.

Like [core-features.md](./core-features.md), this file's evidence is **[source]**: other tools' code
and docs, read at a dated permalink, not an engine probe. It is the second exception to the house
rule that everything in `docs/dev/` is measured locally. Every claim carries a link to the file it
came from; when one moves, re-read it before trusting the sentence.

**In this file**

- [chrome-launcher does not default to headless](#chrome-launcher-does-not-default-to-headless)
- [Lighthouse reads no frame cadence](#lighthouse-reads-no-frame-cadence)
- [Lighthouse's default throttling is simulated](#lighthouses-default-throttling-is-simulated)
- [What Lighthouse names as its variance sources](#what-lighthouse-names-as-its-variance-sources)
- [What this settles for wpd](#what-this-settles-for-wpd)

**Provenance.** Sources are GoogleChrome/chrome-launcher and GoogleChrome/lighthouse at tip-of-tree,
read 2026-07. Nothing here is a wpd measurement; it is the surrounding field, cited so wpd's own
[measured] positions can be placed against it.

## chrome-launcher does not default to headless

chrome-launcher — the launcher Lighthouse and much of the ecosystem boot Chrome through — runs
**headed by default**. Headless is opt-in: the `--headless` flag is added only when the caller sets it
or the `HEADLESS` env var is present. Its `DEFAULT_FLAGS` carry no headless flag at all; they suppress
background work and telemetry (default-apps, background-networking, sync, first-run promos, the
crash-reporter) and nothing about rendering mode
(https://github.com/GoogleChrome/chrome-launcher/blob/main/src/flags.ts ,
https://github.com/GoogleChrome/chrome-launcher/blob/main/src/chrome-launcher.ts).

So "the ecosystem launches Chrome headless" is not a default anyone inherits for free — it is a choice
each tool makes. wpd makes it deliberately and states the floor it buys ([frame-floor.md](./frame-floor.md)).

## Lighthouse reads no frame cadence

Lighthouse computes every metric it reports — LCP, FCP, the responsiveness metrics — from
**trace-derived renderer timestamps**, never from an in-page frame-rate or vsync observer. There is no
vsync or frame-cadence read anywhere in its metric computation (`core/computed/metrics/*.js`): a metric
is a timestamp lifted out of the trace, not a value an on-page `requestAnimationFrame` loop reports.

Lighthouse also runs real Chrome headless: its own suites use `--headless=new` (Chrome's built-in
headless, the browser wpd launches), and one audit — back/forward-cache — is impossible on the old
headless implementation, which is part of why it moved.

Two positions the field shares with wpd fall straight out of this: the metric that matters is
trace-derived, and the frame cadence of the headless compositor is not a measurement input.

## Lighthouse's default throttling is simulated

Lighthouse's default is **simulated throttling** (Lantern), not applied network/CPU throttling. It
records the page **once, unthrottled**, then reuses only the observed task durations and the dependency
graph to **reconstruct** what the wall would have been under a slower network and CPU. The docs call
this "very fast and deterministic" and make it the default for exactly that reason
(https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md ,
https://github.com/GoogleChrome/lighthouse/blob/main/docs/lantern.md).

Neither throttling model is presented as ground truth. Lantern runs **~6-13% less accurate** than
applied DevTools throttling, but with far lower run-to-run variance; and applied throttling itself is
"not highly accurate" and "not a sufficient model" of a real device (`docs/lantern.md`,
`docs/throttling.md`). So the field's own most-used throttling is a reconstruction that trades a slice
of accuracy for determinism, over a baseline it already declares imperfect.

This is the same split wpd draws with its trust tiers, in different words. Lighthouse measures the
work once (the observed task durations, its exact tier) and reconstructs the wall from it (Lantern, its
directional tier). wpd holds counts exact and calls slice-ms and wall directional. Both refuse to
present a reconstructed or sampled wall as ground truth, and both keep the exact-work layer separate
from the modeled-wall layer.

## What Lighthouse names as its variance sources

Lighthouse's variability guide names seven sources of run-to-run noise — page nondeterminism, the
local network, browser nondeterminism, resource contention on the host, thermal throttling,
antivirus/security software, and CPU differences across machines. **Frame cadence appears nowhere on
that list** (https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md).

The guide's concrete advice, all [source] from the same doc:

- **Median of 5 runs is ~twice as stable as a single run** — it cites a 90% confidence interval
  tightening from about ±15 to about ±8 on a score.
- **Never run measurements concurrently on one machine**: parallel runs contend for CPU and distort
  each other.
- **Prefer dedicated, non-burstable hardware**: a burstable cloud instance (shared, credit-limited CPU)
  is called out as a bad measurement host.
- **`benchmarkIndex` calibrates the host CPU**: Lighthouse runs a short benchmark to estimate the
  machine's speed and adjusts for it, so a fast dev box and a slow CI runner are read on a common scale.

## What this settles for wpd

Stated as present positions, each backed above:

- **The deterministic 60 Hz headless floor is ecosystem-aligned.** The field runs real Chrome headless
  and treats its frame cadence as apparatus, not signal. wpd's fixed synthetic floor
  ([frame-floor.md](./frame-floor.md)) is the same stance, made explicit and pinned so a comparison and
  CI tool reads the same floor on every machine.
- **Trace-derived counts are the cadence-robust tier.** Lighthouse's metrics are trace timestamps;
  wpd's counts are trace-windowed and exact. Neither depends on what the compositor's frame rate happened
  to be, which is why both survive the machine they ran on.
- **A directional wall over exact work is the field's model, not a wpd compromise.** Lantern
  reconstructs the wall from measured task durations; wpd samples a directional wall and leads with the
  exact identity (line, package, count). The reconstructed/sampled wall is directional in both, by design.
- **Host-CPU calibration has a precedent.** `benchmarkIndex` establishes reading two machines on one
  CPU-speed scale as legitimate measurement practice. wpd reports raw self-time and does not normalize
  for host speed; if it ever did, the precedent is the field's, not an invention.
- **Applied CPU throttling is a coarse device-gap lever, per the field's own caveat.** wpd's
  `--cpu-throttle` is applied throttling, which the ecosystem calls "not a sufficient model" of a real
  phone. It closes part of the dev-machine-to-phone gap; it is not a device emulator, and how much wpd's
  own throttling distorts a given number is not separately measured
  ([orchestrator-boundary.md](./orchestrator-boundary.md#why-each-evaluated-surface-stands-where-it-does)).
