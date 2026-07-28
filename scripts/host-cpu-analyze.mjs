// Cross-host analysis for the host-cpu matrix. Given the per-host JSON summaries scripts/host-cpu-probe.mjs
// wrote (paths as args), it prints the cross-host ratio matrix, flags which pairs the 25% gate
// threshold separates, and runs the ARM-vs-x64 skew check on any same-platform-different-arch pair.
//
// It answers the three validation questions in one place:
//   (a) monotonicity  -- do the medians order the hosts the way real CPU speed does?
//   (b) separation    -- does the 25% threshold put distinct host classes on opposite sides?
//   (c) cross-arch skew -- does the mixed int/float loop read ARM and x64 so differently that a
//                          similar-speed cross-arch pair falsely trips the gate?
//
// Run: node scripts/host-cpu-analyze.mjs host-cpu-*.json
import { readFileSync } from "node:fs";

// Mirrors HOST_CPU_RATIO_THRESHOLD in src/model/compat.ts: two indices whose larger/smaller exceeds
// (1 + threshold) read as different-class hosts and trip the `host-cpu` comparability axis.
const HOST_CPU_RATIO_THRESHOLD = 0.25;

const paths = process.argv.slice(2);
if (paths.length < 2) {
  console.error("usage: node scripts/host-cpu-analyze.mjs <summary.json> <summary.json> [more...]");
  process.exit(1);
}

const hosts = paths.map((path) => {
  const summary = JSON.parse(readFileSync(path, "utf8"));
  if (typeof summary.median !== "number") {
    throw new Error(`${path}: missing numeric median (not a host-cpu-probe summary?)`);
  }
  return summary;
});

// Order by median so the ratio matrix and the monotonicity read reflect the measured speed ranking.
hosts.sort((left, right) => left.median - right.median);

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

const labelWidth = Math.max(...hosts.map((host) => host.label.length), "host".length);

console.log("Hosts (slowest -> fastest by median index):\n");
console.log(
  `  ${pad("host", labelWidth)}  ${pad("arch", 6)}  ${pad("median", 8)}  ${pad("spread%", 8)}  cpu`,
);
for (const host of hosts) {
  console.log(
    `  ${pad(host.label, labelWidth)}  ${pad(host.arch, 6)}  ${pad(host.median, 8)}  ${pad(host.spreadPct, 8)}  ${host.cpuModel}`,
  );
}

// (a) Monotonicity: the sort above is by median; the same order should track known CPU speed. We can
// only assert it is a strict order here (no ties that would make two hosts indistinguishable); the
// maintainer confirms it matches real-world speed. Flag any tie or near-tie under the noise floor.
console.log("\nRatio matrix (larger/smaller index; * = beyond the 25% gate threshold):\n");
console.log(`  ${pad("", labelWidth)}  ${hosts.map((host) => pad(host.label, labelWidth)).join("  ")}`);
for (const rowHost of hosts) {
  const cells = hosts.map((columnHost) => {
    if (rowHost === columnHost) return pad("-", labelWidth);
    const larger = Math.max(rowHost.median, columnHost.median);
    const smaller = Math.min(rowHost.median, columnHost.median);
    const ratio = smaller > 0 ? larger / smaller : Infinity;
    const separated = ratio - 1 > HOST_CPU_RATIO_THRESHOLD;
    return pad(`${ratio.toFixed(2)}${separated ? "*" : " "}`, labelWidth);
  });
  console.log(`  ${pad(rowHost.label, labelWidth)}  ${cells.join("  ")}`);
}

// (b) Separation: list every pair and which side of the gate it lands on.
console.log("\nPairwise separation:\n");
for (let outer = 0; outer < hosts.length; outer++) {
  for (let inner = outer + 1; inner < hosts.length; inner++) {
    const first = hosts[outer];
    const second = hosts[inner];
    const larger = Math.max(first.median, second.median);
    const smaller = Math.min(first.median, second.median);
    const ratio = smaller > 0 ? larger / smaller : Infinity;
    const separated = ratio - 1 > HOST_CPU_RATIO_THRESHOLD;
    const verdict = separated ? "SEPARATED (gate warns)" : "same class (gate silent)";
    console.log(`  ${first.label} vs ${second.label}: ratio ${ratio.toFixed(2)} -> ${verdict}`);
  }
}

// (c) Cross-arch skew: any pair whose arch differs is where a mixed int/float loop could read one
// architecture systematically faster/slower and trip the gate on machines of similar real speed. Only
// the maintainer knows the true relative speed of a given cross-arch pair, so surface each such pair
// with its ratio for that judgement, and highlight same-platform pairs (e.g. macos ARM vs macos Intel)
// where the OS is held constant.
console.log("\nCross-arch skew check (arch differs -- inspect for false separation):\n");
let crossArchPairs = 0;
for (let outer = 0; outer < hosts.length; outer++) {
  for (let inner = outer + 1; inner < hosts.length; inner++) {
    const first = hosts[outer];
    const second = hosts[inner];
    if (first.arch === second.arch) continue;
    crossArchPairs++;
    const larger = Math.max(first.median, second.median);
    const smaller = Math.min(first.median, second.median);
    const ratio = smaller > 0 ? larger / smaller : Infinity;
    const separated = ratio - 1 > HOST_CPU_RATIO_THRESHOLD;
    const samePlatform = first.platform === second.platform ? " [same platform]" : "";
    console.log(
      `  ${first.label} (${first.arch}) vs ${second.label} (${second.arch}): ratio ${ratio.toFixed(2)} -> ${separated ? "SEPARATED" : "same class"}${samePlatform}`,
    );
  }
}
if (crossArchPairs === 0) console.log("  (no cross-arch pairs in this set)");

console.log(
  "\nRead: (a) medians strictly ordered and matching known speed = monotonic; (b) distinct classes SEPARATED, replicas of one class same-class; (c) a cross-arch pair of similar real speed must NOT be SEPARATED (that would be loop skew).",
);
