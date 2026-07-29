// Bot-wall / captcha-interstitial detection: a pure classifier over page signals wpd reads AFTER
// its OWN navigation settles (the built-in --url load flow, a driver-mode initial --url host page, a
// bench host page), so a challenge interstitial is refused BEFORE any measurement pass runs rather
// than measured as if it were the site. The classifier is deliberately conservative -- it keys on the
// RENDERED interstitial (title, dominant iframe, near-empty DOM, main-document URL/origin,
// meta-refresh), NEVER on the mere PRESENCE of a captcha script. A normal shop embedding reCAPTCHA in
// a form must not trip it: reCAPTCHA's own origin is not in the challenge-host list at all, and a
// single non-dominant challenge iframe in a full DOM is one weak signal, below the 2-weak threshold.
//
// It claims only what it can see. Naming a challenge vendor is a factual ORIGIN observation (the frame
// came from that host), never a claim about the site's operator.

/** Host substrings that identify a known bot-challenge / captcha VENDOR origin. Substring, not exact:
 * `geo.captcha-delivery.com` and `ct.captcha-delivery.com` both match `captcha-delivery.com`. reCAPTCHA
 * (google.com/recaptcha) is deliberately ABSENT: it is the common legitimate form embed, so its
 * presence must never be a signal. */
export const CHALLENGE_HOST_PATTERNS = [
  "challenges.cloudflare.com",
  "captcha-delivery.com", // DataDome (geo. / ct.)
  "hcaptcha.com",
  "arkoselabs.com",
  "funcaptcha.com",
  "perimeterx.net",
  "px-cdn.net",
  "px-cloud.net",
] as const;

/** Known operator per challenge host, for a factual "(vendor)" annotation beside the origin. Naming
 * the operator is an observation about the ORIGIN, not a claim about who owns the measured site. */
const CHALLENGE_VENDOR: { pattern: string; vendor: string }[] = [
  { pattern: "challenges.cloudflare.com", vendor: "Cloudflare Turnstile" },
  { pattern: "captcha-delivery.com", vendor: "DataDome" },
  { pattern: "hcaptcha.com", vendor: "hCaptcha" },
  { pattern: "arkoselabs.com", vendor: "Arkose Labs" },
  { pattern: "funcaptcha.com", vendor: "Arkose Labs" },
  { pattern: "perimeterx.net", vendor: "PerimeterX / HUMAN" },
  { pattern: "px-cdn.net", vendor: "PerimeterX / HUMAN" },
  { pattern: "px-cloud.net", vendor: "PerimeterX / HUMAN" },
];

/** URL fragments a challenge page carries even when the top document stays on the site's OWN origin
 * (Cloudflare's managed-challenge query token, its same-origin challenge-platform path, DataDome's
 * interstitial path). Host-agnostic, so a same-origin challenge iframe is caught too. */
export const CHALLENGE_URL_MARKERS = [
  "__cf_chl",
  "/cdn-cgi/challenge-platform/",
  "captcha-delivery.com",
  "/interstitial/",
] as const;

/** Interstitial title patterns (case-insensitive substring), Chrome/DataDome/Cloudflare wording in
 * English and German (the dogfood ran CH/DE ecommerce). A title alone is ONE weak signal. */
export const CHALLENGE_TITLE_PATTERNS = [
  "just a moment",
  "attention required",
  "access denied",
  "checking your browser",
  "verifying you are human",
  "verify you are human",
  "are you a robot",
  "robot or human",
  "einen moment",
  "bitte bestätigen",
  "verifizierung",
  "sicherheitsüberprüfung",
] as const;

/** DOM small enough that its only real content is a challenge widget: at most this many interactive
 * elements, and less than this much visible text. A real store homepage clears both by orders of
 * magnitude, so this weak signal never fires on the site itself. */
const NEAR_EMPTY_MAX_INTERACTIVE = 2;
const NEAR_EMPTY_MAX_TEXT = 512;

