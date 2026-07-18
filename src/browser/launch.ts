import puppeteer from "puppeteer";
import type { Browser, CDPSession, Page } from "puppeteer";
import type { BrowserName } from "./backend.js";
import { shellFallback } from "../record/notes.js";

export interface BrowserHandle {
  browser: Browser;
  page: Page;
  /** null on Firefox: WebDriver BiDi has no CDP session (guard every CDP call with the caps). */
  client: CDPSession | null;
  /** Set when the requested chrome-headless-shell binary was missing and the launch fell back to
   * new-headless. A WARNING for meta.notes naming the cadence cost and the install command. */
  headlessFallback?: string;
}

/** Gecko's sampling floor: asking for less just yields this. Also the default when the caller
 * does not pin an interval. */
export const GECKO_MIN_INTERVAL_MS = 1;

/** Ring-buffer size in 8-byte entries (~128MB/process). Large enough that the measured window
 * survives until the shutdown dump, which is the whole point of the startup profiler. */
const GECKO_PROFILER_ENTRIES = 16_000_000;

/** Gecko profiler options for the Firefox CPU pass (dumped to `dumpPath` on browser exit). */
export interface GeckoLaunch {
  dumpPath: string;
  /** sampling interval in ms; clamped up to the ~1ms Gecko floor */
  intervalMs?: number;
}

/** Environment for a Firefox launch that starts the Gecko profiler at startup and dumps
 * the raw profile JSON to `dumpPath` when the browser exits. See docs/dev/gecko-profile-format.md. */
function geckoEnv(base: NodeJS.ProcessEnv, gecko: GeckoLaunch): NodeJS.ProcessEnv {
  const intervalMs = Math.max(GECKO_MIN_INTERVAL_MS, gecko.intervalMs ?? GECKO_MIN_INTERVAL_MS);
  return {
    ...base,
    MOZ_PROFILER_STARTUP: "1",
    MOZ_PROFILER_SHUTDOWN: gecko.dumpPath,
    // js,cpu: js gives JS stacks + UserTiming markers (windowing) + Reflow/Styles cause stacks
    // (blame) + the DOM/Layout label frames read-site blame keys on. cpu populates the per-sample
    // `threadCPUDelta` column, which is the honest-idle signal the reconciling breakdown needs.
    // [measured, Firefox 152, macOS] an explicit features string REPLACES the default set, so
    // `js` alone leaves threadCPUDelta 0% populated; adding `cpu` populates it 100% and a pure-wait
    // window reads 95.7% idle, at ~1% wall and +0.5MB dump. `cpuallthreads` is unnecessary (wpd
    // reconciles the content main thread alone) and `stackwalk` adds zero signal, so neither is set.
    MOZ_PROFILER_STARTUP_FEATURES: "js,cpu",
    MOZ_PROFILER_STARTUP_INTERVAL: String(intervalMs),
    MOZ_PROFILER_STARTUP_ENTRIES: String(GECKO_PROFILER_ENTRIES),
  };
}

/**
 * Puppeteer resolves a browser only at the exact build it pins, and tells the user to run
 * `npx puppeteer browsers install <browser>` -- which installs whatever the AMBIENT puppeteer
 * pins. That routinely differs from ours, so the same error survives the fix. Pinning the build
 * explicitly (`@<build>`) is what makes the ambient version irrelevant.
 *
 * The build is scraped from puppeteer's own message ("Could not find Firefox (ver. stable_152.0.2)")
 * rather than read from its PUPPETEER_REVISIONS export: that export is marked @internal and is
 * absent from the public types. The message is the version puppeteer actually looked for, so it
 * cannot drift from the real requirement.
 */
function missingBrowserMessage(error: Error, browser: BrowserName): Error {
  const build = error.message.match(/could not find .*?\(ver\.\s*([^)\s]+)\)/i)?.[1];
  if (!build) return error;
  return new Error(
    `${error.message}\n\nwpd pins ${browser} ${build}; the generic install command may fetch a different build. Install exactly this one:\n\n  npx puppeteer browsers install ${browser}@${build}\n`,
  );
}

