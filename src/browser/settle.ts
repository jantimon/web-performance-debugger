/**
 * In-page "step is done" signal: two animation frames each followed by an idle
 * callback. Covers the common state update -> rAF render -> microtask cleanup pattern.
 */
export const SETTLE_SOURCE = () =>
  new Promise<void>((resolve) => {
    const win = window as unknown as {
      requestIdleCallback?: (callback: () => void, opts?: { timeout: number }) => void;
    };
    const idle = (callback: () => void) =>
      win.requestIdleCallback
        ? win.requestIdleCallback(() => callback(), { timeout: 200 })
        : setTimeout(callback, 50);
    requestAnimationFrame(() => idle(() => requestAnimationFrame(() => idle(() => resolve()))));
  });