/** The page signals the in-page collector reads after wpd's navigation settles. Constructed directly
 * in unit tests -- no browser needed to exercise the classifier. */
export interface BotWallSignals {
  /** the top document's URL after settle (page.url()) */
  mainDocumentUrl: string;
  /** document.title */
  title: string;
  /** srcs of iframes that DOMINATE the viewport (cover most of it); a subset of iframeSrcs */
  dominantIframeSrcs: string[];
  /** every iframe src in the document, dominant or not */
  iframeSrcs: string[];
  /** interactive elements (input/button/a/select/textarea) in the rendered body */
  interactiveElementCount: number;
  /** trimmed visible body text length */
  bodyTextLength: number;
  /** an http-equiv="refresh" / JS-redirect target, when one names a challenge URL; else null */
  metaRefreshUrl: string | null;
}

/** The classifier's verdict: whether the page is a challenge interstitial, the evidence that fired,
 * and the challenge vendor origins observed (a factual list, never an ownership claim). */
export interface BotWallVerdict {
  detected: boolean;
  /** human evidence strings, e.g. "dominant full-viewport iframe from challenges.cloudflare.com" */
  firedSignals: string[];
  /** challenge vendor origins observed, as "host (Vendor)"; empty when none was a known vendor host */
  vendors: string[];
}

function hostnameOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The challenge-host pattern this hostname matches, or null. */
function challengeHost(hostname: string): string | null {
  if (!hostname) return null;
  for (const pattern of CHALLENGE_HOST_PATTERNS) if (hostname.includes(pattern)) return pattern;
  return null;
}

/** The challenge-URL marker this url carries, or null. */
function challengeUrlMarker(url: string | null | undefined): string | null {
  if (!url) return null;
  for (const marker of CHALLENGE_URL_MARKERS) if (url.includes(marker)) return marker;
  return null;
}

/** The title pattern this title matches, or null. */
function challengeTitle(title: string): string | null {
  const lower = title.toLowerCase();
  for (const pattern of CHALLENGE_TITLE_PATTERNS) if (lower.includes(pattern)) return pattern;
  return null;
}

/** How an iframe reads as a challenge frame (by vendor host, or by a same-origin challenge path), or
 * null. `vendorHost` is set only when the match is a known vendor origin, so it feeds the vendor list. */
function iframeChallenge(src: string): { how: string; vendorHost?: string } | null {
  const host = challengeHost(hostnameOf(src));
  if (host) return { how: `from ${host}`, vendorHost: host };
  const marker = challengeUrlMarker(src);
  if (marker) return { how: `carrying a challenge path (${marker})` };
  return null;
}

/** Annotate a challenge host with its known operator, e.g. "challenges.cloudflare.com (Cloudflare
 * Turnstile)". A factual origin observation, not an ownership claim. */
export function vendorLabel(host: string): string {
  const known = CHALLENGE_VENDOR.find((entry) => host.includes(entry.pattern));
  return known ? `${host} (${known.vendor})` : host;
}

/**
 * Classify page signals as a bot-challenge interstitial or not. Requires STRONG evidence: one strong
 * signal (a challenge-origin main document, a challenge-marker main URL, or a DOMINANT challenge
 * iframe) OR two independent weak signals (a challenge title, a non-dominant challenge iframe, a
 * near-empty DOM whose only content is a challenge widget, a meta-refresh into a challenge URL). Pure:
 * no I/O, no page handle.
 */
