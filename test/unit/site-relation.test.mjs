import { test } from "node:test";
import assert from "node:assert/strict";
import { siteRelation, originBucketHost, measuredPageUrl } from "../../dist/model/site-relation.js";
import { packageRollup } from "../../dist/profile/cpuprofile.js";

// Site relation is a URL-MECHANICAL fact (registrable domain via the public-suffix list), never an
// ownership or "third-party" claim. The canonical case: assets.alicdn.com is cross-SITE from
// aliexpress.com yet the same company owns both

test("same registrable domain, different host => same-site", () => {
  assert.equal(siteRelation("assets.coop.ch", "https://www.coop.ch/"), "same-site");
});

test("different registrable domain => cross-site (a first-party CDN can still be cross-site)", () => {
  assert.equal(siteRelation("assets.alicdn.com", "https://www.aliexpress.com/"), "cross-site");
});

test("identical host => same-origin", () => {
  assert.equal(siteRelation("www.shop.example", "https://www.shop.example/path"), "same-origin");
});

test("public-suffix aware: co.uk is not the registrable domain", () => {
  // foo.co.uk and bar.co.uk are DIFFERENT registrable domains; a hand-rolled suffix strip would call
  // them same-site. The PSL gets it right
  assert.equal(siteRelation("cdn.bar.co.uk", "https://www.foo.co.uk/"), "cross-site");
  assert.equal(siteRelation("cdn.foo.co.uk", "https://www.foo.co.uk/"), "same-site");
});

test("undecidable inputs return undefined, never a fabricated relation", () => {
  assert.equal(siteRelation("assets.alicdn.com", "not a url"), undefined);
  assert.equal(siteRelation("", "https://www.shop.example/"), undefined);
});

test("originBucketHost recognises origin buckets and rejects the reserved buckets", () => {
  assert.equal(originBucketHost("(assets.alicdn.com)"), "assets.alicdn.com");
  assert.equal(originBucketHost("(127.0.0.1:3000)"), "127.0.0.1:3000");
  assert.equal(originBucketHost("(localhost)"), "localhost");
  assert.equal(originBucketHost("(native)"), null);
  assert.equal(originBucketHost("(node)"), null);
  assert.equal(originBucketHost("(unmapped)"), null);
  assert.equal(originBucketHost("(unmapped: @scope/pkg)"), null);
  assert.equal(originBucketHost("react-dom"), null, "a real package is not an origin bucket");
});

test("packageRollup tags an origin bucket with its site relation; real packages carry none", () => {
  // The canonical case: alicdn.com is cross-SITE from aliexpress.com, yet Aliexpress owns it. wpd
  // reports the mechanical relation and nothing about ownership
  const model = {
    meta: { mode: "url", target: "https://www.aliexpress.com/" },
    jsSelfMs: 10,
    functions: [
      { id: 0, fn: "a", package: "(assets.alicdn.com)", selfMs: 6, selfPct: 60, totalMs: 6 },
      { id: 1, fn: "b", package: "app", selfMs: 4, selfPct: 40, totalMs: 4 },
    ],
  };
  const rollup = packageRollup(model);
  assert.equal(rollup.find((entry) => entry.key === "(assets.alicdn.com)").siteRelation, "cross-site");
  assert.equal(rollup.find((entry) => entry.key === "app").siteRelation, undefined, "a real package carries no site relation");
});

test("packageRollup on a bench/module run tags nothing (no page URL to compare against)", () => {
  const model = {
    meta: { mode: "bench", target: "probe.mjs" },
    jsSelfMs: 5,
    functions: [{ id: 0, fn: "a", package: "(cdn.example.com)", selfMs: 5, selfPct: 100, totalMs: 5 }],
  };
  assert.equal(packageRollup(model)[0].siteRelation, undefined);
});

test("measuredPageUrl is the --url page, and undefined for a bench/module run", () => {
  assert.equal(
    measuredPageUrl({ mode: "url", target: "https://www.shop.example/" }),
    "https://www.shop.example/",
  );
  assert.equal(measuredPageUrl({ mode: "module", target: "src/x.mjs" }), undefined);
  assert.equal(measuredPageUrl({ mode: "html", target: "page.html" }), undefined);
});
