import type { CDPSession } from "puppeteer";
import type { RawCpuProfile } from "../profile/cpuprofile.js";

// Only the V8 sampling profiler lives here. The `Performance.getMetrics` counter path is gone:
// layout/style/paint counts and durations come from the trace, windowed on the bar's main thread
// (metrics/summarize.ts), which reproduces the CDP counters exactly and is windowable per span.

/** Start the V8 sampling profiler. `intervalUs` must be set before `Profiler.start`. */
export async function startCpuProfile(client: CDPSession, intervalUs: number): Promise<void> {
  await client.send("Profiler.enable");
  await client.send("Profiler.setSamplingInterval", { interval: intervalUs });
  await client.send("Profiler.start");
}

/** Stop sampling and return the raw `.cpuprofile` (nodes / samples / timeDeltas). */
export async function stopCpuProfile(client: CDPSession): Promise<RawCpuProfile> {
  const result = (await client.send("Profiler.stop")) as { profile: RawCpuProfile };
  return result.profile;
}
