#!/usr/bin/env bash
# SubagentStop guard for a Claude Code harness bug (anthropics/claude-code#80834,
# reproduced on 2.1.220): a subagent that ends its turn while its own
# run_in_background Bash task is still running is finalized immediately; the
# task is killed (headless) or orphaned (interactive), and the promised
# completion re-invocation never fires. This hook blocks that turn-end once and
# sends back a poll instruction as the subagent's next input.
set -euo pipefail
payload="$(cat)"

# Loop guard: never block twice (one nudge, then allow).
if printf '%s' "$payload" | grep -qE '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

stall=0
if printf '%s' "$payload" | grep -q '"background_tasks"'; then
  # Mechanical signal (2.1.220+): the payload lists the session's background
  # tasks; a shell task still running at SubagentStop is the bug shape.
  if printf '%s' "$payload" | grep -qE '"type"[[:space:]]*:[[:space:]]*"shell"[^{}]*"status"[[:space:]]*:[[:space:]]*"running"|"status"[[:space:]]*:[[:space:]]*"running"[^{}]*"type"[[:space:]]*:[[:space:]]*"shell"'; then
    stall=1
  fi
else
  # Fallback for payloads without background_tasks: a final message promising a
  # wake-up that will never come.
  if printf '%s' "$payload" | grep -qiE 're-?invoke|will notify|notify (me )?(on|upon) completion|awa(it|iting)|waiting (for|on) .*(background|task|run|monitor|completion|event)|monitor.?s? (completion|event)|(both|the).*(will )?notify'; then
    stall=1
  fi
fi

if [ "$stall" = 1 ]; then
  printf '%s\n' '{"decision":"block","reason":"A background shell task is still running and you are ending your turn. Subagents are NOT re-invoked when a run_in_background Bash task finishes: on turn-end you are finalized and the task is killed or orphaned. Do not wait for a notification. In ONE Bash tool call, poll your command output file to completion and then act on the result this turn, e.g.: for attempt in $(seq 1 240); do [ -s OUTFILE ] && break; sleep 5; done; cat OUTFILE"}'
fi
exit 0
