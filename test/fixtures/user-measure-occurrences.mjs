/** Two named measures per run, so occurrence count differs from iteration count */
export function run() {
  let sum = 0;
  for (let occurrence = 0; occurrence < 2; occurrence++) {
    performance.mark("batch:start");
    for (let index = 0; index < 400000; index++) sum += Math.sqrt(index + occurrence + 1);
    performance.mark("batch:end");
    performance.measure("batch", "batch:start", "batch:end");
  }
  return sum;
}
