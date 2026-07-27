# Ready-to-post comment for anthropics/claude-code#80834

---

Confirmed on **2.1.220** with an instrumented repro (hook-timestamped lifecycle events,
`--output-format stream-json`, marker files), plus a code-level root cause read out of the
shipped bundle. Cross-linking the same cluster: #78782, #77578, #77554, #76681, #68749.

## Repro result (headless, `claude -p`, Linux)

Subagent runs `sh -c 'sleep 60; date +%s.%N > done_marker'` with `run_in_background: true`
and ends its turn; the parent stays alive heartbeating for another ~150s (20 tool-step
boundaries spanning the task's whole duration):

| delta from bg start | event |
|---|---|
| +0.0s | bg task accepted (`Command running in background with ID ... You will be notified when it completes.`) |
| +4.8s | `SubagentStop` hook fires (subagent finalized) |
| +4.8s | `task_notification` for the shell, `status: "stopped"` (task killed) |
| +4.9s | subagent result reaches the parent |
| +60s | (the sleep would have finished here) |
| +151s | parent heartbeat 20/20: nothing delivered |
| never | `done_marker` never written |

Positive control: the identical task delivered to a subagent that stays live (foreground
heartbeats) completes and notifies normally at the next tool-step boundary (`completed
(exit code 0)`, marker written at +60.3s). So notification delivery works; only the
stopping-subagent edge is broken.

Two refinements to the reports in this cluster:

- **Killed vs orphaned is mode-dependent.** Headless: the shell is killed at subagent
  finalization (`status: "stopped"` fires immediately after `SubagentStop`, before the
  subagent result even reaches the parent) — matching this issue's "dies with it". In
  interactive/remote sessions we have repeatedly observed the process *surviving* orphaned
  and its finished output found only on a later manual resume (jantimon/web-performance-debugger#118) —
  matching #77578/#77554/#17764. Both modes lose the wake-up.
- **Keeping the parent alive does not rescue the task**: the completion/kill notification
  is addressed to the dead subagent, so a live parent never sees it.

## Root cause (read from the 2.1.220 bundle; names are from that build's mangling)

All task notifications land in one global queue tagged with an `agentId` address;
consumption is by address match. A live subagent drains its own address at each tool-step
boundary; the top-level consumers (interactive REPL store subscription and the `-p`
`do/while` both) accept only main-addressed notifications. The chain:

1. While the shell runs, the owning subagent is keepalive-pinned (`bash:<taskId>` reason)
   — the hold machinery exists and engages.
2. On shell exit the Bash completion notifier (`nFs`, anchor:
   `function nFs(e,t,r,n,o,i,s="bash",a){if(!pBe(e,o).claimed)return;`) enqueues with
   `agentId: a ?? Si()` — **unconditionally the owner subagent**, bypassing the
   owner-liveness router (`zPs`) that agent- and workflow-completion notifications
   already go through, which falls back to main when the owner is dead/retiring.
3. The caller (`UDd`) then releases the `bash:` keepalive, so the subagent retires.
4. The retire-time reclaim sweep (`nLo`, called from `ke_`) re-addresses stranded
   notifications to main, but its predicate requires `type === "local_agent"`
   (`hc(i) && i.ownerAgentId === e`), so a `local_bash` notification is never reclaimed.
5. The notification sits in the queue forever, addressed to a finalized agent.

Contributing cause: `local_bash` registers its owner under `agentId` while
`local_agent`/`local_workflow` use `ownerAgentId`; every owner-aware helper (`zPs`,
`nLo`, the stale-keepalive sweep `_0o`) reads `ownerAgentId` and silently no-ops on
shells (`_0o` handles only `agent:`/`workflow:` prefixes; `hasRunningBgTasks` explicitly
excludes `local_bash`).

## Suggested fix

1. Route the Bash completion notification through `zPs` (as `b$t` and the workflow
   notifier already do), so a dead-or-retiring owner falls back to main and the parent
   session is woken with the result — evaluated before the keepalive release in `UDd`,
   which the existing ordering already guarantees.
2. Make `nLo`'s reclaim predicate type-agnostic: `(hc(i) ? i.ownerAgentId : i.agentId) === e`,
   so any notification stranded by a retiring agent is re-addressed to main (covers the
   race where the owner retires between enqueue and drain).
3. Unify the owner field (`agentId` -> `ownerAgentId`) at the `local_bash` registration
   site; the divergence is what made all three exclusions possible. Also extend `_0o` to
   `bash:` keepalive reasons.

## Workaround for affected users (validated on 2.1.220)

The `SubagentStop` hook payload now includes a `background_tasks` array. A hook that
blocks the stop once when it contains a shell with `status: "running"` and instructs the
subagent to poll in one foreground Bash call converts the silent kill into a completed
task. Script + evidence:
https://github.com/jantimon/web-performance-debugger/tree/main/stall-investigation

---
