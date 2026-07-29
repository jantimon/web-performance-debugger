# Navigation classification and LCP under wpd's conditions (internal)

> **Developer notes, not user documentation.** Nothing here is needed to *use* wpd; read the
> [README](../../README.md) for that. This file records what a Largest Contentful Paint entry and a
> soft-navigation signal look like under the conditions wpd actually records under (headless Chrome,
> a driven page, trusted input), and how a step's navigation kind is decided without a CDP call. Read
> it before wiring an LCP number into a span, or before deriving a static/hard/soft label for a step.

**In this file:** [LCP fires under headless Chrome and Firefox](#lcp-fires-under-headless-chrome-and-firefox)
· [the useful LCP identifier is url+size+tag](#the-useful-lcp-identifier-is-urlsizetag)
· [LCP finalizes on a trusted input and re-arms per document](#lcp-finalizes-on-a-trusted-input-and-re-arms-per-document)
· [the boot-LCP entry-delivery race](#the-boot-lcp-entry-delivery-race)
· [LCP is per-iteration sampled](#lcp-is-per-iteration-sampled)
· [the headless startTime anomaly](#the-headless-starttime-anomaly)
· [CLS is the session-window maximum, per step](#cls-is-the-session-window-maximum-per-step)
· [soft navigations: standards status](#soft-navigations-standards-status)
· [why wpd does not flip the heuristic flag](#why-wpd-does-not-flip-the-heuristic-flag)
· [the soft-navigation entry on Chrome 151](#the-soft-navigation-entry-on-chrome-151)
· [the url+timeOrigin classification](#the-urltimeorigin-classification)
· [the ambiguity family](#the-ambiguity-family)
· [what wpd records today](#what-wpd-records-today)

**Provenance.** Facts are **[measured]** on Chrome 150 (Puppeteer 25.2.1) and Firefox 152, either
against synthetic probes or against one traced four-step journey on **a production Next.js SPA**
(a heavy, hydrating framework page, named here only as such). The soft-navigation facts are
**[measured]** on Chrome 151 (Puppeteer 25.4.0), with the version boundary read off Chrome 150
(Puppeteer 25.2.1), against a synthetic pushState/replaceState SPA driven headless with wpd's own
launch flags. External standards status is **[source]** with a dated link. Nothing is read off
vendor docs alone where a probe was possible.

## LCP fires under headless Chrome and Firefox

**[measured]** `largest-contentful-paint` entries fire under Chrome's built-in headless (the browser
wpd launches) and Firefox 152; the API is Baseline cross-browser
(https://developer.mozilla.org/en-US/docs/Web/API/LargestContentfulPaint ,
https://caniuse.com/mdn-api_largestcontentfulpaint).

**[measured]** Firefox's `element`/`url`/`size` fidelity is **partial parity**, Firefox 152 / Chrome
150, boot LCP via the built-in load flow, 3 reps each. On a page with a raster (PNG) hero and a text
block, both engines pick the same element and agree on its identity: tag `IMG`, the same `url`, and
the same `size` (480000 px^2 both). renderTime is populated in both same-origin, but its absolute
value is wall-tier and differs (chrome 20ms / firefox 72ms) — a paint timestamp on each engine's own
clock, not a comparable number.

The parity **breaks on an SVG-image hero**: Chrome does not treat `<img src="*.svg">` as an LCP
candidate and falls back to the next-largest element (the H1 text, size 69440, no url), while Firefox
picks the SVG image (tag `IMG`, url, size 700000). So on the identical page the two engines report a
different element, size, and url. So a boot LCP is comparable across engines for **raster-image and
text** heroes (element + url + size), never for **SVG-image** heroes, and its renderTime is
directional (wall tier) either way. Do not claim blanket cross-engine LCP parity; scope it to the
raster/text case.

## The useful LCP identifier is url+size+tag

**[measured]** An entry carries `element`, `url`, `id`, `size`, `renderTime`, and `loadTime`. A
readable identifier has to serialize from in-page context (the pattern the INP and LoAF observers
already use), because `element` is a live node the observer cannot post across the boundary.

On a production build the identifier worth keeping is **url + size + tag**. `id` is often null, and
the element's `class`/`cssPath` are hashed CSS-module names — noise, not a label. On the production
SPA the boot LCP was a 2016 px CDN hero image with `renderTime` ~604-784 ms.

`renderTime` is populated **only when the resource is same-origin or the server sends
`Timing-Allow-Origin`**. That CDN sets the header, so `renderTime` was present cross-origin; absent
the header it reads 0 by spec, and `loadTime` is the only timing left
(https://developer.mozilla.org/en-US/docs/Web/API/LargestContentfulPaint/renderTime).

## LCP finalizes on a trusted input and re-arms per document

**[measured]** LCP stops updating at the first real user interaction, and only a **trusted** input
finalizes it. A Puppeteer `page.click` (a trusted event) freezes the entry: paints larger than the
frozen one, landing after the click, emit no further entries. An untrusted `page.evaluate` click does
**not** finalize it, so a driver that dispatches synthetic clicks would keep an LCP that never settles.

Buffered LCP entries are **per document**. A cross-document navigation starts a fresh entry stream, so
the observer re-arms through `evaluateOnNewDocument` on every navigation — the same re-arm the INP and
LoAF observers use in `driver.ts`.

**No soft navigation ever produced a new `largest-contentful-paint` entry** on the production SPA —
not a route change, not a hash change. That entry type re-fires only on a fresh document. But it is
not the whole LCP story: Chrome 151 routes a soft navigation's LCP-equivalent through the separate
`interaction-contentful-paint` entry and the soft-nav entry's `getLargestInteractionContentfulPaint()`
method (see [the soft-navigation entry on Chrome 151](#the-soft-navigation-entry-on-chrome-151)). So a
per-soft-step LCP is empty only for the `largest-contentful-paint` entry type; the route's own largest
paint is reachable, gated on a trusted interaction. The semantic that needs no soft-nav support and is
available on every engine is still **boot LCP, up to the first interaction** — one number for the cold
load, not a per-step series. LCP is a paint timestamp on the page's own clock, so it sits in the wall
tier: directional, not exact.

## The boot-LCP entry-delivery race

**[measured]** A buffered `largest-contentful-paint` entry can be **queued to the observer before its
callback dispatches**. The entry exists, but the observer's `__cpLcp` array is still empty when a read
races ahead of the dispatch. Reading that array straight after load, on a slow environment, loses the
boot entry **40 of 40 times** on a page that genuinely painted — the paint happened, the delivery had
not.

`PerformanceObserver.takeRecords()` delivers the queued entries **synchronously**, through the same
shaper the callback uses. Draining it recovers the entry **~60% of the time immediately**, and the
rest **within one frame**. Under a 20x CPU throttle recovery stays within **two frames** (`<=41ms`), so
the whole race closes in a small, bounded number of frames.

So the driver's end-of-step flush, on a hard-navigation step whose entry has not arrived yet, drains
`takeRecords()` and, while the list is still race-empty, waits frame by frame up to a bounded budget
(`LCP_ENTRY_WAIT_MS`, 500 ms — about 10x the worst recovery observed, and an order of magnitude under
the stall backstop). Two properties keep this honest:

- **Absence stays absence.** A page with no contentful paint queues nothing, so the wait runs to the
  budget and ends empty. The budget bounds the wait; it does not invent an entry.
- **The wait never grows a measured number.** All of it sits **after the step's end mark**, on the
  window the counts and wall already closed on, so draining and waiting for the entry cannot inflate the
  step's wall or its counts. It moves only whether a real paint is captured, never how large it reads.

The wait arms only on a **hard** navigation (which includes the built-in load step): LCP re-fires only
on a fresh document, so there is no boot entry to race for on a soft or static step, and the flush skips
the wait there.

## LCP is per-iteration sampled

A boot LCP is a paint timestamp on the page's own clock, so it sits in the wall tier: it varies
run to run. **[measured]** on one live production site the boot LCP swung **536 ms to 3644 ms**
between two runs of the same URL; a single stored number could be either extreme and could not say
which. So under `--iterations N` the load step captures its OWN entry each iteration (each iteration
re-navigates, so LCP re-fires on the fresh document, `mergeLcp` in `trace/steps.ts`), and the stored
`lcp` grows the same `perIteration` + `stats` treatment `wall` already carries:

- `perIteration` is the render-time series in iteration order. An iteration that fired **no usable
  entry** (the entry-delivery race lost it past the budget, no contentful paint, the startTime
  anomaly, or a TAO-gated resource whose renderTime reads 0) is **null** in the series, never 0 --
  null and 0 stay distinct, the same rule the counts hold to.
- `stats` is min/median/mean/max over the non-null values, null below 2 samples (the wall `stats`
  contract).
- The identity/timing fields (`url`/`size`/`tag`/`renderTimeMs`) are the **lower-median-by-render-time
  occurrence verbatim** -- a real sample, the way `mergeSpanOccurrences` keeps a real bar rather than
  averaging one that never happened. So `renderTimeMs` is one iteration's real paint, and
  `stats.medianMs` is the computed median; on an even sample count the two differ, which is honest.

A single-iteration run keeps the shape (`perIteration` length 1, `stats` null), so a consumer reads
one code path. `query span` prints the spread beside the median; `query spans` stays a compact single
number.

**[measured]** on the local layout-shift fixture booted through the on-ramp at `--iterations 3`, the
text LCP (`H1#hero`, same-origin, so renderTime is populated) reported `perIteration` `[32, 16, 16]`
ms -- the spread the single number would have hidden.

## The headless startTime anomaly

**[measured, reproduced twice]** Chrome's built-in headless intermittently reports a grossly inflated
LCP `startTime` — ~60 s on a page that finished in ~40 ms. `shapeLcp` (`browser/driver.ts`) guards
it: an LCP `startTime` more than `LCP_STARTTIME_SLACK_MS` (1000 ms) beyond the step's own
end-of-window page clock is the anomaly, not a real paint, so the entry is stored `suppressed` with no
timing rather than printed as a 60 s LCP. A sane `startTime` passes through; the guard's slack is
generous, so real variance is never suppressed.

**Same root as the rAF frame-production stall** (docs/dev/frame-floor.md): a headless browser that
loses its GPU-process BeginFrame source produces no frames, so LCP has no paint to time. **[measured]**
On the default GPU path, **7 of 60** launches produced no LCP entry at all (the frame-starved branch),
matching the ~6% rAF-stall rate; with `--disable-gpu` (the headless default), **60 of 60** produced a
normal ~80 ms entry. The inflated-`startTime` branch is the same stall surfacing as a broken paint
clock instead of a missing entry. `--disable-gpu` addresses the root, so both branches are rare;
`shapeLcp`'s guard stays as the backstop for the residual.

## CLS is the session-window maximum, per step

A driver step carries **Cumulative Layout Shift** from an in-page `layout-shift`
`PerformanceObserver`, injected per step exactly like the INP/LoAF observers (`browser/driver.ts`),
Chrome-only. The stored `layoutShift` is the spec **session-window maximum**, not a raw sum, computed
by the pure `computeLayoutShift`:

- Entries flagged `hadRecentInput` are **excluded** (a shift within 500 ms of a user input does not
  count), which is why a click step usually reports none and the boot/load step is where CLS shows.
- The rest are grouped into **session windows**: a new window opens when a shift lands **>1 s after
  the previous shift** or **>5 s after the window's first**. Each window is scored by summing its
  entries, and `cls` is the **largest window's** score. A raw sum is a lookalike that overstates the
  metric; the session-window max is what earns the name.
- **Attribution rides along.** The API scores an *entry*, not a source, so the winning window's score
  is split across each entry's `sources` in proportion to their moved area (`max(currentRect,
  previousRect)` area) -- a ranking proxy for "which element shifted most", never a spec quantity.
  The top `LAYOUT_SHIFT_SOURCE_CAP` (3) elements are kept as `tag#id.class` descriptors with the
  rects they moved between.

**Probe [measured]** (Chrome 150, the committed `test/fixtures/layout-shift-probe.html`, which paints
a text LCP then forces two input-free banner-insertion shifts):

- **`--disable-gpu` is load-bearing, the same root as LCP above.** On the default GPU headless path
  the fixture produced **0** `layout-shift` entries (the frame-starved branch: no frames, no shift to
  measure); with `--disable-gpu` (the headless wpd launches) it produced both shifts. A mechanism
  would predict shifts either way; the probe says otherwise.
- A `layout-shift` entry is **not** replayed through `performance.getEntriesByType("layout-shift")`
  (that buffer read **0** even after the shifts landed) -- only the observer sees it (`buffered: true`
  replays to a late-registered observer). So the observer is the only route; a getEntries poll misses
  it.
- Both shifts had `hadRecentInput: false` and landed **<1 s apart**, so they formed **one** session
  window. Booted through the on-ramp at `--iterations 3`, wpd reported `cls` **0.1211**, `windowCount`
  1, `shiftCount` 2, attributed `body` 0.056 / `h1#hero` 0.043 / `div#banner-1` 0.018.

**Scope: CLS covers the step's observation window** ([step start mark, end-of-step flush]), not the
whole page lifetime. The on-ramp load step settles ~2 frames after the load event, so it captures the
**early** boot shifts (CSS/layout reflow) that land in that window; a page that keeps shifting after
settle needs an explicit `measureStep` `until` (or a later step) to bring those shifts inside a
window. This is the same window-scoping every per-step signal has, stated so a short-window CLS is
read as "the shift in this window", not "the page's lifetime CLS".

**Per-iteration.** Unlike LCP, CLS is stored from the **first timed iteration** (matching the
LoAF/counts windowing): the shifting-element attribution is a distribution of descriptors that cannot
be medianed like a scalar, and pooling rects across iterations would fabricate a shift no frame
produced. The `cls` scalar could be medianed, but keeping it beside its own iteration's sources is the
honest pairing.

Chrome ships the `layout-shift` entry type and Firefox does not (**[measured]** absent from
`supportedEntryTypes`), so a firefox/node step carries no `layoutShift` -- absent, never a fabricated
0, the `Measured` rule.

## Soft navigations: standards status

A **soft navigation** is a same-document route change an SPA drives with `history.pushState` plus a
DOM swap, which the platform now treats like a navigation for metrics. Status:

- The WICG Soft Navigations API is **default-on from Chrome 151**. It ran as an origin trial from
  Chrome 139 (July 2025) through a final trial in Chrome 147-149 (**[source]**, Chrome blog dated
  2026-04-20, https://developer.chrome.com/blog/final-soft-navigations-origin-trial).
- **[measured]** on Chrome 151 (Puppeteer 25.4.0) `PerformanceObserver.supportedEntryTypes` lists
  `soft-navigation` and `interaction-contentful-paint` with **no flag**; on Chrome 150 (Puppeteer
  25.2.1) both are absent unless the browser is launched with
  `--enable-features=SoftNavigationHeuristics`
  (https://developer.chrome.com/docs/web-platform/soft-navigations ,
  https://github.com/WICG/soft-navigations/blob/main/README.md).
- Chrome has **deferred** the decision to feed soft navigations into Core Web Vitals / CrUX
  (**[source]**, the same blog states the CWV integration is not decided).
- **Firefox does not implement it. [measured]** on Firefox 152 neither `soft-navigation` nor
  `interaction-contentful-paint` is in `supportedEntryTypes`.

## Why wpd does not flip the heuristic flag

The question splits by Chrome version.

**On Chrome 150 and earlier, wpd never forces the flag.**
`--enable-features=SoftNavigationHeuristics` **changes the browser under test**, and a measurement
tool must not alter the thing it measures. So on the version the repo currently pins (Puppeteer 25.2.1
/ Chrome 150) the soft-navigation entry types are simply unavailable, and wpd falls back to the
url+timeOrigin classifier below.

**On Chrome 151 and later there is no flag to flip.** **[measured]** the `soft-navigation` and
`interaction-contentful-paint` entry types are default-on (`supportedEntryTypes` lists both with no
`--enable-features`), so reading them changes nothing about the browser. wpd can read the entries where
present. A fresh `^25.2.1` install already resolves Puppeteer 25.4.0 / Chrome 151, so new users are on
the default-on browser.

Three constraints stand at every version, which is why the url+timeOrigin classifier stays the
always-available answer and a soft-navigation entry is an opportunistic overlay on top of it, never the
sole signal:

- The heuristic is **unspecified** — an implementation detail, not a W3C recommendation.
- Its CWV use is **undecided** (above), so a number keyed off it has no stable meaning yet.
- **Firefox has no support** (**[measured]** above), so relying on it alone would break the
  never-fake-parity rule the cross-engine work holds to ([engine-mapping.md](./engine-mapping.md)).

## The soft-navigation entry on Chrome 151

**[measured]** on Chrome 151 (Puppeteer 25.4.0), headless, with wpd's own launch flags. A soft
navigation is detected only when three conditions all hold:

1. a **trusted** user interaction (click/tap/keyboard, INP-aligned),
2. a same-document history change (`pushState` or `replaceState`), and
3. a contentful paint after the interaction.

**Trusted input is load-bearing, and it is the same trusted path a driver click takes.** A Puppeteer
`page.click` fires a `soft-navigation` entry headless; the same handler invoked through
`page.evaluate(() => element.click())` (an untrusted synthetic click) fires **none**, even though the
`pushState` ran and the URL changed. A driver-driven flow therefore detects; an in-page synthetic
dispatch does not.

**The 151 entry shape** (read off the live entries):

- `soft-navigation` (`PerformanceSoftNavigation`): `name` (the new URL), `startTime` (the route's time
  origin), `duration` (the route's FCP), `navigationId` (numeric), `interactionId`, `navigationType`
  (`"push"` or `"replace"`), and a `getLargestInteractionContentfulPaint()` method.
- `interaction-contentful-paint` (`InteractionContentfulPaint`): `startTime`, `paintTime`,
  `presentationTime`, `navigationId`, `interactionId`, and a nested `largestContentfulPaint`. The
  paint's identity — `element`, `size`, `url`, `renderTime` — sits on that nested
  `LargestContentfulPaint`, not on the ICP entry itself.
- The route's LCP-equivalent is
  `softNavEntry.getLargestInteractionContentfulPaint().largestContentfulPaint`, a
  `LargestContentfulPaint` carrying the same url+size+tag identifier the boot-LCP section keeps. On a
  600x400 route image it read `element: IMG`, `size 187800`, the image `url`, `renderTime ~428 ms`.
- **[measured, Chrome 151]** a cross-origin route image served WITHOUT `Timing-Allow-Origin` still
  reported a populated `renderTime` (~408 ms, distinct from its `loadTime`), not the spec's 0 the
  boot-LCP section cites for Chrome 150. So the TAO/`renderTime` rule is not assumable across versions;
  re-probe before keying on `renderTime` from a soft-nav LCP.

**navigationId slices the metrics.** Boot entries and the soft-nav entry carry distinct
`navigationId`s (one run: boot 1861, soft nav 1868), and a post-soft-nav `layout-shift` entry carries
the soft-nav's id — so per-soft-step CLS/INP/LCP are sliceable by `navigationId`. The interaction that
*triggers* the soft nav carries the pre-nav id (the interaction precedes the navigation).

**Where the Chrome 151 heuristic and wpd's url+timeOrigin classifier disagree** (verified rows only):

| Case | Chrome 151 heuristic | url+timeOrigin |
| --- | --- | --- |
| Trusted click + `pushState` + paint | soft nav | soft |
| Trusted click + `replaceState` + paint | soft nav | soft |
| Programmatic `pushState` + paint, **no interaction** | **none** | soft |
| Untrusted synthetic click + `pushState` + paint | **none** | soft |

The last two rows are the false-negative class: the classifier reads a URL change with an unchanged
`timeOrigin` as soft, while the engine, seeing no trusted interaction, records nothing. A recording
that carries both verdicts should surface the disagreement, not silently pick one.

**Integration verdicts as they stand:**

- **Read the soft-navigation entry opportunistically, where present** (Chrome 151+); keep
  url+timeOrigin as the always-available classifier and fallback (older Chrome, Firefox, programmatic
  navs). Buildable now.
- **Record both verdicts and note the disagreement** (engine heuristic vs url+timeOrigin), the
  count-disagreement pattern. Buildable now.
- **Per-soft-step ICP/CLS/INP sliced by `navigationId`** is the real SPA-metrics feature. The pieces
  measured above make it reachable; it stays gated on a trusted-interaction driver flow, since a
  programmatic or synthetic-click route produces no entry to slice.

## The url+timeOrigin classification

A step's navigation kind is decidable from two reads taken before and after the step, no CDP and no
browser flag:

- **`page.url()`** — the document URL. CDP-free (Puppeteer reads it off the page handle).
- **`performance.timeOrigin`** — the document's origin timestamp, which a full document reload resets.

The rule:

| URL | timeOrigin | kind |
| --- | --- | --- |
| unchanged | unchanged | **static** (no navigation) |
| changed | changed | **hard** (document reloaded) |
| changed | unchanged | **soft** (same-document route change) |

**[measured]** on the production SPA this agreed with Chrome's flagged heuristic **4 of 4 times**,
including a hash-only case. `timeOrigin` was **byte-identical** across every soft step (a same-document
route keeps the document, so it keeps the origin), and a threshold of >0.5 ms separates a hard
navigation cleanly — a reload moves `timeOrigin` by far more than measurement jitter.

`interaction-contentful-paint` is **not** a substitute navigation signal. It is noisier than
`soft-navigation`: it fires for pre-route typeahead paints that still carry the previous
`navigationId`, so it flags paints that are not route changes.

## The ambiguity family

Stated honestly, because the classification is a URL diff and a URL diff has known blind spots:

- **Hash-only changes.** A same-page overlay opened via `#id` changes the URL with no route change.
  Both the url+timeOrigin rule and Chrome's heuristic count it as a navigation, so it deserves its own
  sub-label rather than being folded into a route change.
- **Query-only changes.** An in-page filter that writes `?q=` is indistinguishable from a real route
  by URL alone.
- **A reverting `replaceState`.** A step that changes then restores the URL within its own window
  (`pushState` then back, or a `replaceState` that reverts) fools a before/after diff into reading
  static.
- **Cross-step URL continuity is never assumable.** Scroll-restoration and analytics can fire a
  `replaceState` *between* steps, so the URL a step ends on is not guaranteed to be the URL the next
  step starts on.

## What wpd records today

wpd records **no per-step URL** — `meta` carries only the starting host page, not where each step
navigated. The two reads the classification needs are both already at hand: `page.url()` is available
without CDP, and `driver.ts`'s `measure()` already reads `performance.timeOrigin` at both step marks
through `stepClock` (it uses the delta to detect a step that navigated). The gap between what is
recorded and what the classification needs is one stored URL per step; the timing read is already
taken.
