import { test } from "node:test";
import assert from "node:assert/strict";
import { shortSource, shortRemoteUrl, tailPath } from "../../dist/profile/cpuprofile.js";

// The `function (source)` cell in `query cpu` / `query span` / `cpu-diff` tables. A local path is
// tailed to its last segments; an unmapped remote frame's `file` is its full URL, which can run
// hundreds of chars (a config endpoint with a long query string) and size the column to a wall of
// dashes. shortSource compacts a remote URL to origin + truncated path, query/hash dropped.

test("shortSource tails a local path and keeps the line", () => {
  assert.equal(shortSource("src/app/render.ts", "src/app/render.ts:42"), "app/render.ts:42");
  assert.equal(shortSource("src/app/render.ts", undefined), "app/render.ts");
});

test("shortSource compacts a remote URL to origin + path tail, dropping the query string", () => {
  const url =
    "https://connect.facebook.net/signals/config/1234567890?v=2.9.170&r=stable&domain=example.com&hme=abc123def456&ex_m=72%2C121%2C0";
  const compact = shortSource(url, `${url}:1`);
  assert.ok(compact.length < 80, `expected a compact cell, got ${compact.length} chars: ${compact}`);
  assert.ok(compact.startsWith("https://connect.facebook.net"), "origin is kept as the signal");
  assert.ok(!compact.includes("?"), "the query string is dropped from display");
  assert.ok(compact.endsWith(":1"), "the line is preserved");
});

test("shortRemoteUrl keeps the origin whole and elides deep paths", () => {
  assert.equal(
    shortRemoteUrl("https://cdn.example.com/a/b/c/d/bundle.js"),
    "https://cdn.example.com/…/d/bundle.js",
  );
  // A bare-origin script (no path) keeps just the origin.
  assert.equal(shortRemoteUrl("https://cdn.example.com/"), "https://cdn.example.com");
});

test("shortRemoteUrl caps one pathological long path segment", () => {
  const longSegment = "x".repeat(300);
  const compact = shortRemoteUrl(`https://cdn.example.com/${longSegment}`);
  assert.ok(compact.length < 90, `expected a capped cell, got ${compact.length} chars`);
  assert.ok(compact.endsWith("…"), "an over-long tail is ellipsized");
});

test("shortRemoteUrl returns a non-URL string unchanged", () => {
  assert.equal(shortRemoteUrl("not a url"), "not a url");
});

test("tailPath is unchanged for local paths (regression guard)", () => {
  assert.equal(tailPath("/a/b/c/d.js"), "c/d.js");
  assert.equal(tailPath("d.js"), "d.js");
});
