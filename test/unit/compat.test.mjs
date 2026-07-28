import { test } from "node:test";
import assert from "node:assert/strict";
import { comparabilityMismatches } from "../../dist/model/compat.js";

// A base meta with every comparability axis pinned, so overriding ONE field on one side leaves
// `comparabilityMismatches` returning only that axis (every equal axis is filtered out). browser and
// runtime are absent (default "chrome"), throttle absent ("off"), variant absent ("(none)").
function baseMeta() {
  return {
    passes: ["breakdown"],
    iterations: 5,
    warmup: 1,
    cpuIntervalUs: 200,
    hostCpuIndex: 1800,
    headless: true,
    headlessMode: "new",
    target: "app.mjs",
    workload: { lane: "bench", host: null, module: "app.mjs" },
  };
}

/** The mismatch on a named axis, or undefined when the axis was filtered out (silent). */
function axis(base, current, name) {
  return comparabilityMismatches(base, current).find((entry) => entry.axis === name);
}

// Two identical metas differ on nothing: every axis (host-cpu within threshold included) is filtered.
test("comparabilityMismatches: identical metas produce no axes", () => {
  assert.deepEqual(comparabilityMismatches(baseMeta(), baseMeta()), []);
});

// --- host-cpu: a WARN-tier ratio boundary (docs/dev/cpu-profiling.md: more than 25% apart) ---

test("host-cpu: just-under 25% apart is silent, just-over WARNS", () => {
  const under = axis(
    { ...baseMeta(), hostCpuIndex: 1000 },
    { ...baseMeta(), hostCpuIndex: 1240 }, // ratio 1.24 < 1.25
    "host-cpu",
  );
  assert.equal(under, undefined, "1.24x is inside the threshold: silent");

  const over = axis(
    { ...baseMeta(), hostCpuIndex: 1000 },
    { ...baseMeta(), hostCpuIndex: 1260 }, // ratio 1.26 > 1.25
    "host-cpu",
  );
  assert.ok(over, "1.26x trips the axis");
  assert.equal(over.blocksGating, false, "the host-cpu axis WARNS, it never blocks");
  assert.equal(over.base, "1000");
  assert.equal(over.current, "1260");
});

// Exactly 25% apart is "25%", not "more than 25%", so the `<= threshold` boundary stays silent.
test("host-cpu: exactly 25% apart is silent (the boundary is not more-than)", () => {
  assert.equal(
    axis({ ...baseMeta(), hostCpuIndex: 1000 }, { ...baseMeta(), hostCpuIndex: 1250 }, "host-cpu"),
    undefined,
  );
});

test("host-cpu: both-absent is silent; one-side-absent WARNS as unverifiable", () => {
  const base = baseMeta();
  const current = baseMeta();
  delete base.hostCpuIndex;
  delete current.hostCpuIndex;
  assert.equal(axis(base, current, "host-cpu"), undefined, "neither side measured it: silent");

  const oneAbsent = baseMeta();
  delete oneAbsent.hostCpuIndex;
  const warn = axis(baseMeta(), oneAbsent, "host-cpu");
  assert.ok(warn, "one side measured, one did not: the sameness cannot be verified");
  assert.equal(warn.blocksGating, false);
  assert.equal(warn.base, "1800");
  assert.equal(warn.current, "unmeasured");
});

// --- sampler-interval: the other WARN-tier axis; it moves sampling density, not a gated count ---

test("sampler-interval: a mismatch WARNS, it does not block", () => {
  const entry = axis(baseMeta(), { ...baseMeta(), cpuIntervalUs: 150 }, "sampler-interval");
  assert.ok(entry, "a differing interval surfaces the axis");
  assert.equal(entry.blocksGating, false);
  assert.equal(entry.base, "200us");
  assert.equal(entry.current, "150us");
});

// --- workload-identity: one side predates the structured workload field ---

test("workload-identity: present-vs-absent WARNS (unverifiable), never the blocking workload axis", () => {
  const current = baseMeta();
  delete current.workload; // the older side carries no structured identity
  const mismatches = comparabilityMismatches(baseMeta(), current);
  const identity = mismatches.find((entry) => entry.axis === "workload-identity");
  assert.ok(identity, "a mixed pair warns under workload-identity");
  assert.equal(identity.blocksGating, false);
  assert.equal(
    mismatches.find((entry) => entry.axis === "workload"),
    undefined,
    "it does NOT block under the workload axis",
  );

  // Symmetric: base is the older side.
  const base = baseMeta();
  delete base.workload;
  const reversed = axis(base, baseMeta(), "workload-identity");
  assert.ok(reversed, "the mixed-pair warning fires whichever side is older");
  assert.equal(reversed.blocksGating, false);
});

// --- stableWorkloadHost: the ephemeral-loopback-port fold, via the workload axis ---

function urlWorkload(host) {
  return { lane: "bench", host, module: "app.mjs" };
}

test("workload host: two ephemeral loopback ports FOLD to one workload (a non-blocking note)", () => {
  const base = { ...baseMeta(), workload: urlWorkload("http://127.0.0.1:40001/") };
  const current = { ...baseMeta(), workload: urlWorkload("http://127.0.0.1:52000/") };
  const entry = axis(base, current, "workload");
  assert.ok(entry, "the differing raw ports keep the disclosure entry");
  assert.equal(entry.blocksGating, false, "the fold makes it the same workload: no block");
  // The RAW hosts are surfaced so a reader sees why the gate did not refuse.
  assert.match(entry.base, /:40001/);
  assert.match(entry.current, /:52000/);
});

test("workload host: the localhost variant folds too", () => {
  const base = { ...baseMeta(), workload: urlWorkload("http://localhost:33001/") };
  const current = { ...baseMeta(), workload: urlWorkload("http://localhost:41000/") };
  const entry = axis(base, current, "workload");
  assert.ok(entry);
  assert.equal(entry.blocksGating, false, "localhost is loopback: ephemeral ports fold");
});

test("workload host: REGISTERED ports do NOT fold (a real service on :8080 vs :9090 differs)", () => {
  const base = { ...baseMeta(), workload: urlWorkload("http://127.0.0.1:8080/") };
  const current = { ...baseMeta(), workload: urlWorkload("http://127.0.0.1:9090/") };
  const entry = axis(base, current, "workload");
  assert.ok(entry);
  assert.equal(entry.blocksGating, true, "registered ports name a deliberate service: block the gate");
});

test("workload host: a NON-loopback host does not fold even on an ephemeral port", () => {
  const base = { ...baseMeta(), workload: urlWorkload("http://example.com:40001/") };
  const current = { ...baseMeta(), workload: urlWorkload("http://example.com:52000/") };
  const entry = axis(base, current, "workload");
  assert.ok(entry);
  assert.equal(entry.blocksGating, true, "only loopback hosts drop their port");
});

// The fold does not swallow a genuinely different loopback path: same folded port, different path
// still blocks, so the ephemeral token never hides a different page.
test("workload host: an ephemeral fold still blocks when the path differs", () => {
  const base = { ...baseMeta(), workload: urlWorkload("http://127.0.0.1:40001/a.html") };
  const current = { ...baseMeta(), workload: urlWorkload("http://127.0.0.1:52000/b.html") };
  const entry = axis(base, current, "workload");
  assert.ok(entry);
  assert.equal(entry.blocksGating, true, "the path differs, so the folded hosts still disagree");
});
