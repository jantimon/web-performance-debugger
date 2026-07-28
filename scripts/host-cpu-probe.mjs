// Host-CPU cross-machine probe. Runs the SHIPPED microbenchmark (`measureHostCpuIndex` from the built
// `dist/model/host-cpu.js`, never a copy) N times on one host and reports the index distribution, so a
// matrix of hosts can be compared on one speed scale. It validates the two unverified claims behind the
// `host-cpu` comparability axis: that the index is monotonic with real CPU speed across machines, and
// that within-host noise stays well under the 25% gate threshold.
//
// Emits one line of machine-readable JSON to stdout, appends a small markdown table to
// $GITHUB_STEP_SUMMARY when present, and writes the same JSON to a file (--out <path>, else
// host-cpu-<platform>-<arch>.json) for scripted cross-job analysis. Browser-free: needs only node and
// the built dist. Run locally with `npm run build && node scripts/host-cpu-probe.mjs`.
import { appendFileSync, writeFileSync } from "node:fs";
import os from "node:os";

const { measureHostCpuIndex } = await import("../dist/model/host-cpu.js");

// --out <path> overrides the artifact filename; --label <name> stamps the GitHub runner class (the
// matrix `os` value) so the analyzer can name each host. Both are optional; env fallbacks let a
// workflow pass them without argv juggling.
function readOption(flag, envName) {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex !== -1 && flagIndex + 1 < process.argv.length) return process.argv[flagIndex + 1];
  return process.env[envName];
}

const label = readOption("--label", "HOST_CPU_LABEL") ?? "local";
const runs = Number(readOption("--runs", "HOST_CPU_RUNS") ?? 10);

const cpus = os.cpus();
const identity = {
  label,
  platform: os.platform(),
  arch: os.arch(),
  cpuModel: cpus[0]?.model?.trim() ?? "unknown",
  cpuCount: cpus.length,
  nodeVersion: process.version,
};

// Run the shipped benchmark sequentially, one index per run. Sequential (not concurrent) so each run
// has the host to itself, the same contract the real capture uses when it stamps meta.hostCpuIndex.
const indices = [];
for (let run = 0; run < runs; run++) {
  indices.push(measureHostCpuIndex());
}

const sorted = [...indices].sort((left, right) => left - right);
const min = sorted[0];
const max = sorted[sorted.length - 1];
const middle = sorted.length >> 1;
const median =
  sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
// Within-host spread as a percentage of the median: the noise the 25% cross-host gate must clear.
const spreadPct = median > 0 ? ((max - min) / median) * 100 : 0;

const summary = {
  ...identity,
  runs: indices.length,
  indices,
  min,
  median,
  max,
  spreadPct: Math.round(spreadPct * 100) / 100,
};

// Human block first (stderr, so stdout stays a single clean JSON line for piping).
console.error(`host: ${label} (${identity.platform}/${identity.arch}) node ${identity.nodeVersion}`);
console.error(`cpu:  ${identity.cpuModel} x${identity.cpuCount}`);
console.error(`indices: ${indices.join(", ")}`);
console.error(`min ${min}  median ${median}  max ${max}  spread ${summary.spreadPct}%`);

// One machine-readable line to stdout.
console.log(JSON.stringify(summary));

// A GitHub step-summary table when running in Actions, so cross-job comparison is readable from the
// run page without downloading artifacts.
if (process.env.GITHUB_STEP_SUMMARY) {
  const table = [
    `### host-cpu probe: ${label}`,
    "",
    "| field | value |",
    "| --- | --- |",
    `| platform / arch | ${identity.platform} / ${identity.arch} |`,
    `| cpu | ${identity.cpuModel} (x${identity.cpuCount}) |`,
    `| node | ${identity.nodeVersion} |`,
    `| indices | ${indices.join(", ")} |`,
    `| min / median / max | ${min} / ${median} / ${max} |`,
    `| within-host spread | ${summary.spreadPct}% |`,
    "",
  ].join("\n");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
}

const outPath =
  readOption("--out", "HOST_CPU_OUT") ?? `host-cpu-${identity.platform}-${identity.arch}.json`;
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
console.error(`wrote ${outPath}`);
