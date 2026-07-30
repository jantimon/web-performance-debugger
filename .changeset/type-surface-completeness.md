---
"@jantimon/web-performance-debugger": minor
---

Complete the public type surface so every type named inside an exported type is itself importable (no more hand-rolling a shape the package already describes). New root exports include `CaptureMode`, `TargetLane`, `WorkloadLane`, `Measured`, `CpuBreakdown`/`CpuSlice`/`CpuJsSlice`, `LayoutShift`(+`Source`/`Rect`), `EngineSoftNav`, `SoftNavRoute`(+`Lcp`)/`SoftNavVerdict`/`SoftNavAgreement`, `ThrashReport`/`ThrashStep`/`DirtiedByWrite`/`DirtiedByWriteRollup`/`FirefoxDirtiedByReport`, `WorkloadIdentity`, `SourceMapDiagnostics`/`SourceMapFailure`, `FrameFloorMatch`, `SpanCountsEntry`, `RawProfileNode`/`RawCallFrame`/`GeckoSlice`, and the driver `StepOpts`/`Until`.

Narrowed the closed-union output fields from `string` to their real unions: `RecordingMeta.capture` and `GroupSpanMember.mode` to the capture-mode union, and `SpansResult`/`SpanAnatomy`/`GroupSpanStitch` `target` to `"chrome" | "firefox" | "node"`. Reading these fields now yields the exact literal type instead of a bare string.
