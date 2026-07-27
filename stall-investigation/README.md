# Claude Code subagent background-task stall: investigation record

Investigation of [#118](https://github.com/jantimon/web-performance-debugger/issues/118):
a Claude Code subagent that starts a `run_in_background` Bash task and ends its turn is
finalized immediately instead of being re-invoked when the task completes. This directory
holds the minimal repro, the captured evidence, the code-level root cause, and the upstream
report draft. The mitigation (a `SubagentStop` hook) is installed at
`.claude/hooks/subagent-stall-guard.sh` + `.claude/settings.json`.

All measurements: Claude Code **2.1.220**, headless (`claude -p`), Linux, 2026-07-27.

## Verdict

The bug reproduces on 2.1.220, and headless is worse than #118 describes: the background
task is **killed** at subagent finalization (`task_notification ... status:"stopped"`),
not left running. In the interactive sessions #118 observed, the process survives orphaned
and its output is found only on a later manual resume. Both modes lose the completion
wake-up; they differ only in the fate of the OS process.

## Repro (`repro/`)

`./run-repro.sh [A|B|B2|C]` runs each case as one foreground `claude -p` call in
`repro/project/` (hooks there timestamp every lifecycle event to a JSONL log; nothing in
the harness itself uses a background shell, because that is the mechanism under test).

| Case | Shape | Result |
|---|---|---|
| A | top-level starts bg task, ends turn | `-p` mode does not hold the top level either: `Stop` at +1.7s, task `stopped` |
| B | subagent starts bg task, ends turn; parent also stops (literal #118 form) | `SubagentStop` +1.8s, task `stopped`, marker never written |
| B2 | same, but the parent stays alive heartbeating 20x (the discriminating test) | see timeline below |
| C | subagent starts bg task and stays alive polling (positive control) | completion notification delivered, exit code 0 reported |

### Case B2 timeline (the load-bearing measurement)

| epoch | delta from bg start | event |
|---|---|---|
| 1785146810.99 | +0.0s | bg `sleep 60` accepted, task id `botbrelq3` |
| 1785146815.83 | +4.8s | `SubagentStop` fires (subagent finalized) |
| 1785146815.83 | +4.8s | `task_notification botbrelq3 status=stopped` (task killed) |
| 1785146815.89 | +4.9s | subagent result returns to parent |
| 1785146870.99 | +60.0s | (the sleep would have finished here) |
| 1785146962.14 | +151.1s | parent heartbeat 20/20: still alive, received nothing |
| never | | `B2_done_marker` never written |

So: keeping the *parent* alive does not rescue the task. The kill happens at subagent
finalization, before the subagent's own result even reaches the parent. Case C proves the
notification wiring works whenever the subagent is still iterating: the marker lands at
+60.3s and the notification is delivered at the next tool-step boundary.

Raw evidence in `evidence/`: `ordered_stream_all_cases.tsv` (exact stream ordering),
`consolidated_timeline.tsv`, per-case hook/timeline JSONL, the full B2 `stream-json`
stdout, and `subagentstop-payload-bug-case.json` (a real `SubagentStop` hook payload in
the bug state, showing the `background_tasks` array with the shell still `running`).

## Root cause (from the shipped 2.1.220 bundle)

Claude Code ships no source; the mechanism below was read out of the minified bundle
(recovered from the 2.1.220 binary via `strings`, cross-checked against npm 2.1.112, the
last version shipping readable `cli.js`). Minified names are from the 2.1.220 build.

Substrate: every task-completion notification goes into one global queue, tagged with an
`agentId` address; consumption is purely by address matching. The turn loop is the same
code for the main agent and subagents; a live subagent drains notifications addressed to
itself at each tool-step boundary (why case C works), and the top-level consumers accept
only notifications addressed to main (in both interactive and `-p` mode, which use
different keep-alive paths but the same address filter).

The failure chain:

1. While the shell runs, the owning subagent is keepalive-pinned (the machinery to hold
   it exists and engages).
2. On shell exit, the Bash completion notifier (`nFs`) addresses the notification
   **unconditionally to the owning subagent's id**, bypassing the owner-liveness router
   (`zPs`) that agent- and workflow-completion notifications already use; that router
   falls back to addressing main when the owner is dead or retiring.
3. Immediately after enqueueing, the shell's keepalive pin is released, so the subagent
   retires at once.
4. The retire-time reclaim sweep (`nLo`) re-addresses stranded notifications to main,
   but its filter requires task `type === "local_agent"`; a `local_bash` notification can
   never be reclaimed.
5. The notification sits in the queue addressed to an agent that no longer exists.

Contributing cause: `local_bash` tasks store their owner in a field named `agentId` while
agent/workflow tasks use `ownerAgentId`; every owner-aware helper reads `ownerAgentId`
and silently no-ops on shells.

Suggested upstream fixes (in `upstream-comment.md`, with anchors): route the Bash
completion notification through the existing owner-liveness router; make the reclaim
sweep type-agnostic; unify the owner field name.

## The mitigation installed in this repo

`.claude/hooks/subagent-stall-guard.sh`, wired via `SubagentStop` in
`.claude/settings.json`. The 2.1.220 `SubagentStop` hook payload carries a
`background_tasks` array, so the guard triggers mechanically on a shell task still
`running` at subagent stop (with #118's prose regex as a fallback for payloads without
the field), blocks the turn-end once (`stop_hook_active` loop guard), and sends back the
poll instruction as the subagent's next input.

Validated end-to-end on 2.1.220: the bug-shaped run (subagent backgrounds a 45s task and
tries to end its turn) completes under the guard; the subagent is nudged, polls the task
to completion in one Bash call, and reports the real result. Without the guard the task
is killed at +2..5s and the work is silently lost.

## Upstream status

This is a known, duplicated bug cluster on `anthropics/claude-code`; do not file a new
issue. Exact duplicates: **#80834** (v2.1.218, the best consolidation target), #78782,
#77578; adjacent: #77554, #76681, #68749. Earlier instances (#17764, #50572, #47936) were
closed as not planned after going stale. The docs document no subagent exception for
`run_in_background` (and document other subagent tool exceptions precisely), so the
behavior is a bug, not documented intent. `upstream-comment.md` is a ready-to-post
comment for #80834 adding the 2.1.220 confirmation, the killed-vs-orphaned
reconciliation, the code-level mechanism, and the fix sketch.
