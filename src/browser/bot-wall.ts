import type { Page } from "puppeteer";
import {
  BotWallError,
  classifyBotWall,
  type BotWallSignals,
  type BotWallVerdict,
} from "../record/bot-wall.js";

/** Fraction of the viewport an iframe must cover on BOTH axes to count as "dominant" (a full-viewport
 * challenge interstitial, not a small embedded widget). Generous on each axis so a challenge frame
 * with a little chrome around it still reads as dominant, tight enough that a form widget does not. */
const DOMINANT_IFRAME_MIN_FRACTION = 0.6;

/**
 * Read the bot-wall signals out of the live page. Runs one `page.evaluate` for the DOM-derived
 * signals (title, iframes with their viewport coverage, interactive-element count, body text,
 * meta-refresh) and reads the top-document URL from the page handle (CDP-free, lane-neutral). A frame
 * that failed to load still has a `src` attribute and a layout rect, so a cross-origin challenge
 * iframe is measured by geometry without reading its (blocked) content.
 */
export async function collectBotWallSignals(page: Page): Promise<BotWallSignals> {
  const dom = (await page.evaluate((minFraction: number) => {
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const iframeSrcs: string[] = [];
    const dominantIframeSrcs: string[] = [];
    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      const src = frame.getAttribute("src") || (frame as HTMLIFrameElement).src || "";
      if (!src) continue;
      iframeSrcs.push(src);
      const rect = frame.getBoundingClientRect();
      const coversWidth = rect.width >= window.innerWidth * minFraction;
      const coversHeight = rect.height >= window.innerHeight * minFraction;
      const coversArea = (rect.width * rect.height) / viewportArea >= minFraction;
      if (coversWidth && coversHeight && coversArea) dominantIframeSrcs.push(src);
    }
    const interactiveElementCount = document.querySelectorAll(
      "input, button, a[href], select, textarea",
    ).length;
    const bodyTextLength = (document.body?.innerText || "").trim().length;
    // http-equiv="refresh" with a url=... target; the JS-redirect loop shows up as the settled URL,
    // which mainDocumentUrl already carries.
    let metaRefreshUrl: string | null = null;
    const meta = document.querySelector('meta[http-equiv="refresh" i]');
    const content = meta?.getAttribute("content") || "";
    const match = content.match(/url\s*=\s*(.+)$/i);
    if (match) metaRefreshUrl = match[1].trim().replace(/^['"]|['"]$/g, "");
    return {
      title: document.title || "",
      iframeSrcs,
      dominantIframeSrcs,
      interactiveElementCount,
      bodyTextLength,
      metaRefreshUrl,
    };
  }, DOMINANT_IFRAME_MIN_FRACTION)) as Omit<BotWallSignals, "mainDocumentUrl">;
  return { mainDocumentUrl: page.url(), ...dom };
}

/**
 * Inspect the settled page for a bot-challenge interstitial. Always collects + classifies so the
 * verdict is returned (a detected-but-allowed run stamps a loud note). When it is a wall and
 * `allow` is false, saves a screenshot as proof and throws a `BotWallError` -- failing BEFORE any
 * measurement pass, with no recording written. The screenshot is best-effort: if it cannot be
 * captured (a lane/driver that does not support it), the refusal still fires, naming the gap.
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
    // A screenshot failure must never swallow the refusal: fall through and throw with a null path.
    savedPath = null;
  }
  throw new BotWallError(verdict, savedPath);
}