/**
 * Chrome headless flavour. "shell" (the default) launches chrome-headless-shell
 * (`headless: 'shell'`), which runs BeginFrame at ~120Hz, halving the one-frame floor on wall/INP
 * (16.6 -> 8.3ms). "new" is Puppeteer's full-Chrome new-headless, which caps BeginFrame at ~60Hz.
 * See docs/dev/frame-floor.md. Ignored when the browser is headed (--no-headless) or Firefox.
 */
export type HeadlessMode = "new" | "shell";

/**
 * Resolve puppeteer's `headless` launch value from wpd's two knobs. Headed (`--no-headless`) wins
 * and returns false; otherwise the flavour defaults to shell (chrome-headless-shell, ~120Hz), and
 * only "new" opts back into full-Chrome new-headless (~60Hz). See docs/dev/frame-floor.md.
 */
export function resolveHeadless(headless: boolean, headlessMode?: HeadlessMode): boolean | "shell" {
  if (!headless) return false;
  return headlessMode === "new" ? true : "shell";
}

export async function launchBrowser(opts: {
  browser: BrowserName;
  headless: boolean;
  /** chrome only: "shell" (default, chrome-headless-shell, ~120Hz frames) or "new" (full Chrome) */
  headlessMode?: HeadlessMode;
  userDataDir?: string;
  /**
   * Timeout (ms) for a single protocol call, on both browsers. Raise it when a traced interaction
   * pins the main thread long enough that a routine evaluate would hit puppeteer's 180s default,
   * or when a loaded machine makes Firefox's `session.new` handshake miss it at launch.
   *
   * Not CDP-specific, despite puppeteer's own docstring calling it "individual protocol (CDP)
   * calls": puppeteer threads it into the BiDi connection too, where it governs every send()
   * including `session.new`, which is a BiDi-only command with no CDP counterpart.
   */
  protocolTimeoutMs?: number;
  /** Firefox only: start the Gecko profiler and dump it on exit. */
  gecko?: GeckoLaunch;
}): Promise<BrowserHandle> {
  try {
    return await launchOrThrow(opts);
  } catch (error) {
    throw missingBrowserMessage(error as Error, opts.browser);
  }
}

async function launchOrThrow(opts: {
  browser: BrowserName;
  headless: boolean;
  headlessMode?: HeadlessMode;
  userDataDir?: string;
  protocolTimeoutMs?: number;
  gecko?: GeckoLaunch;
}): Promise<BrowserHandle> {
  if (opts.browser === "firefox") {
    const browser = await puppeteer.launch({
      browser: "firefox",
      headless: opts.headless,
      userDataDir: opts.userDataDir,
      protocolTimeout: opts.protocolTimeoutMs,
      env: opts.gecko ? geckoEnv(process.env, opts.gecko) : process.env,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    // No CDP over BiDi; the caps object keeps every CDP call site guarded.
    return { browser, page, client: null };
  }

  // Headed (--no-headless) => false; otherwise shell (default, ~120Hz) or new-headless.
  const headless = resolveHeadless(opts.headless, opts.headlessMode);
  if (headless !== "shell") return launchChrome(headless, opts);
  // chrome-headless-shell is a separate download. If the environment skipped it, it is missing at
  // launch: never fail a run over the frame-cadence flavour, fall back to new-headless and warn.
  try {
    return await launchChrome("shell", opts);
  } catch (error) {
    if (!/could not find chrome/i.test((error as Error).message)) throw error;
    const handle = await launchChrome(true, opts);
    // chrome-headless-shell is a separate Puppeteer download; the default install fetches it, but
    // PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD or a chrome-only browser install omits it.
    handle.headlessFallback = shellFallback();
    return handle;
  }
}

async function launchChrome(
  headless: boolean | "shell",
  opts: { userDataDir?: string; protocolTimeoutMs?: number },
): Promise<BrowserHandle> {
  const browser = await puppeteer.launch({
    headless,
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
