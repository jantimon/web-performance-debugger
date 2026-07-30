import puppeteer from "puppeteer";
import type { Browser, CDPSession, Page } from "puppeteer";
import type { BrowserName } from "./backend.js";
import { attachTeardownFailure } from "../model/teardown.js";
import { registerDisposer } from "./disposers.js";

export interface BrowserHandle {
  browser: Browser;
  page: Page;
  /** null on Firefox: WebDriver BiDi has no CDP session (guard every CDP call with the caps) */
  client: CDPSession | null;
  /**
   * Deregister the signal-cleanup disposer for this browser's process. Call it right after a clean
   * `browser.close()` so a completed run leaves nothing registered; until then a SIGINT/SIGTERM/SIGHUP
   * SIGKILLs the child process rather than orphaning it (disposers.ts)
   */
  release: () => void;
}

/** Register the browser's process for signal-cleanup: on a fatal signal, SIGKILL it synchronously so
 * it cannot outlive the run. Returned deregister is called on clean close */
function guardBrowserProcess(browser: Browser): () => void {
  return registerDisposer(() => {
    try {
      browser.process()?.kill("SIGKILL");
    } catch {
      /* best-effort: the process may already be gone */
    }
  });
}

/** Gecko's sampling floor: asking for less just yields this. Also the default when the caller
 * does not pin an interval */
export const GECKO_MIN_INTERVAL_MS = 1;

/** Ring-buffer size in 8-byte entries (~128MB/process). Large enough that the measured window
 * survives until the shutdown dump, which is the whole point of the startup profiler */
const GECKO_PROFILER_ENTRIES = 16_000_000;

/** Chrome's own sandbox error shapes, on the launch that failed to bring up a renderer. Matches
 * the "No usable sandbox" kernel message and the SUID helper's setuid/ownership complaints; used
 * only to turn a sandbox failure into a message that names the opt-out, never to retry unsandboxed */
export function isSandboxLaunchError(error: Error): boolean {
  return /no usable sandbox|suid sandbox|sandbox helper|setuid sandbox|--no-sandbox is not supported/i.test(
    error.message,
  );
}

/**
 * A top-level navigation failure worth bounded retries (on a fresh browser each attempt), vs a permanent one.
 *
 * A cross-process boot (a --url navigation that swaps the renderer process) can reject with a
 * Chromium network-stack `net::ERR_INVALID_HANDLE`, a `net::ERR_ABORTED`, or a target/frame swapped
 * out from under puppeteer mid-navigation ("detached Frame", "Target closed"). These are transient:
 * the same URL loads on a retry. They are NOT the same as a permanent failure -- a bad host
 * (`ERR_NAME_NOT_RESOLVED`), a refused connection, or a TLS error -- which a retry only makes fail
 * slower, so those are left to surface immediately
 */
export function isTransientNavError(error: Error): boolean {
  return /net::ERR_INVALID_HANDLE|net::ERR_ABORTED|net::ERR_NETWORK_CHANGED|detached\s?Frame|frame was detached|Target closed|Session closed/i.test(
    error.message,
  );
}

/**
 * Marker in the message of the error the driver throws when a settle's `requestAnimationFrame` never
 * fires within the stall ceiling. Chrome's built-in headless intermittently (~6% of records) loses
 * its compositor's BeginFrame source browser-wide and permanently: rAF callbacks stop firing (timers
 * still run), so an rAF-based settle would hang to the protocol timeout. The state is unrecoverable
 * from the page (a fresh rAF, a re-goto, or a new page in the same browser all stay frameless
 * [measured]); only a fresh browser recovers, which is why the error is retryable. Launching headless
 * with `--disable-gpu` (software compositing, a different frame-sink path) cuts the rate ~12x but does
 * not eliminate it, so the retry is the belt to the flag's braces. See docs/dev/frame-floor.md */
export const FRAME_STALL_MARKER = "wpd:frame-stall";

/** The error the driver throws when a settle rAF exceeds the stall ceiling (frame production stalled).
 * Carries the marker so `isFrameStallError`/`retryTransientNav` recognize it and relaunch */
export function frameStallError(waitedMs: number): Error {
  return new Error(
    `${FRAME_STALL_MARKER}: Chrome's built-in headless produced no animation frame within ${Math.round(waitedMs)}ms ` +
      `(the compositor's BeginFrame source stalled). Retrying on a fresh browser.`,
  );
}

/** Whether an error is a frame-production stall (the driver's settle rAF exceeded the ceiling) */
export function isFrameStallError(error: Error): boolean {
  return error.message.includes(FRAME_STALL_MARKER);
}

