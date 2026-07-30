/**
 * What a forced-layout blame line names: "flush-site", the geometry READ that forced the pending
 * layout to flush synchronously, e.g. the `offsetHeight` access. Produced three ways, all the same
 * read-site semantic: Chrome `--deep` reads it exactly from the trace's `.stack` at the flush; Chrome
 * `--breakdown` samples it from the `v8.cpu_profiler` per-sample executing line over a layout/style
 * window (no `.stack`); Firefox/Gecko samples it from the DOM-accessor label frames (with the property
 * named). Comparable at line granularity (measured: 12/21 lines exact on the shared probe), with a
 * one-statement line-lag caveat on the sampled routes where a sub-interval read lands on the adjacent
 * statement.
 *
 * See docs/dev/blame-semantics.md
 */
export type BlameSemantic = "flush-site";

/**
 * The WRITE end of a forced flush: a DOM mutation that dirtied layout/style so a later geometry read
 * had to flush it synchronously. `at` is the mutation's source line.
 *
 * Both browser lanes reach it, by different routes (docs/dev/blame-semantics.md):
 *  - Chrome `--deep`: from the STYLE-kind invalidation records the trace's invalidationTracking
 *    carries, with the invalidation `reason` (e.g. "Inline CSS style declaration was mutated"). The
 *    layout-kind `LayoutInvalidationTracking` stack names the forcing READ on style-driven
 *    invalidations, not the write, so it is never a dirtied-by (measured). This is the FULL write set
 *    in a flush's gap, which is what lets the thrash detector run.
 *  - Firefox `--deep`: from a Gecko Reflow/Styles marker's cause stack (its innermost JS caller),
 *    with no `reason`. Gecko records only the FIRST invalidation since the last flush, so this is one
 *    write per flush, NOT the full set -- comparable at line granularity but never a thrash input
 */
export interface DirtiedByWrite {
  /** source line of the mutation (the write), relative to root */
  at: string;
  /** the Chrome invalidation reason string, when the record carried one (absent on firefox) */
  reason?: string;
}

/**
 * One step of the layout-thrashing interleave: a forced flush that re-read geometry an intervening
 * write had re-dirtied since the previous flush in the same task. `read` is the geometry read that
 * paid (the flush-site), `dirtiedBy` the mutation(s) that caused the re-dirty (the write end). A
 * layout-flush step can carry an empty `dirtiedBy`: it is a thrash step because a layout-kind write
 * sat in its gap, but that write's stack names the read, not a surfaceable write (see DirtiedByWrite)
 */
export interface ThrashStep {
  kind: "layout" | "style";
  read?: string;
  dirtiedBy: DirtiedByWrite[];
}

/**
 * The layout-thrashing detector's rollup over a window (Chrome `--deep` only). `count` is Σ thrash
 * steps -- forced flushes re-dirtied since the previous flush in the same top-level task, matched by
 * kind (a layout flush needs a layout write in its gap, a style flush a style write). `steps` is the
 * write->read interleave, capped for size; `omitted` counts thrash steps past the cap. Absent, never
 * a fabricated `count: 0`, on any lane that cannot observe it (the default/--breakdown capture modes drop the
 * invalidation records, Firefox has none)
 */
export interface ThrashReport {
  count: number;
  steps: ThrashStep[];
  omitted: number;
}

/** One write line Gecko blamed (firefox `--deep`), rolled up across the forced flushes that named it */
export interface DirtiedByWriteRollup {
  /** source line of the write (the cause stack's innermost JS caller), relative to root */
  at: string;
  /** which flush kinds this write dirtied (layout, style, or both) */
  kinds: ("layout" | "style")[];
  /** how many forced flushes named this write as their first-since-last-flush invalidation */
  count: number;
}

/**
 * The firefox `--deep` dirtied-by report: Gecko's native cause-stack write identity as a first-class
 * rollup. `semantic: "first-invalidation"` marks the honest scope -- Gecko records only the FIRST
 * invalidation since the last flush, so `writes` is the write Gecko blames, NOT chrome's full write
 * set. This is why the firefox lane runs no thrash detector and fabricates no forced-by read side
 * (the read stays the sampled read-site blame on the same gecko pass). See trace/firefox-dirtied.ts
 */
export interface FirefoxDirtiedByReport {
  semantic: "first-invalidation";
  writes: DirtiedByWriteRollup[];
}
