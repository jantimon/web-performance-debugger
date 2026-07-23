import type { CDPSession } from "puppeteer";

// Trace capture driven straight over CDP, so the buffer size and the data-loss signal are ours to
// set and read. Puppeteer's page.tracing hardcodes neither: it starts a trace with Chrome's default
// buffer (~275MB, ~485k events [measured]) and its stop() discards the tracingComplete event's
// dataLossOccurred flag. On a heavy --deep journey that combination drops events silently and
// mis-scopes the counts. See docs/dev/trace-buffer.md.

/**
 * A large offline-collection buffer, in KB. Chrome's default holds ~485k events (~275MB) [measured]
 * before it drops; a heavy --deep journey (`.stack` + `invalidationTracking`) outgrows that in a few
 * steps. 4 GB captures ~2.1M events (~1.2GB) with ZERO loss [measured], enough for a multi-step
 * production journey, and does not preallocate (the buffer fills only to what the trace produces, so a
 * light page pays nothing). `scanTraceEvents` parses the streamed bytes one event at a time, so the
 * former ~512MB single-string parse ceiling no longer bounds this value. See docs/dev/trace-buffer.md.
 */
const TRACE_BUFFER_SIZE_KB = 4_000_000;

/** The result of one trace: the raw JSON bytes, plus Chrome's own data-loss verdict. */
export interface TraceResult {
  /**
   * The trace JSON as UTF-8 bytes, ready for `scanTraceEvents`. A Uint8Array has no ~512MB ceiling (a
   * JS string does), so a heavy --deep trace is held whole and parsed incrementally. `[]` bytes when
   * the browser produced no stream.
   */
  bytes: Uint8Array;
  /**
   * Chrome reported that trace events were dropped (the buffer filled and wrapped). The counts
   * derived from a lossy trace can undercount, so this drives a loud note, never a silent number.
   */
  dataLossOccurred: boolean;
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
 * Stop tracing on `client` and return the raw trace bytes plus its data-loss verdict. Registers the
 * `Tracing.tracingComplete` listener BEFORE `Tracing.end` so the event (which carries both the stream
 * handle and `dataLossOccurred`) is never missed. The bytes are returned undecoded: `scanTraceEvents`
 * parses them one event at a time, so a trace past the ~512MB single-string ceiling still parses.
 */
export async function stopTrace(client: CDPSession): Promise<TraceResult> {
  const complete = new Promise<{ stream?: string; dataLossOccurred: boolean }>((resolve) => {
    client.once("Tracing.tracingComplete", (event) =>
      resolve(event as { stream?: string; dataLossOccurred: boolean }),
    );
  });
  await client.send("Tracing.end");
  const { stream, dataLossOccurred } = await complete;
  if (!stream) return { bytes: new TextEncoder().encode("[]"), dataLossOccurred };
  const bytes = await readStream(client, stream);
  return { bytes, dataLossOccurred };
}
