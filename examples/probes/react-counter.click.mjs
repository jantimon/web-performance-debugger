// wpd bench module for the Vite/React counter
//
// Use with --bench --url so the built app is the host page, e.g.:
//   wpd record examples/probes/react-counter.click.mjs --bench \
//     --url examples/react-counter/dist/index.html --iterations 50 --warmup 5
//
// Each timed run() clicks the "+1" button; we measure the layout/paint cost of
// React re-rendering the changed count

function findButton() {
  return (
    document.querySelector('[data-testid="inc"]') ||
    [...document.querySelectorAll("button")].find((button) =>
      /\+|increment/i.test(button.textContent || ""),
    ) ||
    document.querySelector("button")
  );
}

export function prepare(ctx) {
  ctx.btn = findButton();
  if (!ctx.btn) throw new Error("counter +1 button not found on the host page");
}

export function run(ctx) {
  ctx.btn.click();
}
