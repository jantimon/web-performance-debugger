---
"@jantimon/web-performance-debugger": minor
---

Clearer errors and a tidier `query spans` contract.

- A module missing its `run` export now gets a message naming the module and the one-line fix (`export async function run(ctx) { ... }`), instead of the placeholder `'run' / 'run' export`.
- Every verb honors `WPD_DEBUG=1`: the message always prints, and the full stack follows when the env is set. The one-line message trails the ` (set WPD_DEBUG=1 ...)` hint so a caller reading only the last stderr line still sees the real error.
- A trace wpd cannot parse now says so as a capture fault ("re-record; file an issue"), keeping the mechanical detail.
- `query get <id>` on a missing id points at `query events`.
- JSON contract: `query span`'s `forced[]` read-sites move from the `at: "file:line:col"` string to structured `{ source, line, column }`, matching `query blame --forced`. `query spans` rows gain a compact `frameFloor: { floorMs, multiple }` when the wall is frame-floor dominated, so a consumer reads flooring off the overview instead of recomputing it.
