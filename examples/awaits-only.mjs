// Pure-wait probe: run() does no JS work, it only awaits. The sampled window is ~pure waiting,
// which Chrome and node fill with real (idle) samples but the Gecko profiler does not record as
// idle at all. Backs the "Gecko profile has no idle" measurement in docs/dev/cpu-profiling.md:
// on Chrome the breakdown reports ~99% idle, on Firefox the same window reads 0 idle.
// Run: node dist/cli.js record examples/awaits-only.mjs --bench --iterations 1
//      node dist/cli.js query cpu latest

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run() {
  for (let iteration = 0; iteration < 20; iteration++) {
    await sleep(20);
  }
}
