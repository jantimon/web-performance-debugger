# The one-frame floor on `wall` and `INP`, and why it is deterministic

Read this before changing `browser/launch.ts`'s headless option, before adding a headless flag, or
before explaining why two libraries with different re-render cost report the same `wallMs`.

`wall` and `INP` cannot report less than one display frame, because the measured interval ends at a
paint and a paint happens on a frame boundary. That floor is real and correct for a latency number.
Its height is the frame cadence. Chrome's built-in headless pins a synthetic 60 Hz (**~16.6 ms**)
regardless of the host. Firefox's cadence is **not** a fixed property: it tracks the host display, so
on a driven 120 Hz panel it reads ~8.3 ms but on an idle-panel or display-less host (CI, most dev
machines) it reads the same **~16.6 ms** as Chrome — see [The Firefox floor is
display-contingent](#the-firefox-floor-is-display-contingent). So `FIREFOX_FRAME_FLOOR_MS` is stamped
at **16.6 ms**, the reading the environments wpd runs in produce; the 8.3 ms / 120 Hz figure is
display-contingent, not a Firefox property to stamp.

wpd launches Chrome's **built-in headless** — full Chrome, windowless (Puppeteer's `headless: true`)
— as its only headless mode, plus headed via `--no-headless`. It does not launch
**chrome-headless-shell**. wpd measures how real Chrome performs; it is not a scraper or a PDF
renderer, so it runs real Chrome. Headless adds `--disable-gpu` (software compositing) to dodge an
intermittent GPU-process frame-production stall without moving the floor; see [Frame production
stalls intermittently](#frame-production-stalls-intermittently-so-headless-software-composites).

Probes below are **[measured]** on a 120 Hz ProMotion Mac, Puppeteer 25.2.1 (Chrome-for-Testing
150), and wpd's Firefox lane over BiDi. Each is a driver module timing in-page via `page.evaluate`,
launched through wpd's own `launchBrowser` (same args/viewport as any run), recorded with an explicit
`--out`.

## It is a floor, not quantization

Busy-wait N ms synchronously, then await ONE `requestAnimationFrame`, timed in-page around the whole
thing (median of 15):

| injected work | Chrome headless | Firefox headless |
| --- | --- | --- |
| 0 | 16.6 | 8.0 |
| 5 | 16.6 | 8.0 |
| 12 | 16.7 | 12.0 |
| 16 | 16.6 | 16.0 |
| 18 | **18.1** | 18.0 |
| 25 | **25.1** | 25.0 |
| 35 | **35.1** | 35.0 |

The measured value is `max(work, one_frame) + ~0.1`. Work **above** one frame reads through
**linearly** (18 -> 18.1, 25 -> 25.1); it does not round up to 2x the frame. So this is a single-frame
floor, not frame-quantization. All sub-frame work collapses onto the floor: a user comparing three
libraries whose real re-render is each under one frame sees all three report the frame time, and
reads "about the same" for work that differs several fold.

Firefox reports whole-ms values (its `performance.now()` is coarser), but the mechanism is identical.
The Firefox column here is the panel-at-120-Hz reading (~8 ms floor); on an idle panel or CI the
Firefox floor tracks the host to ~16.6 ms ([The Firefox floor is
display-contingent](#the-firefox-floor-is-display-contingent)).

## The cadence, by lane

Median of 60 consecutive `requestAnimationFrame` deltas:

| lane | cadence | rate |
| --- | --- | --- |
| Chrome **built-in headless** (`headless: true`) | **16.7 ms** | ~60 Hz (synthetic, fixed) |
| Chrome **headed** | **8.4 ms or 16.7 ms**, run to run | 120 / 60 Hz, variable |
| Firefox headless | **16.7 ms (idle panel) / 8.3 ms (driven 120 Hz)** | tracks host |
| Firefox headed | **16.7 ms (idle panel) / 8.3 ms (driven 120 Hz)** | tracks host |

Two things here are load-bearing:

- **Headed is not deterministic.** On this ProMotion Mac headed Chrome hit 120 Hz on some passes and
  fell back to 60 Hz on others: the OS grants ProMotion to a background (automated, non-foreground)
  window only intermittently. A headed benchmark flaps between a one-frame and a two-frame floor run
  to run, which is worse for a comparison than a deterministic headless floor, and it needs a real
  display (CI needs xvfb). It stays reachable via `--no-headless` for someone who explicitly wants
  it, with that caveat attached.
- **Headless Chrome's 60 Hz is a synthetic default, not the machine.** With no display driving it,
  the compositor runs `BeginFrame` at Chromium's synthetic default interval,
  `viz::BeginFrameArgs::DefaultInterval()` = 1/60 s
  (https://source.chromium.org/chromium/chromium/src/+/main:components/viz/common/frame_sinks/begin_frame_args.h).

## The Firefox floor is display-contingent

**[measured]** Firefox 152 over wpd's own launch path (raw puppeteer, `headless: true`, same args),
median of 120 consecutive `requestAnimationFrame` deltas, 4 launches: firefox headless reads
**16.66 ms (60 Hz)** and headed reads **16.66 ms** too — every launch identical (16.66, p90 16.68),
on this 120 Hz ProMotion Mac with the panel idle. Chrome headless on the same run reads 16.70 ms. So
the 8.3 ms / 120 Hz Firefox floor **does not reproduce** here.

Headless and headed move together (both ~8.3 ms when the panel is driven at 120 Hz, both 16.66 ms when
it is idle), which is the tell: unlike Chrome's built-in headless — which pins Chromium's synthetic 60
Hz `BeginFrame` regardless of the host — **Firefox tracks the host display refresh in both modes.**
The 8.3 ms figure is the panel-at-120-Hz reading, not a Firefox property. In the environments wpd
actually runs — CI (no display) and a dev machine whose panel is not being actively driven by the
automated window — Firefox sits on the same ~60 Hz / 16.6 ms floor as Chrome.

So `FIREFOX_FRAME_FLOOR_MS` (`model/frame-floor.ts`) is stamped at **16.6 ms**, the same as Chrome:
that is the reading CI and an idle-panel dev machine produce, and it is exactly where
`matchedFrameFloor` decides whether a firefox wall/INP median sits on its floor. The 8.3 ms / 120 Hz
value is the driven-panel reading only, not a firefox property; stamping it would read 2x too low on
every host wpd actually runs on.

## Why the floor is deterministic and cross-machine consistent

**[measured]** On this 120 Hz ProMotion Mac with the panel idle, headless Chrome reads 16.7 ms / 60
Hz — the synthetic default, not the host's 120 Hz. When a display is **actively driven**, the
cadence can track that live refresh rate; an idle panel and a headless (no foreground window) context
both leave the compositor on the synthetic 60 Hz. CI has no display at all, so it also sits on the
synthetic default.

So on the environments wpd runs in — CI, and a developer machine whose panel is not being actively
driven by the automated window — headless Chrome sits on one synthetic 60 Hz interval. The floor is
therefore the same 16.6 ms across machines and across CI, which is the property a comparison and CI
gating tool needs.

No supported flag pins headless Chrome to a higher rate. **[measured]**
`--disable-frame-rate-limit` alone does nothing; only `--disable-frame-rate-limit
--disable-gpu-vsync --run-all-compositor-stages-before-draw` together change the cadence, and they
change it to **uncapped** (~0 ms, an unbounded busy-loop that draws as fast as the CPU allows), not a
clean higher frame rate. That is a meaningless number for a latency floor, so wpd does not set it.

**[measured]** Passing a configured stock Chrome via `PUPPETEER_EXECUTABLE_PATH` does not change the
floor: it also runs the synthetic 60 Hz interval headless. The 60 Hz cap is the headless compositor's
synthetic default, not a Chrome-for-Testing build property.

## Frame production stalls intermittently, so headless software-composites

**[measured, Chrome 151]** On the pinned build (Puppeteer 25.4.0 / Chrome 151) this race does not
reproduce. `--in-process-gpu`, the lever that forces the stall to 100% on Chrome 150 (below), produces
every frame cleanly (0/16 boots stalled, all three probe frames each), and a default-GPU boot stalls
0/80. So the GPU-process frame-sink startup race is fixed or vanishingly rare on Chrome 151. The
`--disable-gpu` default, the frame-health probe, and the relaunch stay as belt-and-braces: they are
free (the cadence and the one-frame floor are unchanged, above), they align a dev machine's headless
with GPU-less CI, and they still defend an older Chrome pointed at via `PUPPETEER_EXECUTABLE_PATH` and
the residual. The frame-health probe itself still fires -- with `requestAnimationFrame` killed it
reports a stall at the ceiling (0.8s at an 0.8s ceiling). The rest of this section is **[measured]** on
Chrome 150, where the race is live and drives those defenses.

**[measured]** On Chrome 150 the built-in headless intermittently loses frame production: the
compositor's BeginFrame source stops producing frames, so every `requestAnimationFrame` callback
stalls (timers still fire). On the default GPU path it hits **~6% of records** [measured, 6/100
realistic 3-step x 3-iteration records], and the state is **permanent and browser-wide** -- once a
browser stalls, a fresh rAF, a re-`goto`, and a brand-new page in the same browser all stay frameless
[measured, 0/8 and 0/5 recovered], so only a fresh browser process recovers. An rAF-based settle in
that state waits to the 180s protocol timeout.

It is a **GPU-process frame-sink race**, not a focus / occlusion / visibility one:
`document.visibilityState` reads `visible` throughout, and the levers that would clear an
inactive-page stall do not help or make it worse -- CDP `Emulation.setFocusEmulationEnabled` **17.5%**,
`page.bringToFront()` **10%**, `Page.setWebLifecycleState('active')` **10%**, a live CSS animation
**8.3%**, `--disable-features=CalculateNativeWinOcclusion` **7.5%** (each vs the ~6% base). Forcing
the GPU in-process (`--in-process-gpu`) makes it **100%**, which pins the cause to the GPU-process
frame-sink startup. `HeadlessExperimental.beginFrame`, the old manual frame drive, does not exist on
built-in headless (https://chromedevtools.github.io/devtools-protocol/tot/HeadlessExperimental/).

So headless launches with **`--disable-gpu`** (software compositing via SwiftShader, a different
frame-sink path): it cuts the stall to **~0.5%** [measured, 1/200] with **no measurement distortion**
-- rAF cadence stays **16.7 ms**, the one-frame floor table is identical (`max(work, 16.6)`), and the
forced-layout probe is unchanged (43 forced flushes, 42 thrash) -- because the synthetic 60 Hz
BeginFrame default is set by the display compositor, not the GPU. Headless CI has no GPU regardless,
so this also aligns a developer machine's headless with CI. Headed (`--no-headless`) keeps the GPU: it
drives a real window off a real display, where the stall does not occur.

The residual ~0.5% is caught by a belt to that brace, in two places. The driver's settle bounds each
rAF at `STALL_CEILING_MS` (3 s, far above the ~24 ms worst legit frame gap, far below the protocol
timeout): a rAF past it is a stall, so the settle throws a retryable frame-stall error and `record`'s
`retryTransientNav` relaunches the whole pass on a fresh browser (`meta.notes` discloses it, via
`frameStallRetried`); exhausting the retries fails loudly rather than emitting a frameless recording.
But a settle only runs at a step's end, so a born-dead browser would first hang the flow's own rAF
waits -- including a user `page.waitForFunction`, whose **default polling is `requestAnimationFrame`**
and so never re-checks its predicate on a dead compositor, hanging to the protocol timeout (an error
the retry cannot classify). So the driver also runs a **frame-health probe** before the flow's first
action (`FRAME_PROBE_SOURCE`, `FRAME_PROBE_FRAMES` bounded frames): the stall shows by the second
frame after a load [measured], so the probe catches a born-dead browser and throws the same retryable
error before any wait can hang. **[measured]** Over 150 launches at the base rate, the probe flags
exactly the 25 browsers whose rAF-polling wait would hang -- no miss, no false positive. Mid-run
deaths (a later navigation) are caught by that step's settle. The same stall degrades LCP timing on
the losing browser (docs/dev/navigation-and-lcp.md).

## The two headless implementations

chrome-headless-shell and Chrome's built-in headless are two different browsers, not one browser with
a flag:

- **chrome-headless-shell** is a separate, standalone binary: the old headless implementation, kept
  as a scraping / PDF-rendering tool. It shares Blink and V8 with Chrome but not the `//chrome`
  browser layer, so it has its **own network stack** and lacks features that live above the content
  layer. Chrome keeps it only to "retain the old Headless functionality" and lists no maintenance
  roadmap (https://developer.chrome.com/blog/chrome-headless-shell).
- **Chrome's built-in headless** IS full Chrome, running without a visible window — the same browser,
  network stack, and feature set a user drives (https://developer.chrome.com/docs/chromium/headless).

That difference is not cosmetic. A production CDN can deterministically reject the shell's HTTP/2
(`net::ERR_HTTP2_PROTOCOL_ERROR`) while built-in headless — which shares Chrome's network stack —
loads the same URL. Running real Chrome is what lets wpd record the sites a user actually ships.

Built-in headless costs more to launch: **[measured]** ~668 ms vs the shell's ~288 ms (~2.3x, about
+380 ms per invocation). That is a per-launch cost wpd pays once per recording, in exchange for
measuring the browser the user ships and a floor that is the same on every machine.

## What measurement tools do

Lighthouse migrated its own test suites to `--headless=new` (Chrome's built-in headless) and
recommends it; one of its audits is impossible on old headless. Nothing in Lighthouse reads frame
cadence: its metrics are trace-derived, and frame cadence is absent from its variance model. So the
established web-performance tooling both runs real Chrome and does not treat the headless frame
cadence as a measurement input — the same position wpd takes.

## The settle floor is exactly twice the frame

`measureStep`'s settle is two `requestAnimationFrame`s (`browser/settle.ts`, and `paintFlush` in
`browser/driver.ts`). On Chrome's built-in headless (16.6 ms frame) an empty-action step measures
**~31 ms** wall, ~= 2 x 16.6 (slightly under 2 x 16.7 because the first rAF lands partway into the
current frame): the "~31 ms settle floor" [driver-timing.md](./driver-timing.md) records. On Firefox
the same 2-rAF settle floor is ~2x the host cadence — ~16 ms on a driven 120 Hz panel, ~33 ms on the
idle-panel / CI 60 Hz case (above).

## What this means for reading the numbers

The floor is a defect only if you read `wall`/`INP` as *work*. It is the correct answer to the
question those signals ask: **when did the next frame paint?** On a 60 Hz frame that genuinely is
~16.6 ms; the user feels the frame boundary, not the sub-frame work. The work is not hidden, it is on
a different axis:

- **How much work does my code do?** -> `--bench` (times `run()` alone, no frame wait), the counts,
  and CPU self-time. This is where a 12 ms re-render shows as 12 ms regardless of frame cadence.
- **What latency does the interaction have?** -> `wall`/`INP`, floor included, because the floor is
  part of the latency.

So the fix for "the floor hides a library's re-render" is not to remove the floor; it is to price the
code on the work axis, and to know `wall`/`INP` carries a one-frame floor.

The realism reading — most physical displays are still 60 Hz, so 16.6 ms is close to a median user's
frame budget — layers on top of the number for free, but is subordinate: wpd is a comparison and
debugging tool, not a field-RUM predictor, and its own trust tier calls `wall`/`INP` directional.

## How the code reads it

`model/frame-floor.ts` maps a recording's lane to its floor: headless Chrome ->
`CHROME_HEADLESS_FRAME_FLOOR_MS` (16.6), Firefox headless -> `FIREFOX_FRAME_FLOOR_MS` (16.6, the same
value — the display-tracked reading on CI / an idle panel, [display-contingent](#the-firefox-floor-is-display-contingent)),
headed -> none (it flaps, so no floor can be claimed). `matchedFrameFloor` decides when a wall/INP
median sits on a WHOLE MULTIPLE of its floor (within ~1.2 ms, `n` up to 4): `n = 1` is a sub-frame
measure/INP, `n >= 2` a value that waited a whole number of extra frames (a 33.2 ms two-frame wall).
It returns `{ floorMs, multiple }`, exposed on the `query span` JSON view as `frameFloor` so a consumer
can detect flooring programmatically. `frameFloorDominates` gates an elevated multiple on the window's
wait share (idle for a wall, presentation delay for an INP): a busy 33 ms wall (real work near two
frames) is not mislabeled a floor, while a wait-dominated one is. `query span` surfaces the faster
sample and the js slice beside a floored median so it does not read as "no difference".

### Why the wait-share cutoff is 0.8

`frameFloorDominates` fires the `n >= 2` label only when the wait share reaches
`IDLE_DOMINANT_SHARE` (0.8). **[measured]** probe: a driver step spins the page's main thread for a
set number of ms (real work, layout touched so it is not pure JS), then settles into the next frame,
sweeping the busy time so the idle share of a two-frame wall moves across the band.

| step busy | wall (ms) | matched multiple | idle share | real work in the wall | labeled floor? |
| --- | --- | --- | --- | --- | --- |
| ~0 ms | 32.0 | n=2 | **0.96** | 1.2 ms | **yes** |
| ~8 ms | 33.1 | n=2 | **0.74** | 8.6 ms | no |

On a 33 ms two-frame wall the 0.8 cutoff is 6.6 ms of real work: below it the label reads "the work is
sub-frame, the second frame is pure wait" (the 1.2 ms span); above it the span keeps its real-work
reading (the 8.6 ms span, half a frame of work, is not hidden behind a floor). The cutoff sits well
clear of both measured spans, so there is no realistic mislabel band, and it errs toward *not* claiming
a floor — the safe direction, since the frame-floor doc's whole point is to price a library's re-render
on the work axis rather than let a floor label swallow it. The same 0.8 is the `idleShareSuffix`
threshold (`output/ascii.ts`) that tags a span wall `~N% idle`: both answer "is this window
wait-dominated," so they share one exported constant.

The comparability gate (`model/compat.ts`) keys on `meta.headlessMode`: a current headless chrome
recording stamps `"new"`, an older one may carry `"shell"`, and a headed one carries nothing. A diff
across differing values refuses, so a recording taken at the ~8.3 ms shell floor never diffs against a
~16.6 ms built-in-headless one as if the floor were the same.
