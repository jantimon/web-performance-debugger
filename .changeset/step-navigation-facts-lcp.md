---
"@jantimon/web-performance-debugger": minor
---

Driver steps now record a navigation classification. Each step carries `beforeUrl`/`afterUrl` (its
own `page.url()` at the start and end marks) and `navigation`: `none`, `hard` (document reloaded),
`soft` (same-document route change), or `soft-hash` (fragment-only). Decided from the step's own
url + `timeOrigin` reads, no CDP. `query spans` marks a step row that navigated; `query span <label>`
shows the before -> after URLs and the kind. Chrome and Firefox alike.

Load and hard-navigation steps also report boot LCP (`Span.lcp`): the largest
`largest-contentful-paint` entry, leading with url/size/tag, wall-tier directional. Soft/none steps
store nothing (LCP is frozen after the first interaction). Ships on chrome and firefox.

Additive: recordings gain optional fields, no schema bump.
