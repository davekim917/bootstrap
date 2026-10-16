#!/usr/bin/env bash
# Drives claim.sh and waiting.sh against a throwaway Claude Code home with sessions in two projects.
# Runs under macOS's bash 3.2 as well as Linux: bash plugins/anderton/test/scripts.test.sh
set -euo pipefail

scripts="$(cd "$(dirname "$0")/../skills/anderton/scripts" && pwd)"
work=$(mktemp -d "${TMPDIR:-/tmp}/anderton-test.XXXXXX")
sleepers=""
cleanup() {
  for p in $sleepers; do kill "$p" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

export CLAUDE_CONFIG_DIR="$work/claude"
unset ANDERTON_STATE CLAUDE_PID CLAUDE_CODE_SESSION_ID
mkdir -p "$CLAUDE_CONFIG_DIR/sessions" "$CLAUDE_CONFIG_DIR/projects/-src-alpha" "$CLAUDE_CONFIG_DIR/projects/-src-beta"

failures=0
check() { # check <description> <command...>
  local what=$1
  shift
  if "$@"; then echo "ok   $what"; else echo "FAIL $what"; failures=$((failures + 1)); fi
}

# Sets $pid to a process that stays alive until cleanup, or with "dead" to one that has exited.
# The dead one exits on its own: a signal can land before the fork execs, and that fork would run this
# shell's EXIT trap.
spawn() {
  if [ "${1:-}" = dead ]; then
    sleep 0 >/dev/null 2>&1 &
    pid=$!
    wait "$pid"
  else
    sleep 300 >/dev/null 2>&1 &
    pid=$!
    sleepers="$sleepers $pid"
  fi
}

recent=$(date -u +%Y-%m-%dT%H:%M:%SZ)
now_ms="$(date +%s)000"
long_ago_ms=1577836800000

# session <pid> <id> <cwd> <name> [startedAt ms, default now]
session() {
  printf '{"pid":%s,"startedAt":%s,"sessionId":"%s","cwd":"%s","name":"%s","kind":"interactive"}\n' \
    "$1" "${5:-$now_ms}" "$2" "$3" "$4" > "$CLAUDE_CONFIG_DIR/sessions/$1.json"
}

# transcript <project> <id> <timestamp> <last entry: assistant|user|user-blocks|harness|working> <text>
transcript() {
  {
    printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"start"}}\n' "$3"
    printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"tool_use","name":"Bash"}]}}\n' "$3"
    printf '{"type":"user","timestamp":"%s","message":{"content":[{"type":"tool_result","content":"x"}]}}\n' "$3"
    printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"text","text":"Earlier question."}]}}\n' "$3"
    case $4 in
      assistant) printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$3" "$5" ;;
      user) printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"%s"}}\n' "$3" "$5" ;;
      user-blocks) printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":[{"type":"text","text":"%s"},{"type":"image"}]}}\n' "$3" "$5" ;;
      working)
        printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"text","text":"%s"},{"type":"tool_use","name":"Bash"}]}}\n' "$3" "$5"
        printf '{"type":"user","timestamp":"%s","message":{"content":[{"type":"tool_result","content":"x"}]}}\n' "$3"
        ;;
      harness)
        printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$3" "$5"
        printf '{"type":"user","isMeta":true,"timestamp":"%s","message":{"role":"user","content":"Base directory for this skill"}}\n' "$3"
        printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"<task-notification>\\n<status>failed</status>\\n</task-notification>"}}\n' "$3"
        printf '{"type":"user","isSidechain":true,"timestamp":"%s","message":{"role":"user","content":"sub-agent brief"}}\n' "$3"
        ;;
    esac
    printf '{"type":"system","timestamp":"%s"}\n{"type":"assistant","timestamp":"%s",' "$3" "$3"
  } > "$CLAUDE_CONFIG_DIR/projects/$1/$2.jsonl"
}

spawn; p_alpha=$pid
spawn; p_beta=$pid
spawn; p_holder=$pid
spawn; p_replied=$pid
spawn; p_blocks=$pid
spawn; p_stale=$pid
spawn; p_harness=$pid
spawn; p_reused=$pid
spawn; p_working=$pid
spawn dead; p_dead=$pid
session "$p_alpha" aaaa-1 /src/alpha alpha-session
session "$p_beta" bbbb-2 /src/beta ""
session "$p_holder" cccc-3 /src/alpha holder-session
session "$p_replied" dddd-4 /src/beta replied-session
session "$p_blocks" gggg-7 /src/beta blocks-session
session "$p_stale" eeee-5 /src/beta stale-session
session "$p_dead" ffff-6 /src/alpha dead-session
session "$p_harness" hhhh-8 /src/alpha harness-session
session "$p_reused" iiii-9 /src/beta reused-session "$long_ago_ms"
session "$p_working" jjjj-0 /src/beta working-session
# pid 1 belongs to root, so a non-root kill -0 gets EPERM, as a sandboxed shell does for a peer.
# shellcheck source=SCRIPTDIR/../skills/anderton/scripts/session-lib.sh
. "$scripts/session-lib.sh"
session 1 kkkk-1 /src/alpha unsignalled-session "$(( $(date +%s) - $(proc_age 1) ))000"
transcript -src-alpha aaaa-1 "$recent" assistant "Should I merge the alpha change?"
transcript -src-beta bbbb-2 "$recent" assistant "Beta needs a decision on the schema."
transcript -src-alpha cccc-3 "$recent" assistant "Holder question."
transcript -src-beta dddd-4 "$recent" user "Yes, go ahead."
transcript -src-beta gggg-7 "$recent" user-blocks "Here is the screenshot."
transcript -src-beta eeee-5 2020-01-01T00:00:00Z assistant "Stale question."
transcript -src-alpha ffff-6 "$recent" assistant "Dead question."
transcript -src-alpha hhhh-8 "$recent" harness "Question before harness records."
transcript -src-beta iiii-9 "$recent" assistant "Question from a crashed session."
transcript -src-beta jjjj-0 "$recent" working "Running the build now."
transcript -src-alpha kkkk-1 "$recent" assistant "Question from a session this shell cannot signal."

