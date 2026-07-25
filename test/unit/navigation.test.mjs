import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyNavigation,
  shapeLcp,
  HARD_NAV_ORIGIN_DELTA_MS,
  LCP_STARTTIME_SLACK_MS,
} from "../../dist/browser/driver.js";

// The navigation classifier is a pure function of the two CDP-free reads a step already takes:
// before/after page.url() and before/after performance.timeOrigin. Its rule is the contract, so it is
// unit-tested independently of any browser.

test("unchanged URL is 'none' regardless of the clock", () => {
  assert.equal(classifyNavigation("https://x/a", "https://x/a", 1000, 1000), "none");
  // Even a moved origin does not override an unchanged URL: the URL is the primary gate (a same-url
  // reload is a documented blind spot, read as 'none').
  assert.equal(classifyNavigation("https://x/a", "https://x/a", 1000, 9999), "none");
});

test("changed URL + moved timeOrigin is a 'hard' navigation", () => {
  assert.equal(classifyNavigation("https://x/a", "https://x/b", 1000, 5000), "hard");
  assert.equal(classifyNavigation("about:blank", "https://x/", 0, 4000), "hard");
});

test("changed URL + unchanged timeOrigin is a 'soft' navigation", () => {
  assert.equal(classifyNavigation("https://x/a", "https://x/b", 1000, 1000), "soft");
  // A query-only change stays plain 'soft': a URL diff cannot tell an in-page filter from a route.
  assert.equal(classifyNavigation("https://x/a?q=1", "https://x/a?q=2", 1000, 1000), "soft");
});

test("a fragment-only change (same origin/path/query) is 'soft-hash'", () => {
  assert.equal(classifyNavigation("https://x/a", "https://x/a#s", 1000, 1000), "soft-hash");
  assert.equal(classifyNavigation("https://x/a#one", "https://x/a#two", 1000, 1000), "soft-hash");
  // A hash change that ALSO changes the path is not fragment-only: it is a plain soft route change.
  assert.equal(classifyNavigation("https://x/a#s", "https://x/b#s", 1000, 1000), "soft");
  // A hash change alongside a query change is not fragment-only either.
  assert.equal(classifyNavigation("https://x/a?q=1", "https://x/a?q=2#s", 1000, 1000), "soft");
});

test("the hard-vs-soft threshold is HARD_NAV_ORIGIN_DELTA_MS (0.5ms), boundary inclusive-below", () => {
  const under = HARD_NAV_ORIGIN_DELTA_MS; // exactly at the threshold: not > it, so still soft
  assert.equal(classifyNavigation("https://x/a", "https://x/b", 1000, 1000 + under), "soft");
  const over = HARD_NAV_ORIGIN_DELTA_MS + 0.001;
  assert.equal(classifyNavigation("https://x/a", "https://x/b", 1000, 1000 + over), "hard");
  // Jitter below the threshold does not read as a reload.
  assert.equal(classifyNavigation("https://x/a", "https://x/b", 1000, 1000.4), "soft");
});

// shapeLcp keeps only the fields that carry signal, leads with the identifiers that survive a
// production build (url/size/tag), and suppresses the new-headless startTime anomaly.

const rawLcp = (extra = {}) => ({
  url: "https://cdn/hero.avif",
  size: 240000,
  tag: "IMG",
  id: "hero",
  className: "hashed-abc123",
  renderTimeMs: 604.2,
  loadTimeMs: 512.1,
  startTimeMs: 604.2,
  ...extra,
});

test("shapeLcp returns null when nothing was observed", () => {
  assert.equal(shapeLcp(undefined, 1000), null);
});

test("shapeLcp keeps the identifier + timing fields", () => {
  const lcp = shapeLcp(rawLcp(), 1000);
  assert.equal(lcp.url, "https://cdn/hero.avif");
  assert.equal(lcp.size, 240000);
  assert.equal(lcp.tag, "IMG");
  assert.equal(lcp.id, "hero");
  assert.equal(lcp.className, "hashed-abc123");
  assert.equal(lcp.renderTimeMs, 604.2);
  assert.equal(lcp.startTimeMs, 604.2);
  assert.ok(!lcp.suppressed, "a sane entry is not suppressed");
});

test("shapeLcp drops empty/zero fields rather than storing them", () => {
  const lcp = shapeLcp(
    { url: "", size: 0, tag: "H1", id: "", className: "", renderTimeMs: 0, loadTimeMs: 40, startTimeMs: 30 },
    1000,
  );
  assert.ok(!("url" in lcp), "an empty url (text LCP) is dropped");
  assert.ok(!("size" in lcp), "a zero size is dropped");
  assert.ok(!("id" in lcp), "an empty id is dropped");
  assert.ok(!("renderTimeMs" in lcp), "a zero renderTime is dropped");
  assert.equal(lcp.tag, "H1");
  assert.equal(lcp.loadTimeMs, 40, "loadTime is the timing left when renderTime is unavailable");
  assert.equal(lcp.startTimeMs, 30);
});

test("shapeLcp suppresses an implausible startTime (new-headless anomaly) with no timing", () => {
  // ~60s startTime on a step whose window ended at ~40ms: beyond the bound + slack, so suppressed.
  const lcp = shapeLcp(rawLcp({ startTimeMs: 60000 }), 40);
  assert.deepEqual(lcp, { suppressed: true }, "suppressed carries no fabricated timing");
});

test("shapeLcp keeps an entry within the bound + slack", () => {
  const lcp = shapeLcp(rawLcp({ startTimeMs: 40 + LCP_STARTTIME_SLACK_MS }), 40);
  assert.ok(!lcp.suppressed, "at exactly bound + slack the entry is kept (not > the ceiling)");
  const beyond = shapeLcp(rawLcp({ startTimeMs: 40 + LCP_STARTTIME_SLACK_MS + 1 }), 40);
  assert.deepEqual(beyond, { suppressed: true });
});

test("shapeLcp skips the anomaly check when the bound is unknown (null)", () => {
  const lcp = shapeLcp(rawLcp({ startTimeMs: 60000 }), null);
  assert.equal(lcp.startTimeMs, 60000, "with no bound there is nothing to check against; kept verbatim");
});
