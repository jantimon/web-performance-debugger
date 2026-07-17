// Probe: record timestamps of N consecutive requestAnimationFrame callbacks in-page.
// Each frame drops a performance.mark, so the deltas are readable from the trace via
// `query events --kind usertiming`. run() also returns the deltas (bench harness discards
// the value, but wall/FRAMES is a second, independent read of the same cadence).
const FRAMES = 41;

export async function run() {
  const stamps = [];
  await new Promise((resolve) => {
    let seen = 0;
    const tick = (now) => {
      stamps.push(now);
      performance.mark(`raf:${seen}`);
      seen += 1;
      if (seen >= FRAMES) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const deltas = [];
  for (let index = 1; index < stamps.length; index++) {
    deltas.push(stamps[index] - stamps[index - 1]);
  }
  deltas.sort((left, right) => left - right);
  const median = deltas[Math.floor(deltas.length / 2)];
  return { frames: FRAMES, median, min: deltas[0], max: deltas[deltas.length - 1] };
}
