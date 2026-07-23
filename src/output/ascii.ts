import { visibleLength } from "./color.js";

const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[]): string {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map(
      (value) =>
        BARS[Math.min(BARS.length - 1, Math.round(((value - min) / span) * (BARS.length - 1)))],
    )
    .join("");
}

// Cells may contain ANSI color codes; widths and padding are measured by visible length so
// colored output stays aligned. With plain input this is identical to a padEnd-based table.
export function table(headers: string[], rows: (string | number)[][]): string {
  const all = [headers, ...rows.map((row) => row.map(String))];
  const widths = headers.map((_, column) =>
    Math.max(...all.map((row) => visibleLength(String(row[column] ?? "")))),
  );
  const padCell = (cell: string | number, column: number) => {
    const text = String(cell ?? "");
    return text + " ".repeat(Math.max(0, widths[column] - visibleLength(text)));
  };
  const fmtRow = (row: (string | number)[]) =>
    row.map((cell, column) => padCell(cell, column)).join("  ");
  const sep = widths.map((width) => "─".repeat(width)).join("  ");
  return [fmtRow(headers), sep, ...rows.map(fmtRow)].join("\n");
}

export function kv(pairs: [string, string | number][]): string {
  const width = Math.max(...pairs.map(([key]) => key.length));
  return pairs.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n");
}

export function num(value: number, digits = 2): string {
  if (!isFinite(value)) return "—";
  return Number(value.toFixed(digits)).toString();
}

/**
 * Bound a cell that is wider than a real page allows (a URL used as a span label, a deep remote
 * source path) so it cannot size the whole column and wrap the terminal. Keeps the head (which names
 * the thing) and the tail (the line/file) around one ellipsis, and measures by VISIBLE width so an
 * already-colored cell is bounded by what shows, not by escape bytes. Apply to the plain text before
 * coloring: the cut lands on the raw string, never mid-escape. A `max` below 5 leaves no room for
 * head + ellipsis + tail, so the text passes through unbounded rather than collapsing to a lone dot.
 */
export function middleEllipsis(text: string, max: number): string {
  if (max < 5 || visibleLength(text) <= max) return text;
  // A label/path cell carries no ANSI in practice, so the raw string is the visible string; the
  // visibleLength guard above still keeps a pre-colored cell from slipping past the bound.
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** Column-width caps for the human tables: a span label, and a source path/URL. A bench/interaction
 * label and a local source line sit well under these, so normal output is byte-for-byte unchanged;
 * only a real-site URL-shaped cell is bounded (middle-ellipsis) so it cannot size the whole column. */
export const LABEL_COL_MAX = 60;
export const SOURCE_COL_MAX = 80;

/** At or above this idle share a span's wall is settle/idle-dominated, so the window width reads as
 * workload cost unless the idle share rides alongside it. Below it (a tight bench or interaction
 * wall) nothing is said. */
export const IDLE_DOMINANT_SHARE = 0.8;

/** The idle-share tag for a span wall whose own reconciling window is idle-dominated, else "". Only a
 * span whose wall IS the tiled window (Σ slices + idle = wall) may pass this idleMs/wallMs, so the
 * share is honest; a bench wall (run() sum, a different denominator than the sampled window) must not. */
export function idleShareSuffix(idleMs: number, wallMs: number): string {
  if (wallMs <= 0) return "";
  const share = idleMs / wallMs;
  if (share < IDLE_DOMINANT_SHARE) return "";
  return `~${Math.round(share * 100)}% idle`;
}

/** Point-of-use provenance for a span's WALL number, or "". A step's wall is the MEDIAN of its
 * samples while the span's `aggregation` is "first" (its counts/bar window to iteration 0), so the
 * header aggregation does not describe the wall; name the median where the number is. A single sample
 * needs nothing, and run (sum) / a merged measure (its own spread line) are already self-describing. */
export function spanWallProvenance(kind: string, sampleCount: number): string {
  if (kind === "step" && sampleCount > 1) return `median of ${sampleCount} samples`;
  return "";
}
