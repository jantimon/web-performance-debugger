#!/bin/bash
# Repro harness for jantimon/web-performance-debugger#118:
#   a subagent that starts a run_in_background Bash call and then ends its turn is
#   finalized immediately, orphaning the still-running OS process, while a
#   TOP-LEVEL session doing the same thing is held pending and re-invoked.
#
# Cases:
#   A  top-level starts the bg task and ends its turn        (baseline for `-p` mode)
#   B  subagent starts the bg task and ends its turn; parent also stops  (literal issue form)
#   B2 subagent starts the bg task and ends its turn; PARENT STAYS ALIVE (the sharp test:
#      the bg process outlives the subagent, so does the completion notification reach anyone?)
#   C  subagent starts the bg task and STAYS ALIVE           (positive control)
#
# Usage: ./run-repro.sh [A|B|B2|C]   (no arg = all)
#
# Each case is one foreground `claude -p` run. Nothing here uses a background
# shell job, because that is the very mechanism under test.

set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$ROOT/project"
EVIDENCE="$ROOT/evidence"
CLAUDE_BIN="${CLAUDE_BIN:-/opt/node22/bin/claude}"
MODEL="${MODEL:-claude-haiku-4-5-20251001}"
SLEEP_SECS="${SLEEP_SECS:-60}"

mkdir -p "$EVIDENCE"

now() { date +%s.%N; }

# --- one case -----------------------------------------------------------------
# $1 = case id, $2 = prompt
run_case() {
  local CASE="$1" PROMPT="$2"
  local MARKER="$EVIDENCE/${CASE}_done_marker"
  local HOOKLOG="$EVIDENCE/${CASE}_hooks.jsonl"
  local TIMELINE="$EVIDENCE/${CASE}_timeline.jsonl"
  local OUT="$EVIDENCE/${CASE}_stdout.jsonl"
  local PSLOG="$EVIDENCE/${CASE}_ps.txt"

  rm -f "$MARKER" "$HOOKLOG" "$TIMELINE" "$OUT" "$PSLOG"
  : >"$HOOKLOG"

  mark() { printf '{"ts":%s,"event":"%s","note":"%s"}\n' "$(now)" "$1" "${2:-}" >>"$TIMELINE"; }

  echo "=== CASE $CASE : launching claude -p (sleep ${SLEEP_SECS}s) ==="
  mark harness_launch "marker=$MARKER"

  # The nested run is FOREGROUND with a hard timeout. If the harness process
  # returns while the sleep is still alive, that is the orphan.
  ( cd "$PROJECT" && \
    WPD_REPRO_LOG="$HOOKLOG" \
    WPD_REPRO_MARKER="$MARKER" \
    IS_SANDBOX=1 \
    env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
      "$CLAUDE_BIN" -p "$PROMPT" \
        --model "$MODEL" \
        --output-format stream-json --verbose \
        --permission-mode acceptEdits \
        --allowedTools Bash Task Agent Read Write TodoWrite \
    >"$OUT" 2>&1 )
  local RC=$?

  mark harness_claude_exited "rc=$RC"
  echo "--- claude -p exited rc=$RC at $(now)"

  # Immediately snapshot the process table: is the sleep still running?
  {
    echo "### ps snapshot immediately after claude -p exit ($(now))"
    ps -ef | grep -E "sleep|claude" | grep -v "grep -E"
  } >>"$PSLOG"

  if pgrep -f "sleep $SLEEP_SECS" >/dev/null 2>&1; then
    mark sleep_still_alive_after_exit "ORPHAN: sleep $SLEEP_SECS running with no claude parent turn pending"
    echo "!!! sleep $SLEEP_SECS is STILL RUNNING after claude -p returned"
  else
    mark sleep_gone_after_exit "no sleep $SLEEP_SECS process found"
    echo "    no sleep $SLEEP_SECS process after exit"
  fi

  if [ -f "$MARKER" ]; then
    mark marker_present_at_exit "$(cat "$MARKER")"
  else
    mark marker_absent_at_exit ""
  fi

  # Bounded poll (never a bare foreground wait between tool calls; this is one call).
  local WAITED=0
  while [ ! -f "$MARKER" ] && [ $WAITED -lt $((SLEEP_SECS + 60)) ]; do
    sleep 2
    WAITED=$((WAITED + 2))
  done
  if [ -f "$MARKER" ]; then
    mark marker_written "$(cat "$MARKER") after ${WAITED}s of post-exit polling"
    echo "    done_marker at $(cat "$MARKER") (${WAITED}s after claude exit)"
  else
    mark marker_never_written "polled ${WAITED}s"
    echo "    done_marker NEVER appeared (polled ${WAITED}s) -> bg process was killed, not orphaned"
  fi

  {
    echo "### ps snapshot after marker poll ($(now))"
    ps -ef | grep -E "sleep|claude" | grep -v "grep -E"
  } >>"$PSLOG"
}

