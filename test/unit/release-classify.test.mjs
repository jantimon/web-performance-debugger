import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPublishFailure } from "../../scripts/release.mjs";

// The release wrapper turns ONE specific `changeset publish` failure into a no-op success: the current
// version is already on npm, so a no-changeset push to main should not red the release job. Every other
// failure must still propagate. `classifyPublishFailure(output, currentVersion)` is the pure decision;
// these fixtures reproduce the real changeset/npm output shapes it reads

const alreadyPublished = [
  "🦋  info npm info @jantimon/web-performance-debugger",
  "🦋  info @jantimon/web-performance-debugger is being published because our local version (1.2.0) has not been published on npm",
  '🦋  info Publishing "@jantimon/web-performance-debugger" at "1.2.0"',
  "🦋  error an error occurred while publishing @jantimon/web-performance-debugger: undefined You cannot publish over the previously published versions: 1.2.0. ",
  "🦋  error npm error You cannot publish over the previously published versions: 1.2.0.",
  "🦋  error ",
  "🦋  error packages failed to publish:",
  "🦋  @jantimon/web-performance-debugger@1.2.0",
].join("\n");

test("current version already on npm is a no-op success", () => {
  const verdict = classifyPublishFailure(alreadyPublished, "1.2.0");
  assert.equal(verdict.alreadyPublished, true);
  assert.deepEqual(verdict.failedPackages, [
    { name: "@jantimon/web-performance-debugger", version: "1.2.0" },
  ]);
});

test("the same output does NOT excuse a different current version", () => {
  // package.json says 1.3.0 but the registry rejected 1.2.0: a real mismatch, not a benign re-run
  const verdict = classifyPublishFailure(alreadyPublished, "1.3.0");
  assert.equal(verdict.alreadyPublished, false);
});

test("ANSI color codes do not defeat the classifier", () => {
  const colored = alreadyPublished
    .replace("You cannot", "[31mYou cannot")
    .replace("1.2.0. ", "1.2.0.[39m ");
  assert.equal(classifyPublishFailure(colored, "1.2.0").alreadyPublished, true);
});

test("a genuine publish error (no cannot-publish marker) propagates", () => {
  const networkFailure = [
    "🦋  info Publishing \"@jantimon/web-performance-debugger\" at \"1.2.0\"",
    "🦋  error an error occurred while publishing @jantimon/web-performance-debugger: E500 network error",
    "🦋  error packages failed to publish:",
    "🦋  @jantimon/web-performance-debugger@1.2.0",
  ].join("\n");
  assert.equal(classifyPublishFailure(networkFailure, "1.2.0").alreadyPublished, false);
});

test("no failed-packages block means no benign no-op", () => {
  // A crash before the publish loop leaves no failure list; there is nothing to excuse
  const early = "🦋  error EACCES: permission denied, open '/home/runner/.npmrc'";
  assert.equal(classifyPublishFailure(early, "1.2.0").alreadyPublished, false);
});

test("a package failing at another version propagates", () => {
  // The current package is already on npm, but a sibling failed at a different version for a real
  // reason: not all failures are the current version, so the guard must not swallow it
  const mixed = [
    "🦋  error npm error You cannot publish over the previously published versions: 1.2.0.",
    "🦋  error an error occurred while publishing @jantimon/other: E500 network error",
    "🦋  error packages failed to publish:",
    "🦋  @jantimon/web-performance-debugger@1.2.0",
    "🦋  @jantimon/other@9.9.9",
  ].join("\n");
  assert.equal(classifyPublishFailure(mixed, "1.2.0").alreadyPublished, false);
});
