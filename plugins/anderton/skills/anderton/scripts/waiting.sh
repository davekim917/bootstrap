#!/usr/bin/env bash
# List the live Claude Code sessions in the caller's project (every project with --all) that are
# waiting on a person: their turn ended with Claude talking, or it is blocked on a prompt. The
# session holding the Anderton role for the caller's project is left out.
# Portable to macOS's bash 3.2 and BSD userland: jq does the date arithmetic, not date -d.
set -euo pipefail
# shellcheck source=SCRIPTDIR/session-lib.sh
. "$(dirname "$0")/session-lib.sh"

require_tools waiting.sh

all=""
case "${1:-}" in
  "") ;;
  --all) all=1 ;;
  *) echo "usage: waiting.sh [--all]" >&2; exit 2 ;;
esac

root=$(invoking_root)
record=$(holder_record "$root")

for s in "$sessions"/*.json; do
  [ -e "$s" ] || continue
  fields=$(jq -r '[(.pid // "" | tostring), (.startedAt // "" | if type == "number" then floor | tostring else . end), .sessionId // "", .cwd // "", .name // ""] | join("\u001f")' "$s" 2>/dev/null) || continue
  IFS=$'\x1f' read -r pid start sid cwd name <<EOF
$fields
EOF
  [ -n "$pid" ] && [ -n "$sid" ] || continue
  if [ -n "$record" ] && is_holder "$s" "$record"; then continue; fi
  if [ -z "$all" ] && { [ -z "$cwd" ] || [ "$(project_root "$cwd")" != "$root" ]; }; then
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

  # The registry's status is Claude Code's own record that the session is blocked on a person (a
  # permission prompt, AskUserQuestion), in its main thread or in a sub-agent, whose transcripts sit
  # under <session>/subagents/. Without that status, a main-thread tool call left unanswered for over
  # a minute is probably a permission prompt. Otherwise a turn that ended with Claude's text is waiting.
  # A registry that says busy rules out both: Claude writes each block as it finishes, so a turn
  # that is still running can end in text for a while. Reading only the tails is safe: tool results
  # alternate with assistant entries, so the entries that decide this are within the final few lines.
  {
    tail -n 1000 "$transcript"
    if [ -d "${transcript%.jsonl}/subagents" ]; then
      find "${transcript%.jsonl}/subagents" -name '*.jsonl' -mmin -2880 2>/dev/null | while read -r f; do
        printf '\n{"subagent":"%s"}\n' "$(basename "$f" .jsonl)"
        tail -n 200 "$f"
      done
    fi
  } | jq -nrR --slurpfile reg "$s" --arg name "${name:-${sid%%-*}}" --arg cwd "$cwd" '
    def blocks: .message.content | if type == "string" then [{type: "text", text: .}] elif type == "array" then . else [] end;
    def human: .type == "user" and (.isMeta | not)
      and (blocks | all(.[]; .type != "tool_result"))
      and (blocks | any(.[]; .type == "image")
           or ([.[] | select(.type == "text") | .text // ""] | join("\n")
               | gsub("<(?<t>task-notification|system|system-reminder|local-command-stdout|local-command-caveat)>[\\s\\S]*?</\\k<t>>"; "")
               | test("\\S")));
    def said: [.message.content[]? | select(.type == "text") | .text] | join("\n");
    def answers: [.message.content[]? | objects | select(.type == "tool_result")] | length > 0;
    def track($e): reduce ($e.message.content[]? | objects) as $c (.;
        if $c.type == "tool_use" and $e.type == "assistant" then
          .open[$c.id // "?"] = {name: $c.name, input: $c.input, at: $e.timestamp, agent: .agent}
        elif $c.type == "tool_result" then del(.open[$c.tool_use_id // "?"])
        else . end);
    def seconds: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
    def calls: map((if .agent then "[sub-agent \(.agent)] " else "" end)
      + "\(.name) (pending \(.pending)s): \(.input | tojson | .[0:200])") | join("\n");
    $reg[0] as $r
    | now as $now
    | ($now - 2 * 86400 | todate) as $since
    | reduce (inputs | fromjson? | objects) as $e ({last: null, said: "", open: {}, agent: null};
        if $e.subagent then .agent = $e.subagent
        elif ($e.timestamp // "") <= $since then .
        elif .agent != null then track($e)
        elif $e.isSidechain then .
        elif $e.type == "assistant" then
          .last = $e | (if ($e | said) != "" then .said = ($e | said) else . end) | track($e)
        elif $e | human then .last = $e | .said = ""
        elif $e | answers then .last = $e | track($e)
        else . end)
    | ([.open[] | . + {pending: ($now - (.at | seconds) | floor)}] | sort_by(-.pending)) as $open
    | ([$open[] | select(.agent == null and .pending > 60)]) as $stuck
    | if $r.status == "waiting" then
        ([$open[] | select(.name == "AskUserQuestion") | .input.questions[]?
          | "\(.question) [\([.options[]?.label] | join(" / "))]"] | join("\n")) as $ask
        | (if $r.statusUpdatedAt then ", since \($r.statusUpdatedAt / 1000 | floor | todate)" else "" end) as $when
        | "=== \($name)  \($cwd)  (waiting: \($r.waitingFor // "input")\($when))\n"
          + (if $ask != "" then $ask else ([($open | calls), .said[-900:]] | map(select(. != "")) | join("\n")) end) + "\n"
      elif $r.status != "busy" and ($stuck | length) > 0 then
        "=== \($name)  \($cwd)  PERMISSION PROMPT? (pending \($stuck[0].pending)s)\n\($stuck | calls)\n"
      elif $r.status != "busy" and .last.type == "assistant" and (.last | said) != ""
           and all(.last.message.content[]; .type != "tool_use") then
        "=== \($name)  \($cwd)  (last reply \(.last.timestamp))\n\(.said[-900:])\n"
      else empty end' ||
    echo "waiting.sh: could not read $transcript" >&2
done
