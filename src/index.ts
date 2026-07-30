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
  NavigationKind,
  StepLcp,
  RecordingWindow,
  BlameSemantic,
  RecordingMeta,
  TargetLane,
  WorkloadIdentity,
  WorkloadLane,
  Measured,
  SourceMapDiagnostics,
  SourceMapFailure,
  EngineVersion,
  Recording,
  Span,
  SpanAddons,
  FrameworkMode,
  SpanCounts,
  FlushScope,
  SpanScope,
  ScopeStats,
  SpanKind,
  SpanAggregation,
  Breakdown,
  BreakdownSlices,
  SpanBreakdown,
  SpanHot,
  SpanHotRef,
  LayoutShift,
  LayoutShiftSource,
  LayoutShiftRect,
  EngineSoftNav,
  SoftNavRoute,
  SoftNavRouteLcp,
  ThrashReport,
  ThrashStep,
  DirtiedByWrite,
  DirtiedByWriteRollup,
  FirefoxDirtiedByReport,
  FrameSideTrack,
  FrameRecord,
  FrameState,
  StepIndexEntry,
  CpuFunction,
  CpuGroupStat,
  SiteRelation,
  CpuEdge,
  CpuSystem,
  CpuModel,
  CpuBreakdown,
  CpuSlice,
  CpuJsSlice,
  AllocFunction,
  AllocGroupStat,
  AllocSamplingConfig,
  AllocModel,
} from "./model/recording.js";

// The one capture-mode name stamped into `meta.capture` / a group member's `mode`. Referenced by
// RecordingMeta and GroupSpanMember, so a consumer that types those needs it by name.
export type { CaptureMode } from "./record/capture.js";

// Derived shapes emitted by the query / cpu-diff verbs under --format json|toon.
export type {
  AllocDropped,
  AllocOverview,
  CpuDropped,
  CpuOverview,
  CpuEdgeRef,
  FrameQueryResult,
  BlameEntry,
  UnifiedSlices,
  SpanEntry,
  SpanCountsEntry,
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

// Fact shapes referenced by the query views but declared in their own home modules: the
// classifier-vs-engine soft-nav verdict a step anatomy carries, and the frame-cadence floor a floored
// wall/INP pins to.
export type { SoftNavVerdict, SoftNavAgreement } from "./model/soft-nav.js";
export type { FrameFloor, WallMultipleFloor, WorkSignalFloor } from "./model/frame-floor.js";

// Raw V8 sampling profile (the .cpuprofile file, DevTools/Speedscope format) and its node/frame shapes.
export type { RawCpuProfile, RawProfileNode, RawCallFrame, GeckoSlice } from "./profile/raw.js";

// The `latest` pointer file (cwd-keyed, under the XDG state dir).
export type { LastPointer } from "./commands/resolve.js";

// Framework-addon fact shapes (the `Span.addons` slot). Present only when `--framework auto` (default)
// detected the framework's factual signals; a recording of an app with no detected framework carries
// none. See docs/dev/react-attribution.md.
export type { ReactFacts, ReactPhaseRollup } from "./addons/react/facts.js";
export type { ReactDevFacts, ReactTrackBucket } from "./addons/react-dev/facts.js";

// Driver helpers a user's module can import. `waitForStable` is a `measureStep` `until` that waits
// for a streamed / soft-navigating transition to finish (the default settle can end before it does).
// Driver mode also INJECTS `waitForStable` into the `run`/`prepare`/`cleanup` argument (DriverContext),
// so a module driven under a bare `npx` run needs no import at all.
export { waitForStable } from "./browser/until.js";
export type { WaitForStableOptions } from "./browser/until.js";

// The argument driver mode hands `run`/`prepare`/`cleanup`, so a TypeScript driver module can annotate
// its hook (`run({ page, measureStep, waitForStable }: DriverContext)`) and see the injected helper.
export type { DriverContext, MeasureStep, StepOpts, Until } from "./browser/driver.js";
