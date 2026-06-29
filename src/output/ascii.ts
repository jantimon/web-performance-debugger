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
