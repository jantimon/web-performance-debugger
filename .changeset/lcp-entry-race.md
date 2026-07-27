---
"@jantimon/web-performance-debugger": patch
---

Boot-LCP capture now waits boundedly for a racing `largest-contentful-paint` entry on a hard-navigation
step, so a slow environment that queues the entry after the read no longer drops a real paint. Absence
stays honest, and the wait sits after the step's end mark so it never grows the measured window.
