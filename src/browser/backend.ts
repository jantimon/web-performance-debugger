export type BrowserName = "chrome" | "firefox";

/**
 * What a browser backend can measure, so runPass stays one function with capability
 * guards (not a class hierarchy). Chrome drives everything through CDP; Firefox is
 * driven over WebDriver BiDi, where CDP is unavailable, so counts/trace/throttle are
 * off and CPU comes from the Gecko profiler instead. See FIREFOX-NOTES.md.
 */
export interface BrowserCaps {
  /** CDP Performance.getMetrics counters (exact layout/style/script counts) */
  cdpCounts: boolean;
  /** page.tracing / DevTools timeline (paint counts, invalidation tracking, trace blame) */
  trace: boolean;
  /** a CPU sampling profile is available (both backends, different mechanisms) */
  cpuProfile: boolean;
  /** CDP CPU/network throttling emulation */
  throttle: boolean;
  /** the Gecko sampling profiler (Firefox only); CPU + layout/style markers from one pass */
  geckoProfiler: boolean;
}

export function capsFor(browser: BrowserName): BrowserCaps {
  if (browser === "firefox") {
    return {
      cdpCounts: false,
      trace: false,
      cpuProfile: true,
      throttle: false,
      geckoProfiler: true,
    };
  }
  return {
    cdpCounts: true,
    trace: true,
    cpuProfile: true,
    throttle: true,
    geckoProfiler: false,
  };
}

export const isBrowserName = (value: string): value is BrowserName =>
  value === "chrome" || value === "firefox";
