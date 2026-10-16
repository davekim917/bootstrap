#!/usr/bin/env bash
# List every live Claude Code session on this machine, in any project, whose last turn ended with
# Claude talking and nobody replying yet, with the tail of that message, so the Anderton can see
# questions asked in another tab. The session holding the Anderton role is left out.
# Portable to macOS's bash 3.2 and BSD userland: jq does the date arithmetic, not date -d.
set -euo pipefail
# shellcheck source=SCRIPTDIR/session-lib.sh
. "$(dirname "$0")/session-lib.sh"

command -v jq >/dev/null 2>&1 || {
  echo "waiting.sh needs jq: install it (brew install jq, or your package manager) and rerun." >&2
  exit 1
}
require_ps waiting.sh

home="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
state="${ANDERTON_STATE:-$home/anderton.json}"
holder_pid=""
holder_start=""
if [ -f "$state" ]; then
  holder_pid=$(jq -r '.pid // empty' "$state" 2>/dev/null || true)
  holder_start=$(jq -r '.startedAt // empty' "$state" 2>/dev/null || true)
fi

for s in "$home"/sessions/*.json; do
  [ -e "$s" ] || continue
  fields=$(jq -r '[(.pid // "" | tostring), (.startedAt // "" | if type == "number" then floor | tostring else . end), .sessionId // "", .cwd // "", .name // ""] | join("\u001f")' "$s" 2>/dev/null) || continue
  IFS=$'\x1f' read -r pid start sid cwd name <<EOF
$fields
EOF
  [ -n "$pid" ] && [ -n "$sid" ] || continue
  if [ "$pid" = "$holder_pid" ] && { [ -z "$holder_start" ] || [ "$start" = "$holder_start" ]; }; then
    continue
  fi
  registered_alive "$pid" "$start" || continue

  transcript=""
  for t in "$home"/projects/*/"$sid".jsonl; do
    if [ -e "$t" ]; then
      transcript=$t
      break
    fi
  done
  [ -n "$transcript" ] || continue

  # Reading only the tail is safe: tool results alternate with assistant entries, so the last
  # assistant or human entry is always within the final few lines.
  tail -n 1000 "$transcript" | jq -nrR --arg name "${name:-${sid%%-*}}" --arg cwd "$cwd" '
    def blocks: .message.content | if type == "string" then [{type: "text", text: .}] elif type == "array" then . else [] end;
    def human: .type == "user" and (.isMeta | not) and (.isSidechain | not)
      and (blocks | all(.[]; .type != "tool_result"))
      and (blocks | any(.[]; .type == "image")
           or ([.[] | select(.type == "text") | .text // ""] | join("\n")
               | gsub("<(?<t>task-notification|system|system-reminder|local-command-stdout|local-command-caveat)>[\\s\\S]*?</\\k<t>>"; "")
               | test("\\S")));
    (now - 2 * 86400 | todate) as $since
    | reduce (inputs | fromjson? | objects) as $e (null;
        if ($e.timestamp // "") > $since and ($e.isSidechain | not) and ($e.type == "assistant" or ($e | human))
        then $e else . end)
    | select(. != null and .type == "assistant" and all(.message.content[]?; .type != "tool_use"))
    | ([.message.content[]? | select(.type == "text") | .text] | join("\n")) as $txt
    | select($txt != "")
    | "=== \($name)  \($cwd)  (last reply \(.timestamp))\n\($txt | .[-900:])\n"' ||
    echo "waiting.sh: could not read $transcript" >&2
done
