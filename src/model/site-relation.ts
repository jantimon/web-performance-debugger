import { getDomain } from "tldts";
import type { RecordingMeta } from "./recording.js";

/**
 * A URL-MECHANICAL relation between an origin bucket and the measured page, computed with the
 * public-suffix list (registrable domain / eTLD+1). This is `site relation`, and ONLY that: it says
 * whether two URLs share an origin or a registrable domain, a fact anyone can recompute from the URLs.
 *
 * It is NOT ownership and NOT "third-party". A cross-site CDN can be first-party-owned -- the canonical
 * case is `assets.alicdn.com` serving Aliexpress, cross-SITE from `aliexpress.com` yet the same
 * company. Ownership is the caller's classification; wpd states the mechanical relation and stops there
 */
export type SiteRelation = "same-origin" | "same-site" | "cross-site";

/**
 * The host of an origin bucket key (`(assets.alicdn.com)`, `(127.0.0.1:3000)`), or null when the key
 * is not an origin bucket. The other parenthesized buckets are NOT origins ((native)/(node)/(blob)/
 * (inline)/(wasm)/(served)/(unmapped)/(unmapped: pkg)), so they return null and carry no site relation.
 * A host is recognised by a dot, a bracketed IPv6 literal, or the literal `localhost`
 */
export function originBucketHost(key: string): string | null {
  if (!key.startsWith("(") || !key.endsWith(")")) return null;
  const inner = key.slice(1, -1);
  if (!inner || inner.includes(" ") || inner.startsWith("unmapped")) return null;
  const reserved = new Set([
    "native",
    "node",
    "blob",
    "inline",
    "wasm",
    "served",
    "program",
    "root",
  ]);
  if (reserved.has(inner)) return null;
  // [::1] / [::1]:port IPv6
  if (inner.startsWith("[")) return inner;
  const hostname = inner.split(":")[0];
  if (hostname !== "localhost" && !hostname.includes(".")) return null;
  return inner;
}

/**
 * The site relation of an origin-bucket host to the measured page URL, or undefined when it cannot be
 * decided (no page URL, an unparseable host). `same-origin` = same host (with an explicit port
 * matching, or the bucket's port dropped as an ephemeral accident); `same-site` = same registrable
 * domain via the PSL; `cross-site` otherwise. Pure and hand-rolled-suffix-free (tldts owns the PSL)
 */
export function siteRelation(bucketHost: string, pageUrl: string): SiteRelation | undefined {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (!page.hostname) return undefined;
  let bucket: URL;
  try {
    bucket = new URL(`https://${bucketHost}`);
  } catch {
    return undefined;
  }
  if (!bucket.hostname) return undefined;
  // Same host: identical host:port, or identical hostname when the bucket dropped an ephemeral port
  if (bucket.host === page.host || bucket.hostname === page.hostname) return "same-origin";
  const pageDomain = getDomain(page.hostname);
  const bucketDomain = getDomain(bucket.hostname);
  if (pageDomain && bucketDomain && pageDomain === bucketDomain) return "same-site";
  return "cross-site";
}

/** The host (with port) of an http(s) URL, for a site-relation comparison; undefined for a non-http
 * scheme or an unparseable URL. Pairs with `siteRelation`, which reconstructs `https://${host}` */
export function originHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.host;
  } catch {
    return undefined;
  }
}

/**
 * The measured page's URL for the site-relation comparison, or undefined when the recording had no
 * remote page (a bench/module run, or a local-file host): only a `--url` run navigated to a real URL.
 *
 * This is `meta.target` (the `--url` the run measured), the stable anchor for BOTH a bench-mode and a
 * driver-mode `--url` run. A driver flow that NAVIGATES between steps ends on a different URL, but the
 * post-navigation URL is not derivable from the CpuModel (it carries no per-sample document URL), so
 * re-anchoring the relation to a step's final URL is deliberately NOT attempted: a wrong same/cross
 * tag would be worse than anchoring on the measured entry URL. Same-site work stays same-site across an
 * in-site route; only a cross-registrable-domain navigation would shift the anchor, which is out of scope
 */
export function measuredPageUrl(meta: RecordingMeta): string | undefined {
  return meta.mode === "url" ? meta.target : undefined;
}
