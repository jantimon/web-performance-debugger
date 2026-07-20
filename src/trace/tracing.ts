import type { CDPSession } from "puppeteer";

// Trace capture driven straight over CDP, so the buffer size and the data-loss signal are ours to
// set and read. Puppeteer's page.tracing hardcodes neither: it starts a trace with Chrome's default
// buffer (~275MB, ~485k events [measured]) and its stop() discards the tracingComplete event's
// dataLossOccurred flag. On a heavy --deep journey that combination drops events silently and
// mis-scopes the counts. See docs/dev/trace-buffer.md.

/**
 * A large offline-collection buffer, in KB. Chrome's default holds ~485k events (~275MB) [measured]
 * before it drops; a heavy --deep journey (`.stack` + `invalidationTracking`) outgrows that in a few
 * steps. 1 GB captures ~846k events (~475MB) with ZERO loss on the same probe, enough for a
 * multi-step production journey, and does not preallocate (the buffer fills only to what the trace
 * produces, so a light page pays nothing). Raising it further would let Chrome build a trace past the
 * ~512MB `parseTrace` can decode into one JS string, converting an honest overflow into a crash;
 * `stopTrace` guards that edge instead. See docs/dev/trace-buffer.md.
 */
const TRACE_BUFFER_SIZE_KB = 1_000_000;

// Node cannot hold a string longer than 0x1fffffe8 chars; the trace JSON is ASCII, so this is also
// the byte ceiling on a trace `parseTrace` (one TextDecoder().decode) can turn into text. A trace
// past it is unparseable, reported honestly rather than thrown as ERR_STRING_TOO_LONG.
const MAX_TRACE_STRING_BYTES = 0x1fffffe8;

/** The result of one trace: the decoded JSON text, plus Chrome's own data-loss verdict. */
export interface TraceResult {
  /** the trace JSON, ready for parseTrace; "[]" when the browser produced nothing or it was unparseable */
  text: string;
  /**
   * Chrome reported that trace events were dropped (the buffer filled and wrapped). The counts
   * derived from a lossy trace can undercount, so this drives a loud note, never a silent number.
   */
  dataLossOccurred: boolean;
  /**
   * The trace outgrew the ~512MB a single JS string can hold, so it could not be decoded for parsing
   * (`text` is the empty-trace sentinel `"[]"`, same as an empty run). A harder failure than
   * dataLoss: not one count is available. Drives a hard error.
   */
  tooLargeToParse?: boolean;
  /** bytes streamed from Chrome, for the too-large error message. */
  byteLength?: number;
}

/** Split puppeteer-style category filters ("-name" excludes) into CDP's included/excluded lists. */
function splitCategories(categories: string[]): {
  includedCategories: string[];
  excludedCategories: string[];
} {
  const includedCategories: string[] = [];
  const excludedCategories: string[] = [];
  for (const category of categories) {
    if (category.startsWith("-")) excludedCategories.push(category.slice(1));
    else includedCategories.push(category);
  }
  return { includedCategories, excludedCategories };
}

/**
 * Start tracing on `client` with the given categories, on a raised buffer (`TRACE_BUFFER_SIZE_KB`).
 *
 * `recordMode: "recordAsMuchAsPossible"` names the intent (collect the whole run, do not stop at
 * full); the buffer SIZE is what actually raises the ceiling. `traceBufferSizeInKb` is the load-bearing
 * knob: recordMode alone leaves the ceiling at Chrome's ~485k-event default [measured], where a heavy
 * journey silently drops events.
 */
export async function startTrace(client: CDPSession, categories: string[]): Promise<void> {
  const { includedCategories, excludedCategories } = splitCategories(categories);
  await client.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: {
      recordMode: "recordAsMuchAsPossible",
      traceBufferSizeInKb: TRACE_BUFFER_SIZE_KB,
      includedCategories,
      excludedCategories,
    },
  });
}

/** Read a CDP IO stream to completion, decoding base64 chunks, and close it. */
async function readStream(client: CDPSession, handle: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { data, base64Encoded, eof } = (await client.send("IO.read", {
        handle,
        size: 1 << 20,
      })) as { data: string; base64Encoded?: boolean; eof: boolean };
      // Buffer.from(string, encoding) already allocates a fresh Uint8Array we own; keep it as-is
      // (a Buffer IS a Uint8Array) rather than copying it a second time through Uint8Array.from.
      chunks.push(Buffer.from(data, base64Encoded ? "base64" : "utf8"));
      if (eof) break;
    }
  } finally {
    // Close the stream even if a read rejects, so the handle is not leaked before browser.close().
    await client.send("IO.close", { handle }).catch(() => {});
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/**
 * Stop tracing on `client` and return the decoded trace plus its data-loss verdict. Registers the
 * `Tracing.tracingComplete` listener BEFORE `Tracing.end` so the event (which carries both the stream
 * handle and `dataLossOccurred`) is never missed. A trace past the JS-string ceiling is reported as
 * `tooLargeToParse` rather than decoded (which would throw ERR_STRING_TOO_LONG).
 */
export async function stopTrace(client: CDPSession): Promise<TraceResult> {
  const complete = new Promise<{ stream?: string; dataLossOccurred: boolean }>((resolve) => {
    client.once("Tracing.tracingComplete", (event) =>
      resolve(event as { stream?: string; dataLossOccurred: boolean }),
    );
  });
  await client.send("Tracing.end");
  const { stream, dataLossOccurred } = await complete;
  if (!stream) return { text: "[]", dataLossOccurred };
  const bytes = await readStream(client, stream);
  if (bytes.length >= MAX_TRACE_STRING_BYTES)
    return { text: "[]", dataLossOccurred, tooLargeToParse: true, byteLength: bytes.length };
  return { text: new TextDecoder("utf-8").decode(bytes), dataLossOccurred };
}
