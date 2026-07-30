# Deep-log storage: node:sqlite at multi-GB scale

Not user documentation. Measured facts grounding the schema-6 event-log sidecar decision
(issue #173): node:sqlite vs streamed NDJSON as the store for the --deep/firefox event log at
the 4-10 GB scale the one-string JSON.stringify path cannot reach.

## Environment (honest)

- Node **v24.13.0** (wpd's target); `node:sqlite` embedded SQLite **3.50.4**; external
  `sqlite3` CLI **3.51.0**. macOS (Darwin, Apple Silicon), APFS SSD.
- `node:sqlite` needs **no flag** on this Node; it emits one `ExperimentalWarning` to stderr
  and works.
- Ambient CPU floor ~7-9 (the user's always-on `chrome-devtools-mcp` Chrome, idle). No other
  measurement contended during this run (gate held). CPU-contention noise affects tails, not
  medians; the write/drill **medians** are the signal. First-run (cold page cache) figures are
  shown separately where they differ.
- Page cache: warm. A cold `purge` needs sudo (unavailable), so drill numbers are **warm** and
  labelled so. sqlite cold-vs-warm shows only in the range query's first run (below).
- Disk was 99% full (12 GB free at start, ~20 GB after other agents finished). 4-10 GB test
  files were written one at a time and reclaimed immediately, so peak footprint stayed ~1 file.

## Synthetic events (shape-realistic, dense)

`{ id, name, kind, ts, dur, ph, pid, tid, at?, args }`, deterministic (seeded), byte-identical
across all three sinks. Mix and per-event NDJSON bytes:

| kind | share | avg bytes | note |
| --- | --- | --- | --- |
| invalidation | 15% | 4614 | nested cause stacks, KB-scale tail (~12% very deep) |
| layout / style | 14% each | 1205 | forced flush carrying a resolved `.stack` |
| scripting/task/other/composite/paint | ~55% | ~160 | tiny args |
| usertiming | 2% | 211 | markers |

**Average 1123.8 B/event.** This is a **dense, thrash-heavy** shape (heavier than a sparse
production journey, ~600 B/event in `trace-buffer.md`): invalidation records dominate the bytes.
Denser args stress both sinks with more TEXT, so the comparison is not tilted. Event counts:
4 GB = 3,821,705; 10 GB = 9,554,262.

---

## Q1 — Write throughput (4 GB, 3,821,705 events)

Batch-size sweep (sqlite, 500k events): **50,000 wins** at 162,578 rows/s; the spread is modest
(1k=137,925, 10k=136,635, 50k=162,578, 100k=155,213, 200k=146,993 rows/s). Used batch 50k.

| sink | wall | peak RSS | bytes | note |
| --- | --- | --- | --- | --- |
| sqlite (WAL, batched txns, +index) | **40.3 s** | **84 MB** | 4.0 GB | 26.5 s ingest + 13.8 s `CREATE INDEX (kind,ts)` |
| ndjson (streamed, backpressure) | **22.6 s** | 87 MB | 4,294,440,017 | |
| one-string `JSON.stringify` | — | 2584 MB | — | **`RangeError: Invalid string length`** at 800k events |

The one-string path throws the ~512 MB (`0x1fffffe8` char) ceiling at ~478k dense events — the
exact wall `trace-buffer.md` documents, and the reason this probe exists.

**Verdict: PASS.** sqlite ingest-only is **1.18x** NDJSON; sqlite full + queryable index is
**1.79x** NDJSON — both inside the ~2x budget. And sqlite streams: peak RSS **84 MB**
regardless of the 4 GB written (no single-string serialize, no whole-array-in-heap).

## Q2 — Drill latency (4 GB), median of 5 (sqlite) / 3 (ndjson), warm

| operation | sqlite | ndjson (full scan) | ratio |
| --- | --- | --- | --- |
| point (fetch one event by id) | **0.126 ms** | 2363.8 ms (worst 5229 ms near EOF) | ~18,000x |
| range (one kind in a ts window) | **45.6 ms** (11,348 rows) | 11,020.6 ms | ~240x |
| agg (count by kind, full log) | **180.9 ms** | 11,111 ms | ~61x |

Aggregation counts are **identical** on both sides (data verified equal). sqlite range first run
234 ms (cold index pages) then 30-60 ms warm. ndjson point latency scales with the id's file
position (672 ms early -> 5.2 s near EOF); sqlite point is position-independent.

## Q3 — Scale to 10 GB (9,554,262 events)

sqlite write **107.4 s** (61.6 s ingest + 45.8 s index), peak RSS **125 MB**. File
**10,110,369,792 bytes (9.42 GiB)** with index. Ingest held **155k rows/s** (no degradation from
4 GB). Drills at scale: point **0.308 ms** (vs 0.126 ms at 4 GB — B-tree log scaling), range
141.9 ms (28,815 rows), agg 463.8 ms.

**Nothing fell over.** No memory growth (statement re-prep is fine, RSS flat at 125 MB), WAL
stayed bounded (commit per 50k-row batch + a final `wal_checkpoint(TRUNCATE)`), no file-size
limit hit. A single giant transaction would have grown the WAL to full-DB size; per-batch
commits avoid that.

## Q4 — Interruption robustness (SIGKILL at 5 s mid-write)

| form | survives | keep-partial story |
| --- | --- | --- |
| sqlite | **800,000 rows** (every committed batch), `integrity_check` = **ok**, WAL intact, immediately queryable | transactional: durable up to the last COMMIT; the in-flight uncommitted batch drops cleanly at the boundary |
| ndjson (streamed) | **888,307 complete lines** flushed, ended on a newline this run | complete lines up to the cut; a mid-syscall kill can leave one trailing partial line the reader must trim |

**Footgun found (NDJSON, not sqlite):** a naive tight synchronous-loop writer with no
drain/yield buffers everything in userspace and loses **all** of it on SIGKILL — the file was
never even created. A real NDJSON writer must honor backpressure (yield to flush). sqlite has no
such trap: a committed transaction is durable by construction.

## Q5 — Size on disk (same events)

4 GB set (3,821,705 events):

| form | bytes | vs ndjson |
| --- | --- | --- |
| ndjson | 4,294,440,017 (4.00 GiB) | 1.00x |
| ndjson.gz (`gzip -6`, **28.6 s**) | 326,660,521 (311.5 MiB) | 0.076x (13.1x smaller) |
| sqlite (+ index) | ~4.0 GB | ~0.94x |

10 GB set: sqlite + index **10,110,369,792 B** vs ndjson-equivalent ~10.73 GB (derived from the
1123.8 B/event average) — sqlite is **~0.94x** NDJSON **while carrying a query index NDJSON
lacks**. (gzip's 13x is archival only; a `.gz` is not queryable. The synthetic strings are
repetitive URLs, so real-world gzip ratio will be lower.)

External **`sqlite3` CLI 3.51.0** (a different SQLite build than node's embedded 3.50.4) reads
the node:sqlite-written 10 GB file with no conversion: `GROUP BY`, point lookup,
`json_extract(args, '$.data...')`, and `.schema` all work. The file is a plain, portable,
tool-readable SQLite database with working JSON1 functions.

## Q6 — API maturity

- `DatabaseSync` (**synchronous only** — there is no async `Database` class), `StatementSync`
  with `.get` / `.all` / **`.iterate`** (a streaming row cursor — reads a huge table without
  materializing it). Also `Session` (changesets), `backup()`, `constants`. `{ readOnly: true }`
  open works.
- **No launch flag** required on Node 24.13; one `ExperimentalWarning` on stderr (suppress with
  `--no-warnings` / `--disable-warning=ExperimentalWarning`). Still tagged experimental, so the
  API can shift across Node majors — wpd pins Node 24, so acceptable; pin-and-watch the changelog.
- Embedded SQLite 3.50.4 with JSON1.
- **Footguns for the memo's consumers:** (1) the synchronous API **blocks the event loop** — a
  107 s bulk write or a 464 ms full-scan blocks everything on the thread. Fine for a CLI's
  dedicated serialize/query step; a server surface would need a worker thread. (2) `args` stays
  JSON **TEXT**, so blame filters either `json_extract` at scan time or need a hot field promoted
  to a real column / side index (e.g. `forced`, `at`) if they must be fast. (3) stderr warning
  noise. None are blockers for a record-then-query CLI.

---

## Facts-ledger-ready rows (load-bearing; dense ~1123 B/event shape unless noted)

- one-string `JSON.stringify` of the event log throws `RangeError: Invalid string length` at
  ~478k dense events / ~512 MB string (the schema 4/5 `--deep` ceiling).
- sqlite bulk ingest holds ~155-163k rows/s from 0.5 M to 9.55 M rows (no scale degradation);
  batch 50k is the tuning optimum.
- 4 GB write: sqlite 40.3 s (with index) / 26.5 s (ingest) vs NDJSON 22.6 s -> sqlite 1.18-1.79x
  NDJSON, inside the 2x budget.
- sqlite streaming write peak RSS 84 MB @4 GB, 125 MB @10 GB (flat; no whole-log-in-heap).
- point lookup by id: sqlite 0.126 ms @4 GB, 0.308 ms @10 GB; NDJSON full scan 0.67-5.2 s.
- range (kind+ts window): sqlite 45.6 ms @4 GB, 141.9 ms @10 GB; NDJSON 11.0 s.
- count-by-kind: sqlite 180.9 ms @4 GB, 463.8 ms @10 GB; NDJSON 11.1 s. Counts identical.
- 10 GB sqlite file with `(kind,ts)` index = 10,110,369,792 B (~0.94x the equivalent NDJSON).
- SIGKILL mid-write: sqlite keeps every committed batch, `integrity_check` ok, queryable; NDJSON
  keeps complete flushed lines (+ possible trailing partial to trim).
- `gzip -6` of 4 GB NDJSON: 28.6 s -> 311 MiB (archival only, not queryable).

## Recommendation

**sqlite store + JSON-at-the-verbs (+ optional NDJSON export).** The numbers force it:

1. It **removes the 512 MB ceiling** this probe was called to solve — no single-string
   serialize, flat ~85-125 MB RSS at any size.
2. Write cost is **within 1.8x** NDJSON (well under the 2x bar) **and** yields a queryable
   index NDJSON has no equivalent of.
3. Drill latency is **transformational** and lands exactly where wpd's design puts it: `query
   get <id>` becomes ~0.1-0.3 ms vs seconds; the "agents drill with `query spans`/`span`/`get`,
   never read the multi-MB recording" contract stops being aspirational at 10 GB.
4. Interruption gives a **stronger keep-partial** story (integrity-checked, exact transaction
   boundary, immediately queryable) than NDJSON's trim-the-last-line.
5. Size is **~0.94x** NDJSON with an index; the file is **portable and readable** by any SQLite
   tool with JSON1.

Ship-on caveats to carry into the design: the synchronous API blocks the event loop (fine for a
record/query CLI; isolate on a worker if ever embedded in a server); still Experimental (pin Node,
watch the changelog); keep `args` as JSON TEXT but promote/side-index the hot blame fields
(`forced`, `at`, `kind`, `ts`) that filters actually gate on. Keep an NDJSON (or speedscope-style)
export as a trivial `SELECT`-and-stringify for external-tool interop. `node:sqlite` did not
disappoint — it is the right store for the schema-6 event log.
