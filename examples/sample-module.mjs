// Example module for wpd.
//
// Lifecycle hooks (all optional except `run`), called with a shared `ctx` object:
//   prepare(ctx)    -> once before timed iterations  (aliases: setup, beforeAll)
//   run(ctx)        -> the measured function (required)
//   cleanup(ctx)    -> once after all runs            (aliases: teardown, afterAll)

export function prepare(ctx) {
  const host = document.createElement("div");
  host.id = "perf-host";
  document.body.appendChild(host);
  ctx.host = host;
}

// Deliberately thrash layout: interleave style writes with forced reads so the
// browser must run layout on every iteration of the inner loop (layout thrashing).
export function run(ctx) {
  const host = ctx.host;
  for (let i = 0; i < 200; i++) {
    const el = document.createElement("div");
    el.textContent = "row " + i;
    el.style.padding = (i % 5) + "px";
    el.style.width = 100 + (i % 50) + "px";
    host.appendChild(el);
    // forced synchronous layout (read after write)
    void el.offsetHeight;
    host.style.background = i % 2 ? "#eef" : "#fee"; // invalidate paint
    void host.offsetWidth;
  }
  // clear for the next iteration so the work is comparable
  host.replaceChildren();
}

export function cleanup(ctx) {
  ctx.host?.remove();
}
