# Driving wpd from an agent

For an agent or script consuming `wpd`. `wpd` finds and investigates; it does not grade, rank, or
recommend. It hands you typed, provenance-stamped numbers and a clean exit code. Synthesis and
judgment stay with you. This is the operating contract; the [README](README.md) holds the depth.

## The loop

1. **Record.** `wpd record <module> [flags]` writes a recording plus siblings. One `record` is exactly
   one capture pass.
2. **Query.** Read the recording with the `query` verbs. **Never read the recording file directly** --
   it can be many MB. Drill instead:

```
query spans <file>              # overview: one row per span, one shape across chrome/firefox/node
  -> query span <file> <kind:label>   # one span's full anatomy
       -> query get <file> <id>       # one raw event (stack + args); needs --deep or firefox
```

- Every verb accepts `latest` in place of `<file>` (a cwd-keyed pointer, never resolved by mtime).
- Span identity is **kind + label**. A bare label that matches more than one kind is a collision;
  qualify it (`run`, `step:first increment`, `measure:hydrate`).
- `query spans --label X` with no match is a **filter**: it discloses the empty result and exits 0.
  `query span X` with no match is a **lookup**: it exits 1. Pick the verb for the branch you want.
- Other verbs: `query cpu` (hot functions + rollup), `query frame <id>` (one function's callers and
  callees), `query blame --forced` (forced-layout read sites), `query events` (the raw log).

## Output format

- **Always pass `--format json` or `--format toon`.** Both are plain: no ANSI, regardless of TTY. TOON
  is compact and token-efficient; JSON is the same shape.
- Structured output never colorizes, so you do not need `--color never`.
- The view shapes are typed and exported from the package root (`SpansResult`, `SpanAnatomy`,
  `CpuOverview`, `BlameEntry`, `CpuDiffResult`, ...). Import them; do not hand-roll the shape.

## Field names that are not the obvious ones (schema 5)

- A function's display name is **`fn`**, not `name` (`CpuOverview.hot[].fn`, `CpuFunctionDelta.fn`).
  Its self time is `selfMs`/`selfPct`; its source is `source` (`file:line`) and `file`.
- The JS headline is **`jsSelfMs`**. `activeMs` is the larger non-idle total (js + gc + engine) -- do
  **not** denominate a package share on it.
- The per-package split is **`byPackage[]`**, rows of `{ key, selfMs, selfPct, functions }`.
- **`siteRelation`** (`same-origin` | `same-site` | `cross-site`) appears only on an origin-bucket key
  (`(cdn.example.com)`) of a `--url` run. It is a URL-mechanical fact, never an ownership or
  "third-party" claim.
- A span's headline wall is **`wallMs`**, on the clock **`wallClock`** names (`"trace"` or `"page"`).
  On a step span the bar tiles iteration 0 under **`windowMs`**, which can differ from the median
  `wallMs`.
- Per-span slices are one **`UnifiedSlices`** shape (`js.byPackage`, `style`, `layout`, `paint`, `gc`,
  `other`, `idle`) across every target.
- **`meta.capture`** is a scalar naming the one capture mode: `"default"` | `"breakdown"` | `"deep"` |
  `"gecko"` | `"gecko-deep"` | `"node-cpu"` | `"node-alloc"`. (There is no `meta.passes` array.)
- **`aggregation`** on a span says what its numbers mean: `"sum"` (run span, total across iterations),
  `"first"` (a step or unrepeated measure, one iteration), `"median"` (a repeated measure, with
  `samples`/`wallMinMs`/`wallMaxMs`). Read it before comparing two spans.
- **`engineSoftNav`** is present on a driver step only where the engine's own soft-navigation API fired
  (Chrome 151+); absent means "the engine emitted none or lacks support", not "no navigation".

## Null vs 0, and n/a-FAIL: never fabricate

Every count and slice a capture mode could not observe is an explicit **`null`** (not-measured), never
`0` (which reads as "measured clean"). Read it as "wpd did not measure this here", and do not coerce it
to 0 as if it were a signal.

- A gate on a metric the capture did not measure is a **loud `n/a` FAIL**, never a silent pass:
  `assert --max-forced 0` on a `--breakdown` recording FAILs, because forced counts need `--deep`.
- When you normalize across recordings of different capture modes, read `slice?.ms ?? 0` at the
  read site -- do not treat null-vs-0 as a per-target signal (the same target reports `paint` as
  `null` on a run-only recording and a measured `0` once a stored breakdown exists).

## Exit codes and refusals: treat the refusal as the answer

- **A failed gate exits non-zero.** `assert` with a blown budget, `diff`/`cpu-diff` with
  `--fail-on-regression` on a real regression: exit code 1. A clean run exits 0. Gate on the exit code.
- **wpd refuses rather than fabricate.** `diff`/`cpu-diff` across an incompatible pair (a different
  browser, runtime, capture mode, workload, `--iterations`, `--warmup`, headless flavour, or
  `--cpu-throttle`) names the mismatch and **declines to gate** instead of inventing a regression. The
  refusal text is the answer -- do not retry to force a number.
- The **workload** is the executed flow (lane + host page + module), not just the target string, so a
  different module against the same host is a different workload and refuses.

## Bot-wall refusal

When `record --url` navigates onto a bot-challenge interstitial (Cloudflare, DataDome, and the like),
`wpd` **refuses and writes a screenshot** rather than measure the challenge page as if it were the
site. `wpd` never bypasses, waits out, or solves a challenge.

- To measure the challenge page **on purpose**, pass `--allow-bot-wall`. The recording then carries a
  loud note that the numbers describe the challenge page, not the site, and a `query cpu` origin bucket
  naming the challenge vendor confirms which wall it was.

## Where to read more

- Capture modes and what each yields: [README, Choose a capture](README.md#choose-a-capture-what-you-want-to-know).
- The full JSON type table: [README, Consuming the JSON](README.md#consuming-the-json).
- The query verbs: [README, The query verbs](README.md#the-query-verbs).
- Trust tiers (which numbers are exact, which directional): [README, The numbers](README.md#the-numbers-and-how-far-to-trust-them)
  and [docs/verification.md](docs/verification.md).
- The scope boundary (what wpd leaves to you): [docs/dev/orchestrator-boundary.md](docs/dev/orchestrator-boundary.md).
