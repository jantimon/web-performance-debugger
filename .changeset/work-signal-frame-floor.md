---
"@jantimon/web-performance-debugger": minor
---

Label floored trusted-click driver steps on `--breakdown`. A trusted `page.click` carries ~8ms of
input dispatch inside the step window, so a floored cheap step's wall (~41ms) lands off any exact
frame multiple and the old wall-multiple check missed it. `query span`/`query spans` now read a
step's flooring off its reconciling bar (sub-frame real work in an idle-dominated window), so a
sub-frame interaction is no longer read as real work.

The `frameFloor` JSON field carries a `basis` discriminator: `{ basis: "wall-multiple", floorMs,
multiple }` for a bench/in-page/measure wall and INP, or `{ basis: "work-signal", floorMs, workMs }`
for a driver step. Exported as `FrameFloor` (union) with `WallMultipleFloor`/`WorkSignalFloor`.
