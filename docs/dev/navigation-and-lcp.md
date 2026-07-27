# Navigation classification and LCP under wpd's conditions (internal)

> **Developer notes, not user documentation.** Nothing here is needed to *use* wpd; read the
> [README](../../README.md) for that. This file records what a Largest Contentful Paint entry and a
> soft-navigation signal look like under the conditions wpd actually records under (headless Chrome,
> a driven page, trusted input), and how a step's navigation kind is decided without a CDP call. Read
> it before wiring an LCP number into a span, or before deriving a static/hard/soft label for a step.

**In this file:** [LCP fires under headless Chrome and Firefox](#lcp-fires-under-headless-chrome-and-firefox)
· [the useful LCP identifier is url+size+tag](#the-useful-lcp-identifier-is-urlsizetag)
· [LCP finalizes on a trusted input and re-arms per document](#lcp-finalizes-on-a-trusted-input-and-re-arms-per-document)
· [the headless startTime anomaly](#the-headless-starttime-anomaly)
· [soft navigations: standards status](#soft-navigations-standards-status)
· [why wpd does not flip the heuristic flag](#why-wpd-does-not-flip-the-heuristic-flag)
· [the url+timeOrigin classification](#the-urltimeorigin-classification)
· [the ambiguity family](#the-ambiguity-family)
· [what wpd records today](#what-wpd-records-today)

**Provenance.** Facts are **[measured]** on Chrome 150 (Puppeteer 25.2.1) and Firefox 152, either
against synthetic probes or against one traced four-step journey on **a production Next.js SPA**
(a heavy, hydrating framework page, named here only as such). External standards status is
**[source]** with a dated link. Nothing is read off vendor docs alone where a probe was possible.

## LCP fires under headless Chrome and Firefox

**[measured]** `largest-contentful-paint` entries fire under Chrome's built-in headless (the browser
wpd launches) and Firefox 152; the API is Baseline cross-browser
(https://developer.mozilla.org/en-US/docs/Web/API/LargestContentfulPaint ,
https://caniuse.com/mdn-api_largestcontentfulpaint).

Firefox's `element`/`url`/`size` fidelity is **unprobed**. Chrome populates all three; whether
Firefox names the same element and reports a matching size is not established, so do not claim
cross-engine LCP parity without running the probe in both engines first.

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

**No soft navigation ever produced a new LCP entry** on the production SPA — not a route change, not a
hash change. So a per-soft-step LCP is structurally empty: there is nothing to attribute to a step
that did not reload the document. The clean semantic is therefore **boot LCP, up to the first
interaction** — one number for the cold load, not a per-step series. LCP is a paint timestamp on the
page's own clock, so it sits in the wall tier: directional, not exact.

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

## Soft navigations: standards status

A **soft navigation** is a same-document route change an SPA drives with `history.pushState` plus a
DOM swap, which the platform is learning to treat like a navigation for metrics. Status, **[source]**
with dates:

- The WICG Soft Navigations API is **shipping, not abandoned**. Origin trial from Chrome 139
  (July 2025); a final origin trial runs Chrome 147-149 (Chrome blog dated 2026-04-20,
  https://developer.chrome.com/blog/final-soft-navigations-origin-trial); default-on is projected
  around Chrome 151.
- Chrome has **deferred** the decision to feed soft navigations into Core Web Vitals / CrUX — the
  same blog states the CWV integration is not decided.
- The feature is behind `--enable-features=SoftNavigationHeuristics` today, exposing the
  `soft-navigation` and `interaction-contentful-paint` entry types
  (https://developer.chrome.com/docs/web-platform/soft-navigations ,
  https://github.com/WICG/soft-navigations/blob/main/README.md).

## Why wpd does not flip the heuristic flag

Four reasons, each on its own:

1. `--enable-features=SoftNavigationHeuristics` **changes the browser under test**. A measurement tool
   must not alter the thing it measures.
2. The heuristic is **unspecified** — an implementation detail that can move between Chrome versions.
3. Its CWV use is **undecided** (above), so a number keyed off it has no stable meaning yet.
4. **Firefox has no support**, so relying on it would break the never-fake-parity rule the cross-engine
   work holds to ([engine-mapping.md](./engine-mapping.md)).

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
