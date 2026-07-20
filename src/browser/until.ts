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
 *
 * A HARD cross-document navigation mid-wait (a `window.location` swap, a meta refresh, a server
 * redirect the step lands on) destroys the execution context the quiet check runs in. That is a
 * transition to observe, not a failure, so the destroyed-context rejection is caught and the wait
 * re-attaches to the new document, bounded by the same deadline.
 */
/** Pause before a selector-less retry so a page that keeps hard-redirecting cannot spin the quiet
 * check against CDP; the shared deadline still bounds the whole wait. */
const RETRY_BACKOFF_MS = 50;

export function waitForStable(page: Page, options: WaitForStableOptions = {}): () => Promise<void> {
  const quietMs = options.quietMs ?? 200;
  const timeout = options.timeout ?? 30000;
  return async () => {
    const deadlineMs = Date.now() + timeout;
    if (options.selector) await page.waitForSelector(options.selector, { timeout });
    // A hard navigation while the quiet check runs destroys its execution context; re-attach to the
    // new document and keep waiting for IT to go quiet. The deadline is shared across attempts, so a
    // page that keeps hard-redirecting cannot outlast the caller's timeout.
    for (;;) {
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      if (remainingMs === 0) return;
      try {
        await page.evaluate(QUIET_SOURCE, quietMs, remainingMs);
        return;
      } catch (error) {
        if (!isDestroyedContextError(error) || Date.now() >= deadlineMs) throw error;
        // The document navigated out from under the quiet check. If a content selector gates the
        // wait, let the new document reach it before retrying (swallow its own timeout: the shared
        // deadline is the real bound); otherwise pause briefly so a redirect storm cannot spin the
        // retry against CDP, still bounded by the shared deadline.
        if (options.selector) {
          const untilDeadlineMs = Math.max(0, deadlineMs - Date.now());
          await page
            .waitForSelector(options.selector, { timeout: untilDeadlineMs })
            .catch(() => {});
        } else {
          const backoffMs = Math.min(RETRY_BACKOFF_MS, Math.max(0, deadlineMs - Date.now()));
          if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
  };
}

/**
 * Whether a thrown error is Puppeteer's "the execution context went away under me because the frame
 * navigated" family, as opposed to a real failure (a closed target, a broken evaluate). A hard
 * cross-document navigation raises one of these while `page.evaluate` is mid-flight; matching the
 * message is the only signal Puppeteer gives (it does not type these).
 */
export function isDestroyedContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /execution context was destroyed/i.test(message) ||
    /execution context is not available/i.test(message) ||
    /cannot find context with specified id/i.test(message)
  );
}
