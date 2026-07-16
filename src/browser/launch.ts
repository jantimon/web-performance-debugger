import puppeteer from "puppeteer";
import type { Browser, CDPSession, Page } from "puppeteer";
import type { BrowserName } from "./backend.js";

export interface BrowserHandle {
  browser: Browser;
  page: Page;
  /** null on Firefox: WebDriver BiDi has no CDP session (guard every CDP call with the caps). */
  client: CDPSession | null;
}

/** Gecko profiler options for the Firefox CPU pass (dumped to `dumpPath` on browser exit). */
export interface GeckoLaunch {
  dumpPath: string;
  /** sampling interval in ms (Gecko floor is ~1ms); default 1 */
  intervalMs?: number;
}

/** Environment for a Firefox launch that starts the Gecko profiler at startup and dumps
 * the raw profile JSON to `dumpPath` when the browser exits. See docs/dev/gecko-profile-format.md. */
function geckoEnv(base: NodeJS.ProcessEnv, gecko: GeckoLaunch): NodeJS.ProcessEnv {
  return {
    ...base,
    MOZ_PROFILER_STARTUP: "1",
    MOZ_PROFILER_SHUTDOWN: gecko.dumpPath,
    // js: JS stacks + UserTiming markers (windowing) + Reflow/Styles cause stacks (blame).
    MOZ_PROFILER_STARTUP_FEATURES: "js",
    MOZ_PROFILER_STARTUP_INTERVAL: String(gecko.intervalMs ?? 1),
    // Large ring buffer so the measured window is not overwritten before shutdown.
    MOZ_PROFILER_STARTUP_ENTRIES: "16000000",
  };
}

export async function launchBrowser(opts: {
  browser: BrowserName;
  headless: boolean;
  userDataDir?: string;
  /** CDP protocol timeout (ms). Raise it when a traced interaction pins the main
   * thread long enough that a routine evaluate would hit the 180s default. Chrome only. */
  protocolTimeoutMs?: number;
  /** Firefox only: start the Gecko profiler and dump it on exit. */
  gecko?: GeckoLaunch;
}): Promise<BrowserHandle> {
  if (opts.browser === "firefox") {
    const browser = await puppeteer.launch({
      browser: "firefox",
      headless: opts.headless,
      userDataDir: opts.userDataDir,
      env: opts.gecko ? geckoEnv(process.env, opts.gecko) : process.env,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    // No CDP over BiDi; the caps object keeps every CDP call site guarded.
    return { browser, page, client: null };
  }

  const browser = await puppeteer.launch({
    headless: opts.headless,
    // Persistent profile dir: reuses cookies/session across passes and runs (puppeteer
    // ignores undefined, so this is a no-op when the flag is absent).
    userDataDir: opts.userDataDir,
    // puppeteer ignores undefined and falls back to its 180000ms default.
    protocolTimeout: opts.protocolTimeoutMs,
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