# --- prompts ------------------------------------------------------------------
MARK_A="$EVIDENCE/A_done_marker"
MARK_B="$EVIDENCE/B_done_marker"
MARK_B2="$EVIDENCE/B2_done_marker"
MARK_C="$EVIDENCE/C_done_marker"

HEARTBEAT="Repeatedly make short FOREGROUND Bash tool calls, ONE PER STEP, each exactly:
sleep 5; echo heartbeat; date +%s.%N
Make them one at a time, never in parallel, never in the background."

PROMPT_A="Run exactly one Bash tool call, with run_in_background set to true, and command:
sh -c 'sleep $SLEEP_SECS; date +%s.%N > $MARK_A'
Then immediately end your turn with the final message: background task started; I will be re-invoked when it completes.
Do not poll. Do not run any other tool. Do not spawn any subagent."

PROMPT_B="Spawn exactly ONE subagent using the Task tool with subagent_type general-purpose, and give it exactly this prompt:
---
Run exactly this Bash tool call: command \`sh -c 'sleep $SLEEP_SECS; date +%s.%N > $MARK_B'\` with run_in_background set to true. Then immediately end your turn with the final message 'background task started; I will be re-invoked when it completes.' Do not poll, do not run any other tool, do not wait.
---
When the subagent returns, report its final message verbatim and then stop. Do not run any tool yourself, do not start any background task yourself, and do not spawn a second subagent."

PROMPT_B2="Spawn exactly ONE subagent using the Task tool with subagent_type general-purpose, and give it exactly this prompt:
---
Run exactly this Bash tool call: command \`sh -c 'sleep $SLEEP_SECS; date +%s.%N > $MARK_B2'\` with run_in_background set to true. Then immediately end your turn with the final message 'background task started; I will be re-invoked when it completes.' Do not poll, do not run any other tool, do not wait.
---
After the subagent returns, YOU must STAY ALIVE. $HEARTBEAT
Keep heartbeating until a background-task / subagent completion notification appears in your conversation. The moment one appears, stop heartbeating and end your turn with a final message that starts with NOTIFICATION-RECEIVED: followed by the notification text verbatim.
If you have made 20 heartbeat calls and no such notification has appeared, end your turn with the final message NO-NOTIFICATION-AFTER-20-HEARTBEATS.
Never read the marker file and never poll the background task yourself."

PROMPT_C="Spawn exactly ONE subagent using the Task tool with subagent_type general-purpose, and give it exactly this prompt:
---
Step 1: run this Bash tool call: command \`sh -c 'sleep $SLEEP_SECS; date +%s.%N > $MARK_C'\` with run_in_background set to true.
Step 2: STAY ALIVE. $HEARTBEAT
Keep doing that, one call at a time, until a background-task completion notification appears in your conversation. The moment it appears, stop heartbeating and end your turn with a final message that starts with NOTIFICATION-RECEIVED: followed by the notification text verbatim.
If you have made 20 heartbeat calls and still received nothing, end your turn with the final message NO-NOTIFICATION-AFTER-20-HEARTBEATS.
Never read the marker file and never poll the background task yourself.
---
When the subagent returns, report its final message verbatim and then stop. Do not run any tool yourself."

WHICH="${1:-ALL}"
case "$WHICH" in
  A) run_case A "$PROMPT_A" ;;
  B) run_case B "$PROMPT_B" ;;
  B2) run_case B2 "$PROMPT_B2" ;;
  C) run_case C "$PROMPT_C" ;;
  ALL) run_case A "$PROMPT_A"; run_case B "$PROMPT_B"; run_case B2 "$PROMPT_B2"; run_case C "$PROMPT_C" ;;
  *) echo "usage: $0 [A|B|B2|C]"; exit 2 ;;
esac
