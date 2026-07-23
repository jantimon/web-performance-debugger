# The trace buffer: what raises the ceiling, what drops events, and the incremental parser

Read this before changing `trace/tracing.ts` (`startTrace`/`stopTrace`), the trace buffer size, or
before claiming a `--deep` count is exact on a heavy page.

`--deep` captures the full trace (`.stack` + `invalidationTracking`), the two heaviest categories. On
a large production page a multi-step journey produces enough events to overrun the trace buffer;
dropped events silently turn an "exact" count into a wrong one. wpd drives Tracing over CDP itself
(not Puppeteer's `page.tracing`) for two reasons the probes below establish: to raise the buffer, and
to read Chrome's `dataLossOccurred` verdict that `page.tracing.stop()` discards.

Probes are **[measured]** with Puppeteer's bundled Chrome, headless-shell, on a synthetic
forced-layout thrash loop (`div.offsetWidth` + `body.offsetHeight` reads around style writes, N
iterations), tracing the full `--deep` category set over raw CDP `Tracing.start`/`Tracing.end`.

## `recordMode` does not raise the ceiling; `traceBufferSizeInKb` does

At the same load, `recordUntilFull` and `recordAsMuchAsPossible` behave identically, and Puppeteer's
default `page.tracing.start` (no explicit config) matches both:

| config | events captured | trace size | `dataLossOccurred` |
| --- | --- | --- | --- |
| `recordUntilFull`, default buffer | ~485k | ~275 MB | **true** |
| `recordAsMuchAsPossible`, default buffer | ~485k | ~275 MB | **true** |
| `page.tracing.start` (Puppeteer default) | ~486k | ~275 MB | discarded (unknown) |

So the record MODE is not the lever: all three cap at Chrome's ~485k-event / ~275MB default and drop
past it. Raising `traceBufferSizeInKb` is what moves the ceiling. The full 60k-iteration workload is
~846k events (~475 MB); the default buffer keeps only ~485k of them, dropping ~360k:

| `traceBufferSizeInKb` | events captured | trace size | `dataLossOccurred` |
| --- | --- | --- | --- |
| default | ~485k | ~275 MB | **true** (~360k dropped) |
| 1,000,000 (1 GB) | ~846k (all) | ~475 MB | false |
| 2,000,000 (2 GB) | ~846k (all) | ~480 MB | false |
| 4,000,000 (4 GB), 150k-iteration load | ~2.1M | ~1.2 GB | false |

The buffer is not preallocated: it fills only to what the trace produces, so a light page pays
nothing for a large `traceBufferSizeInKb`. A 4 GB buffer capturing 1.2 GB did **not** hang (it
completed in ~78 s). So neither "a bigger buffer buys nothing" nor "a multi-GB value hangs" holds.

wpd sets `traceBufferSizeInKb` to **4 GB** (`TRACE_BUFFER_SIZE_KB`): it is the largest buffer with a
measured no-loss, no-hang row above, and the parser no longer caps how large a trace may grow (below),
so the buffer's job is purely to avoid dropped events. [measured] a `--deep --bench` thrash run
captured a **1.09 GB** trace (~1.69M events) at this buffer with `dataLossOccurred` false.

## The parser is incremental: no single-string ceiling

Node cannot hold a string longer than `0x1fffffe8` (~512 MB) chars, so decoding a whole >512 MB trace
into one string throws `ERR_STRING_TOO_LONG`. `parseTrace` never builds that string: `stopTrace`
returns the raw stream bytes as one `Uint8Array` (which has no ~512 MB limit), and `scanTraceEvents`
(`trace/scan.ts`) walks those bytes, isolates each top-level `traceEvents` element by tracking
JSON string/brace/bracket state, and `JSON.parse`s that one small slice. The giant string never
exists, and peak heap tracks the events a consumer keeps, not the whole raw array (a `--deep` run
scans once for the event pipeline; `--breakdown` scans a second time for the CPU stream, a lighter
trace). [measured] the 1.09 GB / 1.69M-event trace parsed in **~5.9 s** at ~3.9 GB RSS (peak ~7 GB).

## The remaining ceiling: the --deep recording serializes to one string

A `--deep`/firefox recording stores the **full event log** (every trace event, `.stack` and
invalidation `args` kept for blame), and `writeRecording` serializes the whole recording with one
`JSON.stringify`, which hits the same ~512 MB string limit the parser dodges. Because the stored event
log is almost the whole trace and pretty-printing (`indent 2`) roughly doubles its deeply-nested
`args`, this bites BELOW the trace size: [measured] a ~271 MB trace (~422k events, ~256 MB compact
event log) already fails to serialize. `writeRecording` catches the `RangeError` and throws a NAMED
error (the event count, the ~512 MB limit, the remedy) rather than a bare `Invalid string length`. The
read path shares the ceiling (a recording file is read whole into a string before `JSON.parse`), so
the honest `--deep` end-to-end limit is a stored event log under ~512 MB of JSON, not the trace size.

`--breakdown` stores **no** event log, so its recording stays digest-sized regardless of trace size:
[measured] a `--breakdown` run captured and completed a **624 MB** trace (~2.41M events) end-to-end,
counts intact, and the recording read back. So a trace past 512 MB parses and records fully on any
capture mode that does not store the event log; only `--deep`/firefox blame is bounded by the event
log's own serialization limit.

The ultimate ceiling is process heap: a multi-GB trace's parsed event array can exhaust old space and
OOM. That is a raw crash the tool cannot cheaply intercept; keep the buffer sized to real journeys.

## The two honest signals

- **`dataLossOccurred`** (buffer overran even at 4 GB): the trace parses, but its counts undercount.
  `record` pushes `notesCatalog.traceDataLoss()` and prints it to stderr, and a lost `wpd:step`
  marker becomes the hard `mergeSteps` divergence error, whose message names the overflow outright
  when `traceDataLoss` is set.
- **Event-log serialization overflow** (a `--deep`/firefox stored event log past the ~512 MB JSON
  string limit): `writeRecording` throws a named hard error. Reduce the measured work (fewer steps per
  run, or scope the flow), or use `--breakdown` (a lighter trace, no `.stack`/`invalidationTracking`,
  no stored event log) if forced-layout blame is not needed.
