// ANSI color/style helpers for human-facing terminal output.
//
// Disabled by default: the library stays colorless when its functions are called directly
// (unit tests, programmatic use), so only the CLI opts in (see cli.ts: it enables color from
// --color/NO_COLOR/isTTY in a preAction hook). Structured output (--json/--format) never calls
// these helpers, so JSON/TOON and any piped/agent-consumed output stay byte-for-byte plain.

let enabled = false;

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

export function colorEnabled(): boolean {
  return enabled;
}

const wrap =
  (open: number, close: number) =>
  (text: string | number): string =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const magenta = wrap(35, 39);

// Matches CSI SGR sequences so visible width can be measured around them.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Length of a string ignoring ANSI escape sequences (its on-screen column width). */
export function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}
