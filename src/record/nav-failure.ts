/**
 * When the built-in `--url` load flow fails on a SITE-BEHAVIOR class -- a navigation timeout, an
 * HTTP/2 stream reset (a transport-layer bot defence), or an execution-context-destroyed (the page
 * self-navigates / redirects into an interstitial) -- name the class and point at the driver-module
 * escape hatch. wpd deliberately exposes no `--nav-timeout` / site-level retry on the built-in flow: a
 * retry is a MEASUREMENT decision (the second hit is warm, cookied, and differently bot-scored), so it
 * belongs in a driver module the user authors with the full Puppeteer API. Returns null when the error
 * is not one of these classes (a bad host, a refused connection: a retry only makes those fail slower),
 * so the caller leaves the underlying message alone.
 *
 * This is guidance appended to the failure, NOT a retry: wpd retries its own machinery's races (a
 * transient cross-process boot, a headless frame stall; browser/launch.ts), never the site's refusals.
 */
export function builtinFlowFailureGuidance(error: Error): string | null {
  const message = error.message;
  let siteBehavior: string | null = null;
  if (/Navigation timeout of \d+ ms exceeded|net::ERR_TIMED_OUT/i.test(message))
    siteBehavior =
      "the page never reached the load event in time (heavy streaming / long-poll that never goes idle)";
  else if (/net::ERR_HTTP2_PROTOCOL_ERROR|net::ERR_SPDY_PROTOCOL_ERROR/i.test(message))
    siteBehavior = "the server reset the HTTP/2 stream (a bot defence at the transport layer)";
  else if (/Execution context was destroyed/i.test(message))
    siteBehavior =
      "the page self-navigated after first load (a redirect or an anti-bot interstitial), destroying the measure context";
  if (!siteBehavior) return null;
  return (
    `\n\nThis is the site's behavior, not a wpd bug: ${siteBehavior}. The built-in --url load flow does ` +
    `ONE navigation with fixed settings and no retry, on purpose -- a retry is a measurement decision ` +
    `(the second hit is warm, cookied, and differently bot-scored), so it belongs in a driver module ` +
    `you author with the full Puppeteer API:\n\n` +
    `  // save as load.mjs, then run: wpd record load.mjs --breakdown\n` +
    `  export async function run({ page }) {\n` +
    `    await page.goto("https://the-site.example", { waitUntil: "load", timeout: 60000 });\n` +
    `  }\n\n` +
    `Inside run() you set the timeout, add retry-with-backoff, send headers/cookies, or wait for a ` +
    `selector -- everything the built-in flow cannot decide for you. See the "driver module" section of the README.`
  );
}
