# Security

## Reporting a vulnerability

Report privately through GitHub: the
[Security tab](https://github.com/jantimon/web-performance-debugger/security) →
**Report a vulnerability**. Please do not open a public issue. Include the version and how to
reproduce. Fixes land on the latest published release, so upgrade before reporting in case the issue
is already fixed.

## What wpd does on your machine

`wpd` is a local CLI: it drives a browser over the pages and modules you point it at, and writes
every artifact to your own disk. In short:

- Chrome runs **sandboxed by default**; dropping the sandbox needs an explicit, loud opt-in
  (`--disable-browser-sandbox`), meant for containers and CI.
- The only network traffic is the page you name and its sourcemap fetches, which run under a bounded
  policy (scheme/host checks, size and time caps — see `src/trace/sourcemap.ts`).
- **No telemetry.** Nothing is uploaded, no usage data is collected.

If you measure untrusted pages, treat it like opening them in a browser: prefer a throwaway
environment.
