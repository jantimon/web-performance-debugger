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

The trace size at which the stored log fails DEPENDS on forced-layout density: a forced flush keeps a
resolved `.stack` plus an `invalidationTracking` record, so a dense thrash log expands more per trace
byte than a sparse one. [measured] the densest shape (the forced-layout thrash loop, ~28% of events
forced) serializes a **189.8 MB** trace to a **510.5 MB** string (just under the ceiling) and throws by
**~197 MB**; a sparser production journey holds a larger trace (~271 MB above) before failing. So the
trace-bytes failure point is a band (~190 MB densest, ~271 MB+ sparse), not a single number.

`--breakdown` stores **no** event log, so its recording stays digest-sized regardless of trace size:
[measured] a `--breakdown` run captured and completed a **624 MB** trace (~2.41M events) end-to-end,
counts intact, and the recording read back. So a trace past 512 MB parses and records fully on any
capture mode that does not store the event log; only `--deep`/firefox blame is bounded by the event
log's own serialization limit.

## The `--deep` preflight: refuse before the parse can OOM

`stopTrace` knows the raw trace byte size the moment the stream completes, before any parse. A `--deep`
trace heavy enough to store an unserializable event log ALSO parses into an event array large enough to
exhaust the default heap: at Node's default old space a heavy `--deep` journey crashes with a raw
`FATAL ERROR: JavaScript heap out of memory` during the parse, with no wpd message, and every failed
attempt costs a full live journey plus a long parse. So `runPass` runs a preflight the moment the
stream completes: for a capture mode that stores the full trace event log (`storesFullTraceEventLog`,
chrome `--deep` only), a raw trace over **180MB** (`DEEP_EVENT_LOG_TRACE_BYTE_CEILING`) is refused
immediately with the same named guidance the serialize path gives, so the parse never runs.

The 180MB floor sits below the densest measured failure (~190 MB) with headroom, so it never lets a
serialize-failing `--deep` through, and never lets a heavier trace reach the parse OOM. It is a floor,
not the exact failure point: a sparse journey whose trace is 180-271MB would have serialized, and is
refused early with the actionable remedy rather than risked. `--breakdown` (which stores no event log)
is not gated and parses past the ceiling by design. `writeRecording` keeps the serialize-time guard as
the backstop for a trace that slips under the floor but still overruns the string limit.

The ultimate ceiling is process heap: a multi-GB trace's parsed event array can exhaust old space and
OOM. That is a raw crash the tool cannot cheaply intercept; keep the buffer sized to real journeys.

## The two honest signals

- **`dataLossOccurred`** (buffer overran even at 4 GB): the trace parses, but its counts undercount.
  `record` pushes `notesCatalog.traceDataLoss()` and prints it to stderr, and a lost `wpd:step`
  marker becomes the hard `mergeSteps` divergence error, whose message names the overflow outright
  when `traceDataLoss` is set.
- **Event-log serialization overflow** (a `--deep`/firefox stored event log past the ~512 MB JSON
  string limit): the `--deep` preflight refuses at capture time above the 180MB trace floor, and
  `writeRecording` throws the same named hard error as a backstop. Reduce the measured work (fewer
  steps per run, fewer `--iterations` — every iteration is traced, so the stored log scales with the
  count — or scope the flow), or use `--breakdown` (a lighter trace, no `.stack`/`invalidationTracking`,
  no stored event log) if forced-layout blame is not needed. Scoping `--deep` down by changing
  `--iterations` means it can no longer join a run group with the other members: the comparability gate
  refuses a differing `--iterations` (counts total across iterations), so a rescoped `--deep` is
  recorded standalone.

## CDP trace capture deadlocks under the Chrome sandbox on the Linux CI runners

**[measured]** On the GitHub-hosted Linux runners, full Chrome's sandbox deadlocks with CDP trace
capture: a record that starts a trace never returns, while a sandboxed record that captures no trace
completes normally, and the same trace-mode record completes once the sandbox is off.

| record | sandbox | result |
| --- | --- | --- |
| default (no trace) | on | completes |
| `--breakdown` (light trace) | on | **hangs** |
| `--deep` (full trace) | on | **hangs** |
| `--breakdown` / `--deep` (trace) | off | completes |

So the trigger is the pair, not either alone: the sandbox is fine without a trace, and trace capture is
fine without the sandbox. The fix is the documented CI escape, `--disable-browser-sandbox` (or
`WPD_DISABLE_BROWSER_SANDBOX=1` reaching every `record` child), which is why `.github/workflows/ci.yml`
runs the e2e suite with it set. Local macOS runs keep the sandbox on (they do not hit the deadlock), so
this is a Linux-CI constraint, not a change to wpd's sandboxed-by-default launch
([orchestrator-boundary.md](./orchestrator-boundary.md#why-each-evaluated-surface-stands-where-it-does)).
The node lane ignores the flag (it launches no browser). A trace child wedged this way is what the
e2e harness's OS-level child kill and the job `timeout-minutes` exist to catch.
