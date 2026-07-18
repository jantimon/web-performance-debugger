// A bench module (run() executes inside the page) that wraps a known chunk of work in a user
// `performance.measure`. --breakdown must surface a 'user-span' span with its own seven-slice
// breakdown, proving the mark bridge (a page-side measure becomes a span).
export function run() {
  performance.mark("user:start");
  let sum = 0;
  for (let iteration = 0; iteration < 400000; iteration++) sum += Math.sqrt(iteration + 1);
  performance.mark("user:end");
  performance.measure("user-span", "user:start", "user:end");
  return sum;
}
