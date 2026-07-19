import type { CDPSession } from "puppeteer";

/** Artificial slowdown: CPU throttling rate (e.g. 4 = 4x slower) via CDP. It scales work up into
 * visibility on the bar, which is why it survives when the network presets do not. */
export async function applyCpuThrottle(client: CDPSession, rate: number): Promise<void> {
  if (!rate || rate <= 1) return;
  await client.send("Emulation.setCPUThrottlingRate", { rate });
}
