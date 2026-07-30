/** Ceiling (ms) on a single settle `requestAnimationFrame`. Well above any real frame gap (the worst
 * legit gap is ~24ms even under load [measured]) and well below the 180s protocol timeout, so a
 * frame-production stall -- where rAF never fires -- is caught in one ceiling and turned into a
 * retryable error instead of a protocol hang. See frameStallError in browser/launch.ts */
export const STALL_CEILING_MS = 3000;

/**
 * In-page "step is done" signal: two animation frames each followed by an idle callback. Covers the
 * common state update -> rAF render -> microtask cleanup pattern. Each rAF is raced against
 * `ceilingMs`: if the compositor's BeginFrame source has stalled (rAF never fires, timers still do),
 * it resolves `{ stalled: true }` at the ceiling so the driver relaunches rather than hanging. A
 * healthy run resolves `{ stalled: false }` after the second frame + idle, unchanged
 */
export const SETTLE_SOURCE = (ceilingMs: number) =>
  new Promise<{ stalled: boolean }>((resolve) => {
    const win = window as unknown as {
      requestIdleCallback?: (callback: () => void, opts?: { timeout: number }) => void;
    };
    const idle = (callback: () => void) =>
      win.requestIdleCallback
        ? win.requestIdleCallback(() => callback(), { timeout: 200 })
        : setTimeout(callback, 50);
    // Request one frame; if it does not arrive within the ceiling, report a stall instead of waiting
    const frameThen = (next: () => void) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ stalled: true });
      }, ceilingMs);
      requestAnimationFrame(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        next();
      });
    };
    frameThen(() => idle(() => frameThen(() => idle(() => resolve({ stalled: false })))));
  });

/** Frames the start-of-flow health probe requests. The stall shows by the SECOND frame after a load
 * (the first rAF rides the load's own frame; the second needs a fresh BeginFrame, which is where the
 * source intermittently fails to arm), so three frames catch it with a margin [measured] */
export const FRAME_PROBE_FRAMES = 3;

/**
 * Start-of-flow frame-health probe: request `FRAME_PROBE_FRAMES` bounded animation frames before any
 * user action runs. Chrome's built-in headless can come up with a dead compositor BeginFrame source
 * (permanent, browser-wide), which would hang any later rAF-based wait -- a settle, or a user
 * `page.waitForFunction` whose default polling is rAF -- to the protocol timeout. Resolving
 * `{ stalled: true }` at the ceiling lets the driver convert that into a retryable frame-stall error
 * before the flow can hang on it. A healthy browser resolves `{ stalled: false }` in ~3 frames
 */
export const FRAME_PROBE_SOURCE = (ceilingMs: number, frames: number) =>
  new Promise<{ stalled: boolean }>((resolve) => {
    const frameThen = (remaining: number) => {
      if (remaining === 0) {
        resolve({ stalled: false });
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ stalled: true });
      }, ceilingMs);
      requestAnimationFrame(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        frameThen(remaining - 1);
      });
    };
    frameThen(frames);
  });

/**
 * A bounded double `requestAnimationFrame` (the `paintFlush` after an explicit `until`): waits two
 * frames so a deferred paint lands, with the same per-frame stall ceiling as SETTLE_SOURCE
 */
export const PAINT_FLUSH_SOURCE = (ceilingMs: number) =>
  new Promise<{ stalled: boolean }>((resolve) => {
    const frameThen = (next: () => void) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ stalled: true });
      }, ceilingMs);
      requestAnimationFrame(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        next();
      });
    };
    frameThen(() => frameThen(() => resolve({ stalled: false })));
  });
