---
---

Internal restructure only, no release. Split `model/recording.ts` into domain files behind a barrel
(`events.ts`/`cpu.ts`/`frames.ts`/`attribution.ts`/`meta.ts`/`sourcemap-meta.ts`, plus `driver-step.ts`
for the driver→steps contract), and move the raw-profile types + `functionIdByNode` into `profile/raw.ts`.
`../model/recording.js` and `../profile/cpuprofile.js` stay the import paths (both re-export). The public
`index.ts` surface is unchanged; no CLI output or behavior changes.
