# The one-frame floor on `wall` and `INP`, and which headless mode sets it

Read this before changing `browser/launch.ts`'s headless option, before adding a `--headless-mode`
flag, or before explaining why two libraries with different re-render cost report the same `wallMs`.

`wall` and `INP` cannot report less than one display frame, because the measured interval ends at a
paint and a paint happens on a frame boundary. That floor is real and correct for a latency number,
but its height depends on the frame cadence, which is a property of the **headless mode**, not the
engine or the machine. wpd defaults to **shell-headless** (chrome-headless-shell, ~120 Hz, ~8.3 ms
floor); `--headless-mode new` selects new-headless (~60 Hz, ~16.6 ms floor).

Probes below are **[measured]** on a 120 Hz ProMotion Mac, Puppeteer 25.2.1 (Chrome-for-Testing
150), Playwright chromium 149, and wpd's Firefox lane over BiDi. Each is a driver module timing
in-page via `page.evaluate`, launched through wpd's own `launchBrowser` (same args/viewport as any
run), recorded with an explicit `--out`.

## It is a floor, not quantization

Busy-wait N ms synchronously, then await ONE `requestAnimationFrame`, timed in-page around the whole
thing (median of 15):

| injected work | Chrome new-headless | Firefox headless |
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

Firefox reports whole-ms values (its `performance.now()` is coarser), but the mechanism is
identical: a lower floor (~8 ms) through which the 8-16 ms band separates.

## The cadence, by mode and engine

Median of 60 consecutive `requestAnimationFrame` deltas:

| lane | cadence | rate |
| --- | --- | --- |
| Chrome **new-headless** (`--headless-mode new`; Puppeteer's `headless: true`) | **16.7 ms** | ~60 Hz |
| Chrome **shell-headless** (wpd default; `headless: 'shell'`) | **8.3 ms** | ~120 Hz |
| Chrome **headed** | **8.4 ms or 16.7 ms**, run to run | 120 / 60 Hz, variable |
| Firefox headless | **8.3 ms** | ~120 Hz |
| Firefox headed | **8.3 ms** | ~120 Hz |

Two things here are counter-intuitive and both are load-bearing:

- **Headed is not deterministic.** On this ProMotion Mac headed Chrome hit 120 Hz on some passes and
  fell back to 60 Hz on others: the OS grants ProMotion to a background (automated, non-foreground)
  window only intermittently. A headed benchmark flaps between a one-frame and a two-frame floor run
  to run, which is worse for a comparison than either deterministic mode, and it needs a real display
  (CI needs xvfb).
- **Headless Chrome's 60 Hz is not the machine and not a missing display.** Firefox-headless and
  Chrome-**shell**-headless both run 120 Hz on the same machine. The 60 Hz is specific to Chrome
  **new**-headless.

## The cause is the headless mode, not flags and not the build

Isolated by crossover **[measured]**:

- Puppeteer + its own Chrome, `headless: true` (new headless) -> **16.7 ms**.
- Puppeteer + its own Chrome, `headless: 'shell'` -> **8.3 ms**.
- Puppeteer + **Playwright's** chromium binary + wpd's args -> **16.7 ms** (so it is not the build).
- Playwright + its own chromium, every config incl. wpd's exact args -> **8.3 ms**.
- Puppeteer + a configured **ordinary Chrome** (`PUPPETEER_EXECUTABLE_PATH`), `headless: 'shell'` ->
  **8.3 ms**. A stock Chrome build has no shell binary, so Puppeteer skips managed shell resolution
  and passes the bare `--headless` flag; the floor is still shell's ~8.3 ms, and the stamped mode
  agrees with the observed floor. The 16.7 ms / 60 Hz cap reproduces only on Chrome-for-Testing's
  `--headless=new`, not on this configured executable.

Puppeteer 25 resolves `headless: true` to **new** headless (a full Chrome), which rate-limits
`BeginFrame` to ~60 Hz. **chrome-headless-shell** runs `BeginFrame` at ~120 Hz, and Playwright's
default behaves like shell. wpd defaults to `headless: 'shell'` (`resolveHeadless` in
`src/browser/launch.ts`), so it runs the ~120 Hz / 8.3 ms floor and lines up with Playwright-based
harnesses; `--headless-mode new` selects the new-headless 60 Hz floor.

Flags do not fix it cleanly: `--disable-frame-rate-limit` alone does nothing; only
`--disable-frame-rate-limit --disable-gpu-vsync --run-all-compositor-stages-before-draw` together
change the cadence, and they change it to **uncapped** (~0 ms, unbounded), not a clean 8.3. The mode
is the knob, not the flags.

## The settle floor is exactly twice this

`measureStep`'s settle is two `requestAnimationFrame`s (`browser/settle.ts`, and `paintFlush` in
`browser/driver.ts`). Under `--headless-mode new` (16.6 ms frame) an empty-action step measures
**30.7 ms** wall, ~= 2 x 16.6 (slightly under 2 x 16.7 because the first rAF lands partway into the
current frame): the "~31 ms settle floor" [driver-timing.md](./driver-timing.md) records. On the
default shell mode (8.3 ms frame), and on Firefox, the same 2-rAF settle floor is ~16 ms, so the
default halves the biggest fixed cost in a driver step's wall.

