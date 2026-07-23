// Incremental, event-at-a-time trace parser. A heavy --deep journey serializes to a trace larger than
// 0x1fffffe8 (~512MB), the longest string Node can hold; JSON.parse over the whole trace text is then
// impossible. This scanner walks the raw UTF-8 bytes (a Uint8Array, which has no 512MB limit), isolates
// each top-level element of the `traceEvents` array, and JSON.parse's that one small slice: the giant
// string never exists, and peak heap tracks the events a consumer keeps, not the whole raw array. See
// docs/dev/trace-buffer.md.

const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \
const COMMA = 0x2c; // ,
const COLON = 0x3a; // :
const OPEN_BRACE = 0x7b; // {
const CLOSE_BRACE = 0x7d; // }
const OPEN_BRACKET = 0x5b; // [
const CLOSE_BRACKET = 0x5d; // ]

function isWhitespace(byte: number): boolean {
  return byte === SPACE || byte === TAB || byte === LINE_FEED || byte === CARRIAGE_RETURN;
}

/** First non-whitespace offset at or after `start`; `bytes.length` if none remains. */
function skipWhitespace(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length && isWhitespace(bytes[offset])) offset++;
  return offset;
}

/**
 * End offset (exclusive) of the JSON string that opens at `start` (a `"`). Skips the byte after every
 * backslash, which handles `\"`, `\\`, and `\uXXXX` (the `u` and its four hex digits are ordinary bytes
 * that carry no structural meaning, so only the escaped char immediately after `\` must be stepped over).
 */
function scanString(bytes: Uint8Array, start: number): number {
  let offset = start + 1;
  while (offset < bytes.length) {
    const byte = bytes[offset];
    if (byte === BACKSLASH) {
      offset += 2;
      continue;
    }
    if (byte === QUOTE) return offset + 1;
    offset++;
  }
  return bytes.length;
}

/**
 * End offset (exclusive) of the one JSON value that begins at `start` (assumed to be the value's first
 * non-whitespace byte). Objects and arrays are walked with a string-aware depth counter so a brace,
 * bracket, or comma inside a string never miscounts; primitives run to the next structural byte.
 */
function scanValue(bytes: Uint8Array, start: number): number {
  const first = bytes[start];
  if (first === QUOTE) return scanString(bytes, start);
  if (first === OPEN_BRACE || first === OPEN_BRACKET) {
    let depth = 0;
    let inString = false;
    for (let offset = start; offset < bytes.length; offset++) {
      const byte = bytes[offset];
      if (inString) {
        if (byte === BACKSLASH) offset++;
        else if (byte === QUOTE) inString = false;
        continue;
      }
      if (byte === QUOTE) inString = true;
      else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++;
      else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        depth--;
        if (depth === 0) return offset + 1;
      }
    }
    return bytes.length;
  }
  // A primitive (number / true / false / null) ends at the next structural byte or whitespace.
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset];
    if (byte === COMMA || byte === CLOSE_BRACKET || byte === CLOSE_BRACE || isWhitespace(byte))
      break;
    offset++;
  }
  return offset;
}

/** Yield each element of the array whose `[` sits at `arrayOpen`, JSON.parsing one small slice each. */
function* scanArrayElements<Element>(
  bytes: Uint8Array,
  arrayOpen: number,
  decoder: TextDecoder,
): Generator<Element> {
  let offset = skipWhitespace(bytes, arrayOpen + 1);
  if (bytes[offset] === CLOSE_BRACKET) return; // empty array
  for (;;) {
    const elementStart = offset;
    const elementEnd = scanValue(bytes, elementStart);
    yield JSON.parse(decoder.decode(bytes.subarray(elementStart, elementEnd))) as Element;
    offset = skipWhitespace(bytes, elementEnd);
    const byte = bytes[offset];
    if (byte === COMMA) {
      offset = skipWhitespace(bytes, offset + 1);
      continue;
    }
    if (byte === CLOSE_BRACKET) return;
    throw new Error("malformed traceEvents array: expected ',' or ']'");
  }
}

