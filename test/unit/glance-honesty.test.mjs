import { test } from "node:test";
import assert from "node:assert/strict";
import {
  middleEllipsis,
  idleShareSuffix,
  spanWallProvenance,
  IDLE_DOMINANT_SHARE,
  LABEL_COL_MAX,
  SOURCE_COL_MAX,
} from "../../dist/output/ascii.js";
import { visibleLength } from "../../dist/output/color.js";

// middleEllipsis bounds a wide label/URL cell so it cannot size the whole table column. A short cell
// (the common case: "add rows", "app/render.ts:42") passes through untouched, so normal output is
// byte-for-byte unchanged; only a pathological width is cut, head and tail kept.
test("middleEllipsis leaves a cell at or under the cap untouched", () => {
  assert.equal(middleEllipsis("add rows", 60), "add rows");
  const exact = "x".repeat(60);
  assert.equal(middleEllipsis(exact, 60), exact);
});

test("middleEllipsis cuts a wide cell to the cap, keeping head and tail around one ellipsis", () => {
  const url = "https://cdn.example.com/very/deep/path/to/a/generated/bundle.chunk.abcdef.js";
  const cut = middleEllipsis(url, 40);
  assert.equal(visibleLength(cut), 40, "the cut cell is exactly the cap wide");
  assert.ok(cut.includes("…"), "a middle ellipsis marks the cut");
  assert.ok(cut.startsWith("https://"), "the head (origin) is kept");
  assert.ok(cut.endsWith(".js"), "the tail (the file) is kept");
});

test("middleEllipsis refuses a cap too small to say anything and returns the text", () => {
  // Below 5 there is no room for head + ellipsis + tail; a bare pass-through beats a lone "…".
  assert.equal(middleEllipsis("abcdefgh", 4), "abcdefgh");
});

// idleShareSuffix tags a settle/idle-dominated wall so its window width is not quoted as workload,
// and stays SILENT on a tight bench/interaction wall so the annotation never becomes per-row noise.
test("idleShareSuffix tags a wall whose window is idle-dominated", () => {
  assert.equal(idleShareSuffix(88, 100), "~88% idle");
  assert.equal(idleShareSuffix(80, 100), "~80% idle", "the threshold itself passes");
});

test("idleShareSuffix stays silent below the dominance threshold and on an empty window", () => {
  assert.equal(idleShareSuffix(50, 100), "");
  assert.equal(idleShareSuffix(0, 0), "");
  // Just under the threshold: no tag, so an interaction wall with real work is never nagged.
  assert.equal(idleShareSuffix(IDLE_DOMINANT_SHARE * 100 - 0.1, 100), "");
});

// spanWallProvenance names the STEP wall as a median, since the span's header aggregation ("first")
// describes its counts/bar window, not this number. Run/measure/single-sample say nothing here.
test("spanWallProvenance names a repeated step's wall as a median of its samples", () => {
  assert.equal(spanWallProvenance("step", 3), "median of 3 samples");
});

test("spanWallProvenance is silent for a single sample and for run/measure kinds", () => {
  assert.equal(spanWallProvenance("step", 1), "");
  assert.equal(spanWallProvenance("run", 5), "");
  assert.equal(spanWallProvenance("measure", 5), "");
});

test("the column caps are sane bounds", () => {
  assert.ok(LABEL_COL_MAX >= 20 && LABEL_COL_MAX <= 120);
  assert.ok(SOURCE_COL_MAX >= 40 && SOURCE_COL_MAX <= 160);
});