/**
 * Run `attempt` and, on a transient failure, retry up to `limit` times on a fresh browser, returning
 * how many retries it took and how many of those were frame-production stalls (vs transient
 * navigation failures) so the caller notes the right cause. Two failure shapes retry, both because a
 * fresh browser recovers them: a transient cross-process navigation error (isTransientNavError) and a
 * headless frame-production stall (isFrameStallError). A permanent error, a non-Error throw, or
 * exhausting the limit re-throws immediately -- never an infinite loop, never a swallowed permanent
 * failure. `attempt` is expected to be self-contained (a fresh browser per call), so a retry starts clean
 */
export async function retryTransientNav<T>(
  attempt: () => Promise<T>,
  limit: number,
): Promise<{ value: T; retries: number; frameStallRetries: number }> {
  let frameStallRetries = 0;
  for (let tries = 0; ; tries++) {
    try {
      return { value: await attempt(), retries: tries, frameStallRetries };
    } catch (error) {
      const retryable =
        error instanceof Error && (isTransientNavError(error) || isFrameStallError(error));
      if (tries >= limit || !retryable) throw error;
      if (error instanceof Error && isFrameStallError(error)) frameStallRetries++;
    }
  }
}

/** A sandbox launch failure re-thrown as guidance: name the opt-in flag, do NOT silently retry
 * unsandboxed. Constrained environments (containers, some CI) cannot start Chrome's sandbox; the
 * user decides whether to trade containment for a run */
export function sandboxLaunchError(error: Error): Error {
  return new Error(
    `Chrome could not start under its sandbox:\n\n  ${error.message}\n\n` +
      `Some environments (containers, restricted CI) cannot run the Chrome sandbox. To launch anyway ` +
      `with it disabled, re-record with --disable-browser-sandbox.\n\n` +
      `WARNING: that reduces process containment. Only do it in a trusted, isolated environment, and ` +
      `do not combine it with --user-data-dir or a non-loopback --url.`,
  );
}

/** Gecko profiler options for the Firefox CPU pass (dumped to `dumpPath` on browser exit) */
export interface GeckoLaunch {
  dumpPath: string;
  /** sampling interval in ms; clamped up to the ~1ms Gecko floor */
  intervalMs?: number;
}

/** Environment for a Firefox launch that starts the Gecko profiler at startup and dumps
 * the raw profile JSON to `dumpPath` when the browser exits. See docs/dev/gecko-profile-format.md */
