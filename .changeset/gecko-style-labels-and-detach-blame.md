---
"@jantimon/web-performance-debugger": patch
---

Firefox reconciling bars now split style vs layout more accurately, and Chrome `--deep` dirtied-by no
longer stamps a self-referential `display:none` line.

The Firefox six-slice bar was bucketing style-recalc wrapper/diff/stylist frames
(`RestyleManager::...`, `ComputedStyle::CalcStyleDifference`, `Update stylesheet information`,
`PresShell::DoFlushPendingNotifications Style`) as `layout`, under-counting `style` by ~10-25% on
style-bound workloads. They now classify as `style`, so bars re-split: `style` rises and `layout`
drops (to ~0 on pure-style workloads). Matching stays anchored, so the `CTFontFamily::FindStyleVariations`
font frame and the ` Layout` flush sibling stay `layout`.

Chrome `--deep` `query blame --forced` / `query span`: a `display:none` removal emits `"Removed from
layout"` at recalc time naming the geometry read, which surfaced as a self-referential "dirtied by
<the read itself>" entry. That position-equal entry is now dropped; a genuine `removeChild` (a distinct
write line) is kept. Thrash counts are unchanged.