state="$CLAUDE_CONFIG_DIR/anderton.json"
claim_status() { # claim_status <session id> <pid> [args...]: sets $out and $status
  local id=$1 p=$2
  shift 2
  set +e
  out=$(env CLAUDE_CODE_SESSION_ID="$id" CLAUDE_PID="$p" "$scripts/claim.sh" "$@" 2>&1)
  status=$?
  set -e
}

# claim.sh
check "claim by a session with no holder" env CLAUDE_CODE_SESSION_ID=cccc-3 CLAUDE_PID="$p_holder" "$scripts/claim.sh"
check "state names the claiming process" [ "$(jq -r '"\(.pid) \(.startedAt) \(.sessionId)"' "$state")" = "$p_holder $now_ms cccc-3" ]
claim_status aaaa-1 "$p_alpha"
check "a second live session is refused with exit 3" [ "$status" -eq 3 ]
check "the refusal names the holder" grep -q "holder-session" <<EOF
$out
EOF
check "the holder re-claims, its pid read from the registry when CLAUDE_PID is unset" \
  env CLAUDE_CODE_SESSION_ID=cccc-3 "$scripts/claim.sh"
check "the re-claim records the same pid" [ "$(jq -r .pid "$state")" = "$p_holder" ]
mkdir "$state.lock"
echo "$p_dead" > "$state.lock/pid"
check "a lock left by a dead claim is broken" env CLAUDE_CODE_SESSION_ID=cccc-3 "$scripts/claim.sh"
check "the lock is released" [ ! -e "$state.lock" ]

# /clear: the holder's process keeps its pid and gets a new session id and transcript.
session "$p_holder" cccc-9 /src/alpha holder-session
transcript -src-alpha cccc-9 "$recent" assistant "Holder question after clear."
claim_status aaaa-1 "$p_alpha"
check "after the holder runs /clear, a second session is still refused" [ "$status" -eq 3 ]

# waiting.sh, with the cleared holder process holding the role
out=$("$scripts/waiting.sh")
has() { grep -qF -- "$1" <<EOF
$out
EOF
}
check "lists a waiting session in the first project" has "=== alpha-session  /src/alpha"
check "lists a waiting session in the second project, named by id when unnamed" has "=== bbbb  /src/beta"
check "shows the tail of the last assistant text" has "Should I merge the alpha change?"
check "leaves out the Anderton's own session, after /clear too" eval '! has "Holder question after clear."'
check "leaves out a session whose user replied last" eval '! has "replied-session"'
check "leaves out a session whose user replied with text and an image" eval '! has "blocks-session"'
check "leaves out a turn older than two days" eval '! has "Stale question."'
check "leaves out a session whose process is gone" eval '! has "Dead question."'
check "skill loads, task notifications and sidechains are not replies" has "Question before harness records."
check "leaves out a stale registry entry whose pid now runs another process" eval '! has "Question from a crashed session."'
check "leaves out a session whose last assistant record is a tool call" eval '! has "working-session"'
check "lists a live session this shell may not signal" has "=== unsignalled-session"

check "the cleared holder re-claims under its new session id" env CLAUDE_CODE_SESSION_ID=cccc-9 "$scripts/claim.sh"

# A holder whose pid now belongs to a later Claude Code process no longer holds the role.
jq -c '.startedAt = 1' "$state" > "$state.tmp" && mv "$state.tmp" "$state"
claim_status bbbb-2 "$p_beta"
check "a holder pid reused by a later session does not block a claim" [ "$status" -eq 0 ]

# A holder that crashed leaves its registry file; its pid now runs an unrelated process.
jq -nc --argjson pid "$p_reused" --argjson started "$long_ago_ms" '{pid: $pid, startedAt: $started, sessionId: "iiii-9"}' > "$state"
claim_status bbbb-2 "$p_beta"
check "a crashed holder whose pid was reused does not block a claim" [ "$status" -eq 0 ]

[ "$failures" -eq 0 ] || { echo "$failures check(s) failed"; exit 1; }
echo "all checks passed"
