import type { CDPSession } from "puppeteer";

export const NETWORK_PRESETS: Record<
  string,
  { offline: boolean; downloadKbps: number; uploadKbps: number; latencyMs: number }
> = {
  "slow-3g": { offline: false, downloadKbps: 400, uploadKbps: 400, latencyMs: 400 },
  "fast-3g": { offline: false, downloadKbps: 1638, uploadKbps: 768, latencyMs: 150 },
  "slow-4g": { offline: false, downloadKbps: 3000, uploadKbps: 1500, latencyMs: 100 },
  offline: { offline: true, downloadKbps: 0, uploadKbps: 0, latencyMs: 0 },
};

/** Artificial slowdown: CPU throttling rate (e.g. 4 = 4x slower) via CDP. */
export async function applyCpuThrottle(client: CDPSession, rate: number): Promise<void> {
  if (!rate || rate <= 1) return;
  await client.send("Emulation.setCPUThrottlingRate", { rate });
}

export async function applyNetworkPreset(client: CDPSession, preset: string): Promise<void> {
  const presetConfig = NETWORK_PRESETS[preset];
  if (!presetConfig)
    throw new Error(
      `Unknown network preset '${preset}'. Options: ${Object.keys(NETWORK_PRESETS).join(", ")}`,
    );
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: presetConfig.offline,
    latency: presetConfig.latencyMs,
    downloadThroughput: (presetConfig.downloadKbps * 1024) / 8,
    uploadThroughput: (presetConfig.uploadKbps * 1024) / 8,
  });
}
