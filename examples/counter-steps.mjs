// Driver (puppeteer) mode example: `run` executes in Node and receives
// { page, ctx, measureStep }. Driver is the default mode.
//
//   wpd record examples/counter-steps.mjs \
//     --url examples/react-counter/dist/index.html
//
// measureStep(label, action, { until })   // positional, the common case
// measureStep({ label, action, until })   // object form
//   - action: the interactions to measure
//   - until:  optional "done" signal (a selector string, an async fn, or a
//             promise). Omit to use the settle heuristic (rAF + idle, twice).
//
// Each measureStep becomes one step span in the recording; drill in with
// `query span <label>` or list them all with `query spans`.

export async function prepare({ page }) {
  await page.waitForSelector('[data-testid="inc"]');
}

export async function run({ page, measureStep }) {
  await measureStep("first increment", () => page.click('[data-testid="inc"]'));

  await measureStep("five rapid increments", async () => {
    for (let i = 0; i < 5; i++) await page.click('[data-testid="inc"]');
  });

  await measureStep({
    label: "final increment",
    action: () => page.click('[data-testid="inc"]'),
  });
}