function geckoEnv(base: NodeJS.ProcessEnv, gecko: GeckoLaunch): NodeJS.ProcessEnv {
  const intervalMs = Math.max(GECKO_MIN_INTERVAL_MS, gecko.intervalMs ?? GECKO_MIN_INTERVAL_MS);
  return {
    ...base,
    MOZ_PROFILER_STARTUP: "1",
    MOZ_PROFILER_SHUTDOWN: gecko.dumpPath,
    // js,cpu: js gives JS stacks + UserTiming markers (windowing) + Reflow/Styles cause stacks
    // (blame) + the DOM/Layout label frames read-site blame keys on. cpu populates the per-sample
    // `threadCPUDelta` column, which is the honest-idle signal the reconciling breakdown needs
    // [measured, Firefox 152, macOS] an explicit features string REPLACES the default set, so
    // `js` alone leaves threadCPUDelta 0% populated; adding `cpu` populates it 100% and a pure-wait
    // window reads 95.7% idle, at ~1% wall and +0.5MB dump. `cpuallthreads` is unnecessary (wpd
    // reconciles the content main thread alone) and `stackwalk` adds zero signal, so neither is set
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
 * cannot drift from the real requirement
 */
function missingBrowserMessage(error: Error, browser: BrowserName): Error {
  const build = error.message.match(/could not find .*?\(ver\.\s*([^)\s]+)\)/i)?.[1];
  if (!build) return error;
  return new Error(
    `${error.message}\n\nwpd pins ${browser} ${build}; the generic install command may fetch a different build. Install exactly this one:\n\n  npx puppeteer browsers install ${browser}@${build}\n`,
  );
}

export async function launchBrowser(opts: {
  browser: BrowserName;
  /** chrome: false is headed (--no-headless); true is Chrome's built-in headless (full Chrome,
   * windowless, ~60Hz frames). See docs/dev/frame-floor.md */
  headless: boolean;
  userDataDir?: string;
  /**
   * Timeout (ms) for a single protocol call, on both browsers. Raise it when a traced interaction
   * pins the main thread long enough that a routine evaluate would hit puppeteer's 180s default,
   * or when a loaded machine makes Firefox's `session.new` handshake miss it at launch.
   *
   * Not CDP-specific, despite puppeteer's own docstring calling it "individual protocol (CDP)
   * calls": puppeteer threads it into the BiDi connection too, where it governs every send()
   * including `session.new`, which is a BiDi-only command with no CDP counterpart
   */
  protocolTimeoutMs?: number;
  /** chrome only: pass --no-sandbox/--disable-setuid-sandbox (reduced containment). Off by default */
  disableSandbox?: boolean;
  /** Firefox only: start the Gecko profiler and dump it on exit */
  gecko?: GeckoLaunch;
}): Promise<BrowserHandle> {
  try {
    return await launchOrThrow(opts);
  } catch (error) {
    throw missingBrowserMessage(error as Error, opts.browser);
  }
}

/**
 * Finish post-launch setup (new page, viewport, CDP session) on an already-launched browser, and if
 * any of it throws, close the browser best-effort before re-throwing. A launch that half-succeeds and
 * then fails setup would otherwise leave the browser process running (a resource leak, a hung CI job).
 * The close is guarded so a close failure cannot mask the setup error (it attaches as its cause)
 */
export async function finishLaunchOrClose<T>(
  browser: Pick<Browser, "close">,
  setup: () => Promise<T>,
): Promise<T> {
  try {
    return await setup();
  } catch (setupError) {
    try {
      await browser.close();
    } catch (closeError) {
      attachTeardownFailure(setupError, closeError);
    }
    throw setupError;
  }
}

async function launchOrThrow(opts: {
  browser: BrowserName;
  headless: boolean;
  userDataDir?: string;
  protocolTimeoutMs?: number;
  disableSandbox?: boolean;
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
    const release = guardBrowserProcess(browser);
    try {
      return await finishLaunchOrClose(browser, async () => {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
        // No CDP over BiDi; the caps object keeps every CDP call site guarded
        return { browser, page, client: null, release };
      });
    } catch (error) {
      // finishLaunchOrClose already closed the half-launched browser; drop its signal guard too
      release();
      throw error;
    }
  }

  // headless: true is Chrome's built-in headless (full Chrome, windowless); false is --no-headless
  // wpd measures how real Chrome performs, so it launches real Chrome, never the chrome-headless-shell
  // scraping/PDF build
  return launchChrome(opts.headless, opts);
}

/**
 * Chrome launch args. The renderer runs in its OS sandbox by DEFAULT (neither --no-sandbox nor
 * --disable-setuid-sandbox is present); `disableSandbox` opts back into both for environments that
 * cannot start the sandbox (containers, restricted CI), trading process containment for a run.
 *
 * `--disable-gpu` is set on HEADLESS launches only: Chrome's built-in headless intermittently loses
 * its GPU-process compositor's BeginFrame source (rAF stops firing browser-wide and permanently,
 * ~6% of records), which hangs the driver's rAF-based settle. Routing compositing through software
 * (SwiftShader) uses a different frame-sink path that cuts the rate ~12x (to ~0.5% [measured]); the
 * frame cadence stays the synthetic 60Hz BeginFrame default (~16.7ms) and the wall/INP one-frame
 * floor is unchanged, because that default is set by the display compositor, not the GPU
 * (docs/dev/frame-floor.md). Headless CI has no GPU regardless, so this also aligns a dev machine's
 * headless with CI. Headed (--no-headless) keeps the GPU: it drives a real window off a real display,
 * where the stall does not occur
 */
export function chromeArgs(disableSandbox: boolean, headless: boolean): string[] {
  const sandboxArgs = disableSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : [];
  const headlessArgs = headless ? ["--disable-gpu"] : [];
  return [
    ...sandboxArgs,
    ...headlessArgs,
    "--enable-precise-memory-info",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
}

async function launchChrome(
  headless: boolean,
  opts: { userDataDir?: string; protocolTimeoutMs?: number; disableSandbox?: boolean },
): Promise<BrowserHandle> {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless,
      // Persistent profile dir: reuses cookies/session across passes and runs (puppeteer
      // ignores undefined, so this is a no-op when the flag is absent)
      userDataDir: opts.userDataDir,
      // puppeteer ignores undefined and falls back to its 180000ms default
      protocolTimeout: opts.protocolTimeoutMs,
      args: chromeArgs(!!opts.disableSandbox, headless),
    });
  } catch (error) {
    // A sandbox that cannot start is a distinct, actionable failure: name the opt-out rather than
    // silently retrying unsandboxed (which would defeat the default the user did not override)
    if (!opts.disableSandbox && isSandboxLaunchError(error as Error))
      throw sandboxLaunchError(error as Error);
    throw error;
  }
  const release = guardBrowserProcess(browser);
  try {
    return await finishLaunchOrClose(browser, async () => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
      const client = await page.createCDPSession();
      return { browser, page, client, release };
    });
  } catch (error) {
    // finishLaunchOrClose already closed the half-launched browser; drop its signal guard too
    release();
    throw error;
  }
}
