# Security

## Reporting a vulnerability

Report a suspected vulnerability privately through GitHub: open the
[Security tab](https://github.com/jantimon/web-performance-debugger/security) and use
**Report a vulnerability**. This opens a private advisory only you and the maintainers can read, so
you can share details before any fix is public.

Please do not open a public issue for a security report. Include the version, how to reproduce, and
what an attacker gains. You will get a first response within a few days.

## What runs, and where

`wpd` drives a real browser over the pages and modules you point it at, and profiles code you name.
Its posture is built for that: run it against untrusted pages in a throwaway environment, and it
keeps its blast radius small by default.

### The browser sandbox is on by default

Chrome launches sandboxed. Where the OS sandbox cannot start (containers, restricted CI), `wpd`
**fails with a message naming the opt-out** rather than dropping the sandbox on its own:

- `--disable-browser-sandbox` (or `WPD_DISABLE_BROWSER_SANDBOX=1`) is the only way to drop it, and it
  is loud. Use it only in a trusted, isolated environment such as a container or CI.
- `--disable-browser-sandbox` with `--user-data-dir` is refused outright: no-containment renderer plus
  your persistent Chrome profile (its cookies and logins) has no safe combination.
- Loading a public `--url` with the sandbox off prints a warning naming the host, since page content
  then runs in a renderer with no OS containment.

### Remote fetches are bounded and host-checked

To split a minified bundle by package, `wpd` fetches a script's sourcemap. That fetch runs under a
fixed policy (`src/trace/sourcemap.ts`):

- **Scheme.** Only `http(s)`. A redirect landing on `file:`, `data:`, or any other scheme is blocked.
- **Private and loopback hosts.** When the profiled page is public, a sourcemap URL that resolves to a
  private, loopback, or link-local host (`localhost`, `127.0.0.0/8`, `10/172.16/192.168`, `169.254`,
  `::1`, `fc00::/7`, `fe80::/10`) is blocked, so a public site's bundle can never make `wpd` reach into
  your internal network. When the page itself is local (a served fixture, a dev server), local targets
  are expected and allowed.
- **Redirects** are followed manually, at most 5 hops, and **every hop is re-checked** against the
  scheme and host rules, so a 302 cannot escape the policy.
- **Size caps:** 20 MB per script, 50 MB per map, enforced by `content-length` and by streaming, so a
  lying or absent `content-length` still aborts once the cap is crossed.
- **Time budget:** 30 s for all remote sourcemap work in one run, at most 4 fetches at once. Past the
  budget, remaining frames keep their minified names.

A blocked or failed fetch is recorded in `meta.sourcemaps` with its reason (`blocked-fetch`,
`script-too-large`, and the rest), never silently retried against the policy.

### No telemetry, artifacts stay local

`wpd` sends nothing home. It makes no network call except the sourcemap fetches above (to hosts your
own page references) and the browser's own navigation to the URL you pass. Every recording, CPU
profile, and Gecko dump is written to your disk (`./recordings/` or your `--out` path); the only file
kept out of your tree is a `latest` pointer under the XDG state dir. Nothing is uploaded, and no
usage data is collected.

## Supported versions

Fixes land on the latest published release. Upgrade to the newest version before reporting, in case
the issue is already fixed.