## What this means for reading the numbers

The floor is a defect only if you read `wall`/`INP` as *work*. It is the correct answer to the
question those signals ask: **when did the next frame paint?** On a 60 Hz frame that genuinely is
~16.6 ms; the user feels the frame boundary, not the sub-frame work. The work is not hidden, it is on
a different axis:

- **How much work does my code do?** -> `--bench` (times `run()` alone, no frame wait), the counts,
  and CPU self-time. This is where a 12 ms re-render shows as 12 ms regardless of frame cadence.
- **What latency does the interaction have?** -> `wall`/`INP`, floor included, because the floor is
  part of the latency.

So the fix for "the floor hides emotion's re-render" is not to remove the floor; it is to price the
code on the work axis, and to know `wall`/`INP` carries a one-frame floor.

## The mode decision

wpd's default is **shell-headless (120 Hz / 8.3 ms)**. Of the deterministic modes it is the right
default for three reasons:

1. **Resolution is recoverable; coarseness is not.** An 8.3 ms floor contains the 60 Hz answer (round
   work up to the next 16.6 ms to model a 60 Hz user). A 16.6 ms floor has already destroyed every
   distinction in the 8-16 ms band, which is exactly where close libraries differ.
2. **It matches the references.** Playwright and the gen harness both run 8.3 ms, so cross-tool
   numbers line up instead of sitting 2x apart.
3. **It halves the settle floor** (~31 -> ~16 ms), the largest fixed cost in a driver wall.

The realism argument for 60 Hz (most physical displays are still 60 Hz, so 16.6 ms is closer to a
median user's frame budget) is real but subordinate: wpd is a comparison and debugging tool, not a
field-RUM predictor, and its own trust tier calls `wall`/`INP` directional. A comparison tool is
optimized for signal separation; the "what would a 60 Hz user feel" reading layers on top of a
fine-grained number and cannot be extracted from a coarse one.

Headed is realistic but disqualified as a *default* by its non-determinism above; it stays reachable
via `--no-headless` for someone who explicitly wants it, with that caveat attached.

Implemented shape: default to shell, with `--headless-mode new` for faithful new-Chrome or a 60 Hz
model and `--no-headless` for headed, and the floor documented either way.

## What is established, and what is still open

- **[measured] shell-headless changes only the cadence.** On the same forced-layout probe,
  `layoutCount`/`styleCount`/`paintCount` and the forced counts are byte-identical between shell and
  new-headless, forced-layout blame is identical, and CPU self-time overlaps; only the rAF cadence
  (and therefore `wall`/`INP`) moves. Full e2e is green under shell. It is the same Blink
  layout/style/paint pipeline, so the rendering-cost path does not diverge; the feature-level
  divergences of new-headless vs the automation build (extensions, printing, some APIs) do not touch
  layout/style/paint attribution.
- **[assumption] shell's cadence on non-ProMotion hardware.** Shell measured 120 Hz here, on a 120 Hz
  machine. Whether shell tracks the physical display (and would report 60 Hz on a 60 Hz host) or runs
  a fixed 120 Hz `BeginFrame` regardless is not established. It matters for reproducibility across
  contributor machines and CI. Verification recipe: run `examples/forces-layout.mjs` on a native
  60 Hz display and read the median rAF delta / the empty-step settle floor; a fixed 8.3 ms holds the
  claim, a 16.6 ms means shell tracks the display and the floor is host-dependent.
- **[assumption] gen's ~8 ms is shell-mode cadence, not headed.** Playwright's chromium measured
  8.3 ms headless here, which matches gen's number, but whether gen itself runs headed or headless is
  not confirmed. If gen runs headed on a ProMotion Mac, its ~8 ms is the display, and the
  Playwright-vs-Puppeteer framing is a coincidence of two different 120 Hz sources.
