import fs from "node:fs";

/**
 * The resolved meaning of the host-page option (`--url <value>`, or its `--html` alias): either a
 * live URL to navigate to, or a local HTML file to serve and load. The option accepts both spellings
 * of a host page and discovers which one from the value.
 */
export type PageResolution =
  | { kind: "url"; url: string; schemeAssumed: boolean }
  | { kind: "html"; html: string };

// A host-only value we accept as a URL with http:// assumed: localhost / loopback / an explicit
// host:port, each with an optional port and an optional path. A bare word ("nope") is deliberately
// NOT host-ish -- it must fall through to the dual file/URL error rather than become http://nope.
const HOST_ISH =
  /^(?:(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?|[a-zA-Z0-9.-]+:\d+)(?:\/[^\s]*)?$/;

/**
 * Resolve the host-page value (`--url <value>`) into a URL or a local-HTML case. Detection order:
 *   1. contains `://` -> a URL (http/https accepted; file:// points at the plain-path form).
 *   2. else, exists on disk -> the local-HTML case (served, so it must live under cwd).
 *   3. else, host-ish (localhost / 127.0.0.1 / [::1] / host:port, optional path) -> URL, http:// assumed.
 *   4. else -> error naming BOTH interpretations tried.
 *
 * `fileExists` is injected so the pure detection order is unit-testable without touching the disk.
 * Requiring `://` for the scheme branch is what keeps `C:\path` / `C:/path` out of it.
 */
export function resolvePageOption(
  value: string,
  fileExists: (candidate: string) => boolean = (candidate) => fs.existsSync(candidate),
): PageResolution {
  if (value.includes("://")) {
    if (/^file:\/\//i.test(value))
      throw new Error(
        `--url "${value}": a file:// URL names a local file -- pass its plain path instead (wpd record --url ./page.html).`,
      );
    if (/^https?:\/\//i.test(value)) return { kind: "url", url: value, schemeAssumed: false };
    throw new Error(
      `--url "${value}": only http:// and https:// URLs are supported. For a local file, pass its plain path (wpd record --url ./page.html).`,
    );
  }
  if (fileExists(value)) return { kind: "html", html: value };
  if (HOST_ISH.test(value)) return { kind: "url", url: `http://${value}`, schemeAssumed: true };
  throw new Error(
    `--url "${value}": no such file, and not a recognizable URL. Pass an existing file path, or a URL (https://example.com, localhost:5173).`,
  );
}
