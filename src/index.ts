// Public, semver-covered API for `@jantimon/web-performance-debugger`. This module is the
// only stable surface: the types here describe every JSON artifact the CLI writes and every
// `--format json|toon` verb output, so consumers can type their parsing without inspecting
// sample output. Anything else under dist/ is internal and may change without a major bump.

/** Schema epoch (major-only), independent of the package version. Stamped into every
 * artifact as `meta.schemaVersion`. */
export { SCHEMA_VERSION } from "./schema.js";

// On-disk artifact shapes (recording / digest / step index / cpu model).
export type {
  EventKind,
  StackFrame,
  NormalizedEvent,
  InvalidationRecord,
  TimingEntry,
  MetricsBlock,
  BenchStats,
  InteractionTiming,
  StepTiming,
  RecordingSummary,
  RecordingWindow,
  ScreenshotRefs,
  BlameSemantic,
  RecordingMeta,
  Recording,
  Digest,
  StepIndexEntry,
  StepIndex,
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
  CpuPackageDelta,
  CpuFunctionDelta,
  CpuDiffResult,
} from "./model/query.js";

// Raw V8 sampling profile (the .cpuprofile file, DevTools/Speedscope format).
export type { RawCpuProfile } from "./profile/cpuprofile.js";

// The `latest` pointer file (cwd-keyed, under the XDG state dir).
export type { LastPointer } from "./commands/resolve.js";
