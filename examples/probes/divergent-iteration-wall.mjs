// Driver-mode example whose one step is an OUTLIER on iteration 0: it stalls the first time and is
// trivial afterwards. A --breakdown step's bar tiles iteration 0, so its breakdown window dwarfs the
// step's headline wall (the median across iterations). This is the divergent-wall case `query spans
// --min-wall` must hide by the MEDIAN in both json and human output, never showing a step in one and
// hiding it in the other.
//
//   wpd record examples/probes/divergent-iteration-wall.mjs --breakdown --iterations 3
//   wpd query spans latest --min-wall 150   # the step is hidden by its median, not its iter-0 window

let iterationCount = 0;

export async function run({ page, measureStep }) {
  iterationCount++;
  const firstIteration = iterationCount === 1;
  await measureStep("slow-once", async () => {
    await page.evaluate(() => {
      const node = document.createElement("div");
      node.textContent = "row";
      document.body.appendChild(node);
    });
    // Stall the FIRST iteration only, so its window (which the bar tiles) dwarfs the median wall.
    if (firstIteration) await new Promise((resolve) => setTimeout(resolve, 500));
  });
}
