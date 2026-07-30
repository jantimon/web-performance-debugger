// Classify a window `error` message as a React hydration recoverable error. React routes every error
// to a react.dev URL, so matching that marker keeps arbitrary app errors out of the count. A hydration
// error links to `react.dev/link/hydration-mismatch` (development, full text) or a hydration error CODE
// under `react.dev/errors/` (production, minified). [measured] react 19.2 fires #418 for a text
// mismatch, in production and development alike; [source] the hydration recoverable-error set is
// 418/421/422/423/425. Pure and string-only, so it is unit-testable and shared by the page hook's
// inline prefilter and the enrich-side count.

/** React error codes emitted through onRecoverableError during hydration (production minified form). */
const HYDRATION_ERROR_CODES = new Set([418, 421, 422, 423, 425]);

/** True when a window `error` message is a React hydration recoverable error (either build). */
export function isReactHydrationError(message: string): boolean {
  if (typeof message !== "string") return false;
  if (message.includes("react.dev/link/hydration-mismatch")) return true;
  const codeMatch = message.match(/react\.dev\/errors\/(\d+)/);
  return codeMatch != null && HYDRATION_ERROR_CODES.has(Number(codeMatch[1]));
}
