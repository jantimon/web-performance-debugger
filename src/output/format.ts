import { encode, decode } from "@toon-format/toon";

export type Format = "json" | "toon";

export function isFormat(value: string): value is Format {
  return value === "json" || value === "toon";
}

// Decimal places kept on serialized numbers. 4 == 0.1us, far finer than any signal here
// (CPU sampling noise is a few %, wall time is Chrome-clamped), and it strips binary-float
// dust like 0.026000000000000002 -> 0.026, which is most of the output's wasted bytes.
const SERIALIZED_DECIMALS = 4;
const ROUND_FACTOR = 10 ** SERIALIZED_DECIMALS;

/** Deep copy with every finite, non-integer number rounded; shrinks files, drops float dust. */
function roundNumbers(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value)) return value;
    return Math.round(value * ROUND_FACTOR) / ROUND_FACTOR;
  }
  if (Array.isArray(value)) return value.map(roundNumbers);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = roundNumbers(entry);
    return out;
  }
  return value;
}

export function serialize(value: unknown, format: Format): string {
  const rounded = roundNumbers(value);
  return format === "toon" ? encode(rounded as any) : JSON.stringify(rounded, null, 2);
}

/** Parse a recording file body, auto-detecting JSON vs TOON. */
export function deserialize(body: string, hintExt?: string): unknown {
  const trimmed = body.trimStart();
  if (hintExt === ".toon") return decode(body);
  if (hintExt === ".json") return JSON.parse(body);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(body);
    } catch {
      return decode(body);
    }
  }
  return decode(body);
}

export function extFor(format: Format): string {
  return format === "toon" ? ".toon" : ".json";
}
