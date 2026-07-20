// Driver-mode example that FAILS on a chosen iteration, to exercise --keep-partial.
//
//   wpd record examples/flaky-iteration.mjs --iterations 3 --keep-partial
//
// A production journey on a flaky site can time out on one slow iteration. --keep-partial keeps the
// iterations that completed instead of discarding the whole run; a failure in the FIRST iteration
// (a broken flow, nothing to salvage) still errors. This module simulates that: run() is imported
// once in Node, so a module-scoped counter survives across iterations, and it throws partway through
// the iteration named by FAIL_AT (1-based; default 2, the second iteration). Set FAIL_AT=1 to make
// the first iteration fail.

const failAt = Number(process.env.FAIL_AT ?? 2);
let iterationCount = 0;

export async function run({ page, measureStep }) {
  iterationCount++;
  const failThisIteration = iterationCount === failAt;

  await measureStep("touch-dom", async () => {
    await page.evaluate(() => {
      const node = document.createElement("div");
      node.textContent = "row";
      document.body.appendChild(node);
    });
  });

  // Fail AFTER the first step and DURING the second, so the salvaged run loses a half-measured step.
  await measureStep("maybe-fail", async () => {
    if (failThisIteration) throw new Error("simulated flaky-iteration failure");
    await page.evaluate(() => void document.body.offsetHeight);
  });
}
