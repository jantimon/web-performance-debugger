# The trace buffer: what raises the ceiling, what drops events, and the parse limit

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

## The real hard ceiling is the parser, not the buffer

`parseTrace` decodes the whole trace into one JS string, and Node cannot hold a string longer than
`0x1fffffe8` (~512 MB) chars; the trace JSON is ASCII, so that is also the byte ceiling. A trace past
it throws `ERR_STRING_TOO_LONG` on decode. So raising the buffer without bound would convert an honest
overflow (dropped events, a loud note) into a crash on a bigger page.

wpd therefore sets `traceBufferSizeInKb` to **1 GB** (`TRACE_BUFFER_SIZE_KB`): it captured the full
~846k-event probe with zero loss where the default dropped ~360k, which is enough headroom for a
multi-step production journey, and its ~475 MB output stays under the parse ceiling. `stopTrace`
guards the residual edge: a trace at or above the string limit is returned as `tooLargeToParse` (never
decoded), and `runpass` turns that into a hard error naming the size and the remedy, rather than
throwing a raw `ERR_STRING_TOO_LONG`.

## The two honest signals

- **`dataLossOccurred`** (buffer overran even at 1 GB): the trace parses, but its counts undercount.
  `record` pushes `notesCatalog.traceDataLoss()` and prints it to stderr, and a lost `wpd:step`
  marker becomes the hard `mergeSteps` divergence error, whose message names the overflow outright
  when `traceDataLoss` is set.
- **`tooLargeToParse`** (trace past the ~512 MB string limit): no count is available at all; `runpass`
  throws a hard error. Reduce the measured work (fewer steps per run, or scope the flow), or use
  `--breakdown` (a lighter trace, no `.stack`/`invalidationTracking`) if forced-layout blame is not
  needed.
