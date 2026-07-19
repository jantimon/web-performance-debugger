import type {
  DirtiedByWriteRollup,
  FirefoxDirtiedByReport,
  NormalizedEvent,
} from "../model/recording.js";

/**
 * The firefox `--deep` dirtied-by rollup: Gecko's native cause-stack write identity, surfaced as a
 * first-class report.
 *
 * The mechanism is entirely Gecko's, and its scope is the honest limit of this lane. A Reflow/Styles
 * marker's cause stack names the WRITE that dirtied the DOM (`event.dirtiedBy`, resolved from the
 * cause stack's innermost JS caller), but Gecko records only the FIRST invalidation since the last
 * flush -- so this is the write Gecko blames, NOT chrome's full write set. That is why this lane can
 * never run the thrash detector (it needs every write in a flush's gap) and never fabricates a
 * forced-by read side (the read stays where it lives: the sampled read-site blame events on the same
 * gecko pass). The `semantic` field carries that scope into the JSON so a consumer cannot mistake it
 * for chrome's exact set.
 */
const FIRST_INVALIDATION_SEMANTIC = "first-invalidation" as const;

/**
 * Roll up the Gecko cause-stack write lines from the forced Reflow/Styles marker events. Only the
 * marker (non-sampled) events carry `dirtiedBy`; the sampled read-site events carry the READ line and
 * are deliberately excluded here so write and read never merge. `start` windows to the run (null =
 * whole log). Returns null when no forced flush carried a resolvable cause -- "not available", never
 * an empty-but-present report.
 */
export function firefoxDirtiedBy(
  events: NormalizedEvent[],
  start: number | null,
): FirefoxDirtiedByReport | null {
  const groups = new Map<string, DirtiedByWriteRollup>();
  for (const event of events) {
    if (event.sampled || !event.dirtiedBy) continue;
    if (start != null && event.ts < start) continue;
    const kind = event.kind === "style" ? "style" : "layout";
    const group = groups.get(event.dirtiedBy.at) ?? {
      at: event.dirtiedBy.at,
      kinds: [],
      count: 0,
    };
    group.count++;
    if (!group.kinds.includes(kind)) group.kinds.push(kind);
    groups.set(event.dirtiedBy.at, group);
  }
  const writes = [...groups.values()].sort((left, right) => right.count - left.count);
  return writes.length ? { semantic: FIRST_INVALIDATION_SEMANTIC, writes } : null;
}
