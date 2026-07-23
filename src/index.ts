// Public, semver-covered API for `@jantimon/web-performance-debugger`. This module is the
// only stable surface: the types here describe every JSON artifact the CLI writes and every
// `--format json|toon` verb output, so consumers can type their parsing without inspecting
// sample output. Anything else under dist/ is internal and may change without a major bump.

/** Schema epoch (major-only), independent of the package version. Stamped into every
 * artifact as `meta.schemaVersion`. */
export { SCHEMA_VERSION } from "./schema.js";

// On-disk artifact shapes (recording / spans / cpu model).
export type {
  EventKind,
  StackFrame,
  NormalizedEvent,
  InvalidationRecord,
  TimingEntry,
  BenchStats,
  InteractionTiming,
  LoafScript,
  LoafFrame,
  StepLoaf,
  StepTiming,
  RecordingSummary,
  RecordingWindow,
  BlameSemantic,
  RecordingMeta,
  Recording,
  Span,
  SpanCounts,
  SpanKind,
  SpanAggregation,
  Breakdown,
  BreakdownSlices,
  SpanBreakdown,
  SpanHot,
  SpanHotRef,
  FrameSideTrack,
  FrameRecord,
  FrameState,
  StepIndexEntry,
  CpuFunction,
  CpuGroupStat,
  CpuEdge,
  CpuSystem,
  CpuModel,
} from "./model/recording.js";

// Derived shapes emitted by the query / cpu-diff verbs under --format json|toon.
export type {
  CpuDropped,
  CpuOverview,
  CpuEdgeRef,
  FrameQueryResult,
  BlameEntry,
  UnifiedSlices,
  SpanEntry,
  SpansResult,
  SpanForced,
  SpanHotFunctions,
  SpanAnatomy,
  GroupSpanMember,
  GroupSpanSources,
  GroupSpanStitch,
  GroupSpansProvenance,
  GroupSpansResult,
  SpansOutput,
  CpuPackageDelta,
  CpuFunctionDelta,
  CpuDiffResult,
} from "./model/query.js";

// The run-group manifest artifact (`<base>.group.json`): the N-capture-of-one-workload shape and its
// members. `query spans`/`span` on a group emit GroupSpansResult / GroupSpanStitch (above).
export type { RunGroup, GroupMeta, GroupMember } from "./model/group.js";

// Raw V8 sampling profile (the .cpuprofile file, DevTools/Speedscope format).
export type { RawCpuProfile } from "./profile/cpuprofile.js";

// The `latest` pointer file (cwd-keyed, under the XDG state dir).
export type { LastPointer } from "./commands/resolve.js";

// Driver helpers a user's module can import. `waitForStable` is a `measureStep` `until` that waits
// for a streamed / soft-navigating transition to finish (the default settle can end before it does).
// Driver mode also INJECTS `waitForStable` into the `run`/`prepare`/`cleanup` argument (DriverContext),
// so a module driven under a bare `npx` run needs no import at all.
export { waitForStable } from "./browser/until.js";
export type { WaitForStableOptions } from "./browser/until.js";

// The argument driver mode hands `run`/`prepare`/`cleanup`, so a TypeScript driver module can annotate
// its hook (`run({ page, measureStep, waitForStable }: DriverContext)`) and see the injected helper.
export type { DriverContext, MeasureStep } from "./browser/driver.js";
