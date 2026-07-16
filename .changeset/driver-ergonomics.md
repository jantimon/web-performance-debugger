---
"@jantimon/web-performance-debugger": minor
---

Driver-mode ergonomics: modules outside cwd, per-step wall, actionable errors

- **Driver modules can now live anywhere.** `record` rejected any module outside the working
  directory ("so it can be served to the browser"), but only `--bench` imports the module inside the
  page. Driver and `--runtime node` modules are imported in Node over `file://` and were never
  served, so the restriction blocked a lane it never applied to. The check now runs only for
  `--bench`, where it is true.
- **`summary.perStep`** reports each `measureStep`'s labelled wall time on driver runs. Previously a
  driver run had no per-interaction wall in `summary` at all: `summary.wallMs` is the whole `wpd:run`
  window (navigation + `prepare` + every step + settle), and `perIteration`/`stats` are bench-only,
  because a median across heterogeneous steps is meaningless. The report prints the steps as a
  labelled table and now names the wall row "wall (whole run window)".
- **Protocol timeouts name the flag that fixes them.** Puppeteer's message points at the
  `protocolTimeout` option of "launch/connect calls", an API a CLI user never touches; `record` now
  appends the `--protocol-timeout` hint.
- **A missing browser prints a copy-pasteable install line** pinned to the exact build wpd requires
  (`npx puppeteer browsers install firefox@stable_152.0.2`). The generic
  `npx puppeteer browsers install firefox` installs whatever the ambient puppeteer pins, which can
  differ and leave the same error in place. The build is scraped from puppeteer's own error, so it
  cannot drift from the real requirement.
