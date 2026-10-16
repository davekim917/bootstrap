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

  # The registry's status is Claude Code's own record that a turn is blocked on a person
  # (a permission prompt, AskUserQuestion); the transcript then ends in a tool call. Otherwise a turn
  # that ended with Claude's text is waiting. Reading only the tail is safe: tool results alternate
  # with assistant entries, so the last assistant or human entry is within the final few lines.
  tail -n 1000 "$transcript" | jq -nrR --slurpfile reg "$s" --arg name "${name:-${sid%%-*}}" --arg cwd "$cwd" '
    def blocks: .message.content | if type == "string" then [{type: "text", text: .}] elif type == "array" then . else [] end;
    def human: .type == "user" and (.isMeta | not)
      and (blocks | all(.[]; .type != "tool_result"))
      and (blocks | any(.[]; .type == "image")
           or ([.[] | select(.type == "text") | .text // ""] | join("\n")
               | gsub("<(?<t>task-notification|system|system-reminder|local-command-stdout|local-command-caveat)>[\\s\\S]*?</\\k<t>>"; "")
               | test("\\S")));
    def said: [.message.content[]? | select(.type == "text") | .text] | join("\n");
    $reg[0] as $r
    | (now - 2 * 86400 | todate) as $since
    | reduce (inputs | fromjson? | objects | select((.timestamp // "") > $since and (.isSidechain | not))) as $e
        ({last: null, said: ""};
         if $e.type == "assistant" then .last = $e | (if ($e | said) != "" then .said = ($e | said) else . end)
         elif ($e | human) then .last = $e | .said = ""
         else . end)
    | if $r.status == "waiting" then
        ([.last.message.content[]? | select(.type == "tool_use" and .name == "AskUserQuestion")
          | .input.questions[]? | "\(.question) [\([.options[]?.label] | join(" / "))]"] | join("\n")) as $ask
        | (if $r.statusUpdatedAt then ", since \($r.statusUpdatedAt / 1000 | floor | todate)" else "" end) as $when
        | "=== \($name)  \($cwd)  (waiting: \($r.waitingFor // "input")\($when))\n\(if $ask != "" then $ask else .said[-900:] end)\n"
      elif .last.type == "assistant" and (.last | said) != "" and all(.last.message.content[]?; .type != "tool_use") then
        "=== \($name)  \($cwd)  (last reply \(.last.timestamp))\n\(.said[-900:])\n"
      else empty end' ||
    echo "waiting.sh: could not read $transcript" >&2
done
