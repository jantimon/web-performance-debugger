---
"@jantimon/web-performance-debugger": patch
---

`record --members ... --out <path>` now names the group's manifest and member recordings from `--out`'s
basename (before, only its directory was used and the basename was silently dropped), so a path a caller
derives from `--out` exists. The group's identity still comes from `--group` (`meta.name`), so `latest`
and the group name resolve unchanged.

README: the pnpm caveat now covers pnpm 11 blocking the bin. The ignored-build install error exits 1
before `wpd` runs, stopping even the browserless `--target node` lane; unblock with `pnpm approve-builds
puppeteer`.
