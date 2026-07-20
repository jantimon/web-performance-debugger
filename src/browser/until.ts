import type { Page } from "puppeteer";

/**
 * The in-page "the DOM stopped changing" detector, serialized into the page. Resolves once no
 * mutation has landed for `quietMs`, or `maxMs` elapses (a hard cap so a page that never stops
 * mutating cannot hang the step). A trailing `requestAnimationFrame` lets the last mutation paint
 * before the step's end mark. Descriptive names throughout: this is serialized, but the house rule
 * on identifiers holds in page context too.
 */
const QUIET_SOURCE = (quietMs: number, maxMs: number) =>
  new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(hardCap);
      observer.disconnect();
      requestAnimationFrame(() => resolve());
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const hardCap = setTimeout(finish, maxMs);
    quietTimer = setTimeout(finish, quietMs);
  });

export interface WaitForStableOptions {
  /**
   * A selector to wait for BEFORE the quiet check, so "the landed content is here" gates "and the
   * page has stopped changing". Skipped when absent.
   */
  selector?: string;
  /**
   * How long the DOM must go without a mutation to count as stable, ms. The helper resolves this
   * long AFTER the last mutation, so it is a deliberate tail on the measured wall, not part of the
   * transition. Default 200.
   */
  quietMs?: number;
  /**
   * Hard cap on the whole wait, ms (selector wait + quiet check). Default 30000. The selector wait
   * REJECTS on timeout (standard `page.waitForSelector`), so a step whose content never lands fails
   * loudly rather than pricing an empty wait; the quiet phase is then bounded by the remaining budget.
   */
  timeout?: number;
}

/**
 * A `measureStep` `until` that waits for a soft navigation / streamed transition to actually finish,
 * instead of the default settle (two rAF + idle), which resolves the moment the page goes briefly
 * idle -- BEFORE streamed markup lands (measured: ~57ms settle vs ~171ms real paint on a production
 * Next.js route change; docs/dev/driver-timing.md). This waits for an optional content `selector`,
 * then for the DOM to stop mutating for `quietMs`, which the default settle cannot see because a
 * streamed route keeps mutating past the first idle gap.
 *
 * Opt-in per step, never the default: the default settle is a measured trade-off, and this trades a
 * longer, more variable wall for catching the whole transition. Reach for it on a navigation-like
 * step whose content arrives in chunks.
 *
 *   import { waitForStable } from "@jantimon/web-performance-debugger";
 *   await measureStep("open-product", () => page.click(sel), {
 *     until: waitForStable(page, { selector: "#addToCartButton" }),
 *   });
 */
export function waitForStable(page: Page, options: WaitForStableOptions = {}): () => Promise<void> {
  const quietMs = options.quietMs ?? 200;
  const timeout = options.timeout ?? 30000;
  return async () => {
    const startedMs = Date.now();
    if (options.selector) await page.waitForSelector(options.selector, { timeout });
    const remainingMs = Math.max(0, timeout - (Date.now() - startedMs));
    await page.evaluate(QUIET_SOURCE, quietMs, remainingMs);
  };
}
