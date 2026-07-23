// A module whose run() AND cleanup() both throw, to exercise the teardown-must-not-mask-the-run-error
// path. The --target node lane imports and profiles run() in this process (no browser), so a dual
// failure reproduces deterministically and browser-free.
export async function run() {
  throw new Error("RUN_BOOM: the workload failed");
}

export async function cleanup() {
  throw new Error("CLEANUP_BOOM: teardown failed too");
}
