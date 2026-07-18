// Pure-wait probe: run() does no JS work, it only awaits. The sampled window is ~pure waiting,
// reported as ~99% idle on Chrome and node (real idle samples fill the wait). Firefox reports the
// same window as idle too, on a different axis: each sample's `threadCPUDelta` reads ~0 while
// wall-time advances, and that CPU signal drives the idle slice (Gecko's category axis records no
// Idle-category samples for a wait). Backs the Firefox-idle-on-the-CPU-axis section in
// docs/dev/cpu-profiling.md.
// Run: node dist/cli.js record examples/awaits-only.mjs --bench --iterations 1
//      node dist/cli.js query cpu latest

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run() {
  for (let iteration = 0; iteration < 20; iteration++) {
    await sleep(20);
  }
}