/**
 * Walk raw trace bytes and yield each `traceEvents` element as its own parsed object, one at a time.
 *
 * Both envelope shapes Chrome emits are handled: a bare top-level array `[...]`, and the object
 * `{"traceEvents":[...], ...otherFields}`. Top-level metadata fields (`metadata`, etc.) are skipped
 * without being parsed; no consumer reads them today, and stopping the walk once `traceEvents` is
 * yielded keeps a trailing metadata blob off the heap.
 *
 * The bytes are held as one Uint8Array (concatenated from the CDP stream chunks). A Uint8Array has no
 * 512MB ceiling, so keeping the whole buffer and scanning byte offsets over it is simpler and correct
 * where carrying scanner state across raw chunk boundaries would not be: each element is decoded from a
 * complete, self-contained byte slice, so no boundary can split a token.
 */
export function* scanTraceEvents<Element = unknown>(bytes: Uint8Array): Generator<Element> {
  const decoder = new TextDecoder("utf-8");
  let offset = skipWhitespace(bytes, 0);
  if (offset >= bytes.length) return; // empty input: no events
  const opener = bytes[offset];
  if (opener === OPEN_BRACKET) {
    yield* scanArrayElements<Element>(bytes, offset, decoder);
    return;
  }
  if (opener !== OPEN_BRACE) throw new Error("trace JSON is neither an object nor an array");
  offset = skipWhitespace(bytes, offset + 1);
  if (bytes[offset] === CLOSE_BRACE) return; // empty object: no traceEvents
  for (;;) {
    if (bytes[offset] !== QUOTE) throw new Error("expected a string key in the trace envelope");
    const keyEnd = scanString(bytes, offset);
    const key = JSON.parse(decoder.decode(bytes.subarray(offset, keyEnd))) as string;
    offset = skipWhitespace(bytes, keyEnd);
    if (bytes[offset] !== COLON) throw new Error("expected ':' after a trace envelope key");
    offset = skipWhitespace(bytes, offset + 1);
    if (key === "traceEvents") {
      if (bytes[offset] !== OPEN_BRACKET) throw new Error("traceEvents is not an array");
      yield* scanArrayElements<Element>(bytes, offset, decoder);
      return; // every other top-level field is metadata no consumer reads
    }
    offset = skipWhitespace(bytes, scanValue(bytes, offset));
    const byte = bytes[offset];
    if (byte === COMMA) {
      offset = skipWhitespace(bytes, offset + 1);
      continue;
    }
    if (byte === CLOSE_BRACE) return; // envelope ended without a traceEvents field
    throw new Error("malformed trace envelope: expected ',' or '}'");
  }
}

/**
 * Normalize any trace representation to an iterable of raw events, so a consumer loops one way over raw
 * bytes (parsed incrementally via `scanTraceEvents`), a JSON string, a parsed `{traceEvents}` envelope /
 * bare array, or a live generator. Raw `Uint8Array` bytes are the record-time path: they alone dodge the
 * ~512MB single-string ceiling. A generator is consumed once; a fresh call is needed per pass.
 */
export function toRawTraceEvents<Element>(
  trace: string | Uint8Array | { traceEvents?: Element[] } | Iterable<Element>,
): Iterable<Element> {
  // Uint8Array is itself iterable (over bytes), so it must be routed to the scanner before the generic
  // iterable branch below, which would otherwise walk it as numbers.
  if (trace instanceof Uint8Array) return scanTraceEvents<Element>(trace);
  const parsed = typeof trace === "string" ? JSON.parse(trace) : trace;
  if (parsed == null) return [];
  if (typeof (parsed as Iterable<Element>)[Symbol.iterator] === "function")
    return parsed as Iterable<Element>;
  return (parsed as { traceEvents?: Element[] }).traceEvents ?? [];
}
