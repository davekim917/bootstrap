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

# session <pid> <id> <cwd> <name>
session() {
  printf '{"pid":%s,"sessionId":"%s","cwd":"%s","name":"%s","kind":"interactive"}\n' "$1" "$2" "$3" "$4" \
    > "$CLAUDE_CONFIG_DIR/sessions/$1.json"
}

# transcript <project> <id> <timestamp> <last type: assistant|user> <text>
transcript() {
  local f="$CLAUDE_CONFIG_DIR/projects/$1/$2.jsonl"
  printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"start"}}\n' "$3" > "$f"
  printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"tool_use","name":"Bash"}]}}\n' "$3" >> "$f"
  printf '{"type":"user","timestamp":"%s","message":{"content":[{"type":"tool_result","content":"x"}]}}\n' "$3" >> "$f"
  if [ "$4" = assistant ]; then
    printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$3" "$5" >> "$f"
  else
    printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"%s"}}\n' "$3" "$5" >> "$f"
  fi
  printf '{"type":"system","timestamp":"%s"}\n{"type":"assistant","timestamp":"%s",' "$3" "$3" >> "$f"
}

spawn; p_alpha=$pid
spawn; p_beta=$pid
spawn; p_holder=$pid
spawn; p_replied=$pid
spawn; p_stale=$pid
spawn dead; p_dead=$pid
session "$p_alpha" aaaa-1 /src/alpha alpha-session
session "$p_beta" bbbb-2 /src/beta ""
session "$p_holder" cccc-3 /src/alpha holder-session
session "$p_replied" dddd-4 /src/beta replied-session
session "$p_stale" eeee-5 /src/beta stale-session
session "$p_dead" ffff-6 /src/alpha dead-session
transcript -src-alpha aaaa-1 "$recent" assistant "Should I merge the alpha change?"
transcript -src-beta bbbb-2 "$recent" assistant "Beta needs a decision on the schema."
transcript -src-alpha cccc-3 "$recent" assistant "Holder question."
transcript -src-beta dddd-4 "$recent" user "Yes, go ahead."
transcript -src-beta eeee-5 2020-01-01T00:00:00Z assistant "Stale question."
transcript -src-alpha ffff-6 "$recent" assistant "Dead question."

# claim.sh
check "claim by a session with no holder" env CLAUDE_CODE_SESSION_ID=cccc-3 CLAUDE_PID="$p_holder" "$scripts/claim.sh"
check "state names the claimant" [ "$(jq -r .sessionId "$CLAUDE_CONFIG_DIR/anderton.json")" = cccc-3 ]
set +e
out=$(env CLAUDE_CODE_SESSION_ID=aaaa-1 CLAUDE_PID="$p_alpha" "$scripts/claim.sh" 2>&1)
status=$?
set -e
check "a second live session is refused with exit 3" [ "$status" -eq 3 ]
check "the refusal names the holder" grep -q "holder-session" <<EOF
$out
EOF
check "the holder re-claims" env CLAUDE_CODE_SESSION_ID=cccc-3 "$scripts/claim.sh"
check "pid resolved from the session file when CLAUDE_PID is unset" \
  [ "$(jq -r .pid "$CLAUDE_CONFIG_DIR/anderton.json")" = "$p_holder" ]
mkdir "$CLAUDE_CONFIG_DIR/anderton.json.lock"
echo "$p_dead" > "$CLAUDE_CONFIG_DIR/anderton.json.lock/pid"
check "a lock left by a dead claim is broken" env CLAUDE_CODE_SESSION_ID=cccc-3 "$scripts/claim.sh"
check "the lock is released" [ ! -e "$CLAUDE_CONFIG_DIR/anderton.json.lock" ]

# waiting.sh, with cccc-3 holding the role
out=$("$scripts/waiting.sh")
has() { grep -qF -- "$1" <<EOF
$out
EOF
}
check "lists a waiting session in the first project" has "=== alpha-session  /src/alpha"
check "lists a waiting session in the second project, named by id when unnamed" has "=== bbbb  /src/beta"
check "shows the tail of the last assistant text" has "Should I merge the alpha change?"
check "leaves out the Anderton's own session" eval '! has "Holder question."'
check "leaves out a session whose user replied last" eval '! has "replied-session"'
check "leaves out a turn older than two days" eval '! has "Stale question."'
check "leaves out a session whose process is gone" eval '! has "Dead question."'

[ "$failures" -eq 0 ] || { echo "$failures check(s) failed"; exit 1; }
echo "all checks passed"
