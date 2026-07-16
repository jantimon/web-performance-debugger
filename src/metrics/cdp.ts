import type { CDPSession } from "puppeteer";
import type { RawCpuProfile } from "../profile/cpuprofile.js";

/** Snapshot CDP Performance.getMetrics as a flat name->value map. */
export async function snapshotMetrics(client: CDPSession): Promise<Record<string, number>> {
  const res = (await client.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  const out: Record<string, number> = {};
  for (const metric of res.metrics) out[metric.name] = metric.value;
  return out;
}

/** `snapshotMetrics` for callers that may have no CDP session (Firefox/BiDi) or no counter
 * capability: an absent client yields no counters rather than a fake zeroed set. */
export function snapshotMetricsIfAvailable(
  client: CDPSession | null,
): Promise<Record<string, number>> {
  return client ? snapshotMetrics(client) : Promise.resolve({});
}

export async function enableMetrics(client: CDPSession): Promise<void> {
  try {
    await client.send("Performance.enable", { timeDomain: "timeTicks" });
  } catch {
    // older protocol revisions don't accept the param
    await client.send("Performance.enable");
  }
}

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

export function metricsDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(after)) {
    if (typeof after[name] === "number" && typeof before[name] === "number") {
      out[name] = after[name] - before[name];
    }
  }
  return out;
}
