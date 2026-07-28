/**
 * A host-CPU speed scalar, measured in the node process before a capture runs.
 *
 * CPU self-time ms are trustworthy in aggregate on ONE host, but across hosts they embed the
 * hardware gap: an M-series laptop and a shared CI runner differ several-fold on identical code, so a
 * self-time delta between two machines is mostly the machines. The field's answer is a host-speed
 * scalar (Lighthouse's benchmarkIndex, which times a fixed JS workload and reads every machine on one
 * speed scale). wpd stamps the same kind of scalar as a FACT beside the numbers and gates a cross-host
 * comparison on it; it does NOT normalize self-time by it (see docs/dev/cpu-profiling.md).
 *
 * The index is throughput: a fixed integer/float workload of a KNOWN operation count, timed, reported
 * as work-per-millisecond scaled to a benchmarkIndex-like magnitude. Higher = faster host. The work is
 * deterministic (a straight-line loop of fixed length with no data-dependent branch), so only the
 * DURATION varies with the machine; the index is monotonic with CPU speed. It runs in node on every
 * lane (node is present even for the browser targets) and never inside the measured window.
 */

/** Loop length of one timed block. Sized so a block runs ~11 ms on a fast dev machine, keeping the
 * whole measurement (`HOST_CPU_SAMPLES` blocks) inside a ~120 ms budget [measured]. */
export const HOST_CPU_BLOCK_ITERATIONS = 1_000_000;

/** Timed blocks per measurement. Odd, so the median is a real sample; enough to shrug off a single
 * scheduling hiccup without paying a long budget. */
const HOST_CPU_SAMPLES = 11;

/** Divides raw operations-per-millisecond into a benchmarkIndex-like magnitude (~1800 on a reference
 * M-series [measured]). The scale is cosmetic: the gate compares two indices as a ratio, so it
 * cancels; the constant only sets how the number reads in a report. */
const INDEX_SCALE = 50;

/**
 * One block of fixed work: `iterations` steps of mixed integer/float arithmetic, each feeding the
 * running accumulator so V8 cannot fold the loop away or hoist it out. No data-dependent branch and
 * no allocation, so the operation count is exactly `iterations` on every machine and every call --
 * the same input returns the same value, which is the observable proof the work is fixed.
 */
export function hostCpuWorkBlock(iterations: number): number {
  let accumulator = 1;
  for (let step = 0; step < iterations; step++) {
    accumulator += step * 1.000_001;
    accumulator *= 1.000_000_1;
    // Keep the accumulator bounded so it never reaches Infinity (which would make later steps cheaper
    // no-ops and break the fixed-work property); the modulo runs the same regardless of value.
    accumulator = (accumulator % 1_000_000) + 1;
  }
  return accumulator;
}

/** The index from a measured median block duration: work-per-ms, scaled and rounded to an integer.
 * Monotonic (a faster host runs the block in less time, so a smaller `medianMs` yields a larger
 * index). Exposed so a unit test pins the formula and its rounding without touching a real clock. */
export function hostCpuIndexFromMedianMs(
  medianMs: number,
  blockIterations = HOST_CPU_BLOCK_ITERATIONS,
): number {
  if (medianMs <= 0) return 0;
  return Math.round(blockIterations / medianMs / INDEX_SCALE);
}

export interface HostCpuMeasureOptions {
  /** millisecond clock, defaulting to `process.hrtime.bigint`; injected by tests to make the work the
   * only machine-dependent input. */
  now?: () => number;
  samples?: number;
  blockIterations?: number;
}

/**
 * Measure the host-CPU index: run the fixed work block `samples` times, timing each, and turn the
 * MEDIAN block duration into a throughput index. Median (not mean) so one preempted block does not
 * drag the number. Cheap and dependency-free; call it in node before the capture, never inside a
 * measured window.
 */
export function measureHostCpuIndex(options: HostCpuMeasureOptions = {}): number {
  const now = options.now ?? (() => Number(process.hrtime.bigint()) / 1_000_000);
  const samples = options.samples ?? HOST_CPU_SAMPLES;
  const blockIterations = options.blockIterations ?? HOST_CPU_BLOCK_ITERATIONS;
  const durations: number[] = [];
  let sink = 0;
  for (let sample = 0; sample < samples; sample++) {
    const startMs = now();
    sink += hostCpuWorkBlock(blockIterations);
    const endMs = now();
    durations.push(endMs - startMs);
  }
  // Read the accumulator so the whole measurement cannot be optimized out as dead.
  if (!Number.isFinite(sink)) throw new Error("host-cpu benchmark produced a non-finite result");
  durations.sort((left, right) => left - right);
  const medianMs = durations[(durations.length - 1) >> 1];
  return hostCpuIndexFromMedianMs(medianMs, blockIterations);
}
