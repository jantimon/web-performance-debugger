import puppeteer from "puppeteer";
import type { Browser, CDPSession, Page } from "puppeteer";

export interface BrowserHandle {
  browser: Browser;
  page: Page;
  client: CDPSession;
}

export async function launchBrowser(opts: {
  headless: boolean;
  userDataDir?: string;
}): Promise<BrowserHandle> {
  const browser = await puppeteer.launch({
    headless: opts.headless,
    // Persistent profile dir: reuses cookies/session across passes and runs (puppeteer
    // ignores undefined, so this is a no-op when the flag is absent).
    userDataDir: opts.userDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--enable-precise-memory-info",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const client = await page.createCDPSession();
  return { browser, page, client };
}
