import type { Page } from "puppeteer";
import {
  BotWallError,
  classifyBotWall,
  type BotWallSignals,
  type BotWallVerdict,
} from "../record/bot-wall.js";

/** Fraction of the viewport an iframe must cover on BOTH axes to count as "dominant" (a full-viewport
 * challenge interstitial, not a small embedded widget). Generous on each axis so a challenge frame
 * with a little chrome around it still reads as dominant, tight enough that a form widget does not */
const DOMINANT_IFRAME_MIN_FRACTION = 0.6;

/**
 * Read the bot-wall signals out of the live page. Runs one `page.evaluate` for the DOM-derived
 * signals (title, iframes with their viewport coverage, interactive-element count, body text,
 * meta-refresh) and reads the top-document URL from the page handle (CDP-free, lane-neutral). A frame
 * that failed to load still has a `src` attribute and a layout rect, so a cross-origin challenge
 * iframe is measured by geometry without reading its (blocked) content.
 *
 * Every read here is layout-non-forcing. This collector can run while the measured `wpd:run` window is
 * open: a driver module's own hard navigation is inspected mid-flow (the on-ramp site is kept outside
 * the window in `driver.ts`, but this one has no out-of-window moment). A synchronous forced flush
 * would land in the run span's layout/style counts, so iframe coverage comes from an
 * `IntersectionObserver` (the browser hands each rect from its own post-layout rendering step) and the
 * near-empty-DOM signal from `textContent`, never `getBoundingClientRect` or `innerText`, both of which
 * force a flush. [measured] a page storming layout every task gains no layout/style event from this
 * pass, and no frame of this file reaches the `--deep` event log.
 */
export async function collectBotWallSignals(page: Page): Promise<BotWallSignals> {
  const dom = (await page.evaluate(async (minFraction: number) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const viewportArea = Math.max(1, viewportWidth * viewportHeight);
    const iframeSrcs: string[] = [];
    const framed: { element: Element; src: string }[] = [];
    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      const src = frame.getAttribute("src") || (frame as HTMLIFrameElement).src || "";
      if (!src) continue;
      iframeSrcs.push(src);
      framed.push({ element: frame, src });
    }
    // Viewport coverage via IntersectionObserver, resolved once every observed iframe has reported (or
    // a bounded timeout, so a page that never renders a frame cannot hang the inspection). window.inner*
    // is a cached viewport read (non-forcing); entry.boundingClientRect is the browser's own value, so
    // the coverage test matches the geometry a getBoundingClientRect would return without forcing it
    const dominant = new Set<string>();
    await new Promise<void>((resolve) => {
      if (framed.length === 0) {
        resolve();
        return;
      }
      let done = false;
      const reported = new Set<Element>();
      const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        resolve();
      };
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          reported.add(entry.target);
          const box = entry.boundingClientRect;
          const coversWidth = box.width >= viewportWidth * minFraction;
          const coversHeight = box.height >= viewportHeight * minFraction;
          const coversArea = (box.width * box.height) / viewportArea >= minFraction;
          if (coversWidth && coversHeight && coversArea) {
            const match = framed.find((candidate) => candidate.element === entry.target);
            if (match) dominant.add(match.src);
          }
        }
        if (reported.size >= framed.length) finish();
      });
      for (const frame of framed) observer.observe(frame.element);
      setTimeout(finish, 300);
    });
    const dominantIframeSrcs = [...dominant];
    const interactiveElementCount = document.querySelectorAll(
      "input, button, a[href], select, textarea",
    ).length;
    // textContent, not innerText: innerText forces a layout flush, textContent does not. The
    // near-empty-DOM threshold is generous, so counting script/hidden text too costs no discrimination
    const bodyTextLength = (document.body?.textContent || "").trim().length;
    // http-equiv="refresh" with a url=... target; the JS-redirect loop shows up as the settled URL,
    // which mainDocumentUrl already carries
    let metaRefreshUrl: string | null = null;
    const meta = document.querySelector('meta[http-equiv="refresh" i]');
    const content = meta?.getAttribute("content") || "";
    const match = content.match(/url\s*=\s*(.+)$/i);
    if (match) metaRefreshUrl = match[1].trim().replace(/^['"]|['"]$/g, "");
    // Cloudflare inline managed-challenge tells (see record/bot-wall.ts): every script src (the .src
    // property is the resolved absolute URL, so a relative /cdn-cgi/... script reads same-origin), the
    // _cf_chl_opt page global the interstitial sets, and the __cf_chl_rt_tk runtime token in the served
    // markup. Reading outerHTML once (returning only a boolean) keeps the whole document in-page
    const scriptSrcs = Array.from(document.querySelectorAll("script[src]"))
      .map((script) => (script as HTMLScriptElement).src || script.getAttribute("src") || "")
      .filter((src) => !!src);
    const cfChallengeGlobal = typeof (window as any)._cf_chl_opt !== "undefined";
    const documentHasCfChallengeToken = (document.documentElement?.outerHTML || "").includes(
      "__cf_chl_rt_tk",
    );
    return {
      title: document.title || "",
      iframeSrcs,
      dominantIframeSrcs,
      interactiveElementCount,
      bodyTextLength,
      metaRefreshUrl,
      scriptSrcs,
      cfChallengeGlobal,
      documentHasCfChallengeToken,
    };
  }, DOMINANT_IFRAME_MIN_FRACTION)) as Omit<BotWallSignals, "mainDocumentUrl">;
  return { mainDocumentUrl: page.url(), ...dom };
}

/**
 * Inspect the settled page for a bot-challenge interstitial. Always collects + classifies so the
 * verdict is returned (a detected-but-allowed run stamps a loud note). When it is a wall and
 * `allow` is false, saves a screenshot as proof and throws a `BotWallError` -- failing BEFORE any
 * measurement pass, with no recording written. The screenshot is best-effort: if it cannot be
 * captured (a lane/driver that does not support it), the refusal still fires, naming the gap
 */
export async function inspectBotWall(
  page: Page,
  config: { allow: boolean; screenshotPath: string },
): Promise<BotWallVerdict> {
  const signals = await collectBotWallSignals(page);
  const verdict = classifyBotWall(signals);
  if (!verdict.detected || config.allow) return verdict;
  let savedPath: string | null = null;
  try {
    await page.screenshot({ path: config.screenshotPath as `${string}.png`, fullPage: false });
    savedPath = config.screenshotPath;
  } catch {
    // A screenshot failure must never swallow the refusal: fall through and throw with a null path
    savedPath = null;
  }
  throw new BotWallError(verdict, savedPath);
}
