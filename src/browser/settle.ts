/** Ceiling (ms) on a single settle `requestAnimationFrame`. Well above any real frame gap (the worst
 * legit gap is ~24ms even under load [measured]) and well below the 180s protocol timeout, so a
 * frame-production stall -- where rAF never fires -- is caught in one ceiling and turned into a
 * retryable error instead of a protocol hang. See frameStallError in browser/launch.ts. */
export const STALL_CEILING_MS = 3000;

/**
 * In-page "step is done" signal: two animation frames each followed by an idle callback. Covers the
 * common state update -> rAF render -> microtask cleanup pattern. Each rAF is raced against
 * `ceilingMs`: if the compositor's BeginFrame source has stalled (rAF never fires, timers still do),
 * it resolves `{ stalled: true }` at the ceiling so the driver relaunches rather than hanging. A
 * healthy run resolves `{ stalled: false }` after the second frame + idle, unchanged.
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
    // Request one frame; if it does not arrive within the ceiling, report a stall instead of waiting.
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

/**
 * A bounded double `requestAnimationFrame` (the `paintFlush` after an explicit `until`): waits two
 * frames so a deferred paint lands, with the same per-frame stall ceiling as SETTLE_SOURCE.
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
