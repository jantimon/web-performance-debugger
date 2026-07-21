import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Compile-time contract: the package root (src/index.ts, built to dist/index.d.ts) is the ONLY
// semver-covered surface, and the README "Consuming the JSON" table promises a type for every artifact
// and structured output. tsc erases types at runtime, so this reads the emitted declaration file and
// fails if any documented root type is not re-exported -- a dropped export is caught here, not by a
// consumer's red build.

const here = path.dirname(fileURLToPath(import.meta.url));
const declaration = readFileSync(path.join(here, "..", "..", "dist", "index.d.ts"), "utf8");

// Every type the README type table and the run-group contract promise from the package root.
const DOCUMENTED_ROOT_TYPES = [
  // recording / cpu model artifacts
  "Recording",
  "Span",
  "CpuModel",
  "CpuFunction",
  "NormalizedEvent",
  // structured query / diff outputs
  "SpansResult",
  "SpanEntry",
  "UnifiedSlices",
  "SpanAnatomy",
  "CpuOverview",
  "FrameQueryResult",
  "BlameEntry",
  "CpuDiffResult",
  // run-group manifest + stitched group-query outputs (the D5 additions)
  "RunGroup",
  "GroupMeta",
  "GroupMember",
  "GroupSpanMember",
  "GroupSpanSources",
  "GroupSpanStitch",
  "GroupSpansProvenance",
  "GroupSpansResult",
  "SpansOutput",
];

test("every documented root type is re-exported from the built package", () => {
  const missing = DOCUMENTED_ROOT_TYPES.filter(
    // Match the identifier as a whole word inside an `export type { ... }` list.
    (name) => !new RegExp(`\\b${name}\\b`).test(declaration),
  );
  assert.deepEqual(missing, [], `dist/index.d.ts is missing root type exports: ${missing.join(", ")}`);
});
