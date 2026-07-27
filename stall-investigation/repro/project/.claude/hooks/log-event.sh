#!/bin/sh
# Timestamps every lifecycle event the harness reports and appends one JSON line
# to $WPD_REPRO_LOG. Reads the hook payload from stdin, never blocks, always
# exits 0 so a logging failure can never change the run under test.
LOG="${WPD_REPRO_LOG:-/tmp/wpd-repro-hooks.jsonl}"
EVENT_LABEL="$1"
NOW=$(date +%s.%N)
PAYLOAD=$(cat)
printf '%s' "$PAYLOAD" | jq -c \
  --arg ts "$NOW" \
  --arg label "$EVENT_LABEL" \
  '{ts: ($ts|tonumber), label: $label, hook: .hook_event_name, session: .session_id,
    tool: .tool_name, input: .tool_input, response: (.tool_response|tostring|.[0:600])}' \
  >>"$LOG" 2>/dev/null \
  || printf '{"ts":%s,"label":"%s","raw_parse_failed":true}\n' "$NOW" "$EVENT_LABEL" >>"$LOG"
exit 0
