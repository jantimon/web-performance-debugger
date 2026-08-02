---
"@jantimon/web-performance-debugger": minor
---

`assert` gains `--format json|toon`, emitting a typed `AssertView`: a row per threshold (`axis`,
`budget`, measured `value` or `null`, `verdict` pass/fail/n-a-fail, plus the routed `member` on a
run-group), the overall `passed`, and the `violations`. A CI PR-comment script now consumes the gate
verdict structurally instead of scraping the ASCII table. The exit code is unchanged (0 = passed, 1 =
any failed), so a `--format json` gate fails the build exactly as the human report does.
