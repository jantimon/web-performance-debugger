// Idempotent release wrapper around `changeset publish`. A push to main runs this even when there is
// nothing to release (no pending changesets), so `changeset publish` re-attempts the current version
// When that version is already on npm, npm refuses with "cannot publish over the previously published
// versions", and changesets reports a hard failure that reds the release job on every such push
//
// This wrapper streams changeset's output through unchanged, and on a non-zero exit inspects it: if the
// ONLY publish failure is that the version currently in package.json is already on npm, it exits 0 with
// a one-line note (nothing to publish). Every other failure propagates with the original exit code, so
// a genuine publish error still reds the job
//
// Run through `npm run release`, which builds first: `npm run build && node scripts/release.mjs`
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Strip ANSI SGR sequences so the classifier matches on plain text (changeset colorizes its output)
const ANSI_PATTERN = /\[[0-9;]*m/g;
function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, "");
}

function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The "packages failed to publish:" trailer lists each unpublished package as `name@version`, one per
// line, prefixed by changeset's butterfly marker. Collect those entries so the caller can confirm every
// failed package is the current version (and no other package failed for a different reason)
function extractFailedPackages(plainOutput) {
  const lines = plainOutput.split("\n").map((line) => line.trim());
  const headerIndex = lines.findIndex((line) => line.endsWith("packages failed to publish:"));
  if (headerIndex === -1) return [];
  const failed = [];
  for (const line of lines.slice(headerIndex + 1)) {
    // Drop the "🦋 " marker changeset prefixes each entry with, then match a `name@version` token
    const withoutMarker = line.replace(/^🦋\s*/, "").trim();
    const match = withoutMarker.match(/^(@?[^@\s]+(?:\/[^@\s]+)?)@(\S+)$/);
    if (match) failed.push({ name: match[1], version: match[2] });
    // list ended; stop before unrelated trailing output
    else if (withoutMarker !== "") break;
  }
  return failed;
}

/**
 * Decide whether a failed `changeset publish` is the benign "current version already on npm" case.
 * Safe (alreadyPublished) only when BOTH hold: the output carries npm's cannot-publish-over marker for
 * the current version, AND every package listed as failed is at the current version. Anything else
 * (a different version, a second failing package, a missing marker) is a real failure to propagate
 */
export function classifyPublishFailure(rawOutput, currentVersion) {
  const plainOutput = stripAnsi(rawOutput);
  const alreadyPublishedMarker = new RegExp(
    `cannot publish over the previously published versions?: ${escapeForRegExp(currentVersion)}\\b`,
  );
  const hasAlreadyPublishedMarker = alreadyPublishedMarker.test(plainOutput);
  const failedPackages = extractFailedPackages(plainOutput);
  const allFailuresAreCurrentVersion = failedPackages.length > 0
    && failedPackages.every((entry) => entry.version === currentVersion);
  return {
    alreadyPublished: hasAlreadyPublishedMarker && allFailuresAreCurrentVersion,
    failedPackages,
  };
}

function main() {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const currentVersion = packageJson.version;
  const changesetBin = path.join(root, "node_modules", ".bin", "changeset");

  const child = spawn(changesetBin, ["publish"], { cwd: root });
  let combinedOutput = "";
  child.stdout.on("data", (chunk) => {
    combinedOutput += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    combinedOutput += chunk;
    process.stderr.write(chunk);
  });
  child.on("error", (spawnError) => {
    console.error(spawnError);
    process.exit(1);
  });
  child.on("close", (exitCode) => {
    if (exitCode === 0) {
      process.exit(0);
    }
    const { alreadyPublished } = classifyPublishFailure(combinedOutput, currentVersion);
    if (alreadyPublished) {
      console.log(`\n${packageJson.name}@${currentVersion} already on npm; nothing to publish.`);
      process.exit(0);
    }
    process.exit(exitCode ?? 1);
  });
}

// Run the wrapper only when invoked directly; importing this file (the unit test) gets the pure
// classifier without spawning changeset
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