export function classifyBotWall(signals: BotWallSignals): BotWallVerdict {
  const strong: string[] = [];
  const weak: string[] = [];
  const vendors = new Set<string>();

  const mainHost = challengeHost(hostnameOf(signals.mainDocumentUrl));
  if (mainHost) {
    strong.push(`main document served from ${vendorLabel(mainHost)}`);
    vendors.add(vendorLabel(mainHost));
  }
  const mainMarker = challengeUrlMarker(signals.mainDocumentUrl);
  if (mainMarker) strong.push(`main document URL carries a challenge marker (${mainMarker})`);

  const dominant = new Set(signals.dominantIframeSrcs);
  for (const src of signals.dominantIframeSrcs) {
    const match = iframeChallenge(src);
    if (!match) continue;
    strong.push(`dominant full-viewport iframe ${match.how}`);
    if (match.vendorHost) vendors.add(vendorLabel(match.vendorHost));
  }
  // A NON-dominant challenge iframe is one weak signal: a real form may embed one, so it only counts
  // toward detection paired with a second weak signal.
  const weakHostsSeen = new Set<string>();
  for (const src of signals.iframeSrcs) {
    if (dominant.has(src)) continue;
    const match = iframeChallenge(src);
    if (!match || weakHostsSeen.has(match.how)) continue;
    weakHostsSeen.add(match.how);
    weak.push(`iframe ${match.how}`);
    if (match.vendorHost) vendors.add(vendorLabel(match.vendorHost));
  }

  if (challengeTitle(signals.title))
    weak.push(`challenge-page title ${JSON.stringify(signals.title.trim())}`);

  const nearEmpty =
    signals.interactiveElementCount <= NEAR_EMPTY_MAX_INTERACTIVE &&
    signals.bodyTextLength < NEAR_EMPTY_MAX_TEXT;
  const anyChallengeIframe = signals.iframeSrcs.some((src) => iframeChallenge(src) != null);
  if (nearEmpty && anyChallengeIframe)
    weak.push("near-empty DOM whose only interactive content is a challenge widget");

  if (
    signals.metaRefreshUrl &&
    (challengeHost(hostnameOf(signals.metaRefreshUrl)) ||
      challengeUrlMarker(signals.metaRefreshUrl))
  )
    weak.push("meta-refresh redirect into a challenge URL");

  const detected = strong.length >= 1 || weak.length >= 2;
  return {
    detected,
    firedSignals: detected ? [...strong, ...weak] : [],
    vendors: [...vendors],
  };
}

/** Marker in a BotWallError message, so a caller can tell a refusal apart from any other record
 * failure without matching prose. */
export const BOT_WALL_MARKER = "wpd:bot-wall";

/** The refusal error record() throws when detection fires and --allow-bot-wall was not set. Its
 * message is the full evidence list the CLI prints; it carries the verdict + screenshot path for a
 * structured caller. Not a transient/frame-stall error, so retryTransientNav re-throws it at once. */
export class BotWallError extends Error {
  readonly verdict: BotWallVerdict;
  readonly screenshotPath: string | null;
  constructor(verdict: BotWallVerdict, screenshotPath: string | null) {
    super(botWallRefusalMessage(verdict, screenshotPath));
    this.name = "BotWallError";
    this.verdict = verdict;
    this.screenshotPath = screenshotPath;
  }
}

/** The evidence-listed refusal text: what fired, the vendor origins observed, the screenshot path,
 * and the skip flag. Never suggests bypassing/solving the challenge -- refusal only. */
export function botWallRefusalMessage(
  verdict: BotWallVerdict,
  screenshotPath: string | null,
): string {
  const evidence = verdict.firedSignals.map((signal) => `  - ${signal}`).join("\n");
  const shot = screenshotPath
    ? `\n\nScreenshot (proof): ${screenshotPath}`
    : "\n\n(a screenshot could not be captured on this lane)";
  return (
    `${BOT_WALL_MARKER}: the page wpd navigated to matches bot-challenge interstitial signals, so any ` +
    `numbers would describe the challenge page, not the site.\n\nSignals:\n${evidence}${shot}\n\n` +
    `wpd does not bypass, wait out, or solve challenges -- it detects and refuses. To measure the ` +
    `challenge page itself anyway, re-record with --allow-bot-wall.`
  );
}
