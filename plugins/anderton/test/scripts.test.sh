#!/usr/bin/env bash
# Drives claim.sh and waiting.sh against a throwaway Claude Code home with sessions in two projects.
# Runs under macOS's bash 3.2 as well as Linux: bash plugins/anderton/test/scripts.test.sh
set -euo pipefail

scripts="$(cd "$(dirname "$0")/../skills/anderton/scripts" && pwd)"
work=$(mktemp -d "${TMPDIR:-/tmp}/anderton-test.XXXXXX")
work=$(cd "$work" && pwd -P)
sleepers=""
cleanup() {
  for p in $sleepers; do kill "$p" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

export CLAUDE_CONFIG_DIR="$work/claude"
unset CLAUDE_PID CLAUDE_CODE_SESSION_ID
mkdir -p "$CLAUDE_CONFIG_DIR/sessions" "$CLAUDE_CONFIG_DIR/projects/p" "$work/beta"

# Project alpha is a repository with a linked worktree; project beta is a plain directory.
alpha="$work/alpha"
git init -q "$alpha"
git -C "$alpha" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m init
git -C "$alpha" worktree add -q "$work/alpha-wt" 2>/dev/null
beta="$work/beta"
# Project gamma is a bare repository with two worktrees and no main checkout.
gamma="$work/gamma.git"
git init -q --bare "$gamma"
git -C "$alpha" push -q "$gamma" HEAD:refs/heads/main 2>/dev/null
git -C "$gamma" worktree add -q "$work/gamma-a" main 2>/dev/null
git -C "$gamma" worktree add -q -b other "$work/gamma-b" main 2>/dev/null

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

iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
now_s=$(date +%s)
recent=$(iso "$now_s")
five_min_ago=$(iso $((now_s - 300)))
now_ms="${now_s}000"
long_ago_ms=1577836800000

# session <pid> <id> <cwd> <name> [startedAt ms, default now]
session() {
  printf '{"pid":%s,"startedAt":%s,"sessionId":"%s","cwd":"%s","name":"%s","kind":"interactive"}\n' \
    "$1" "${5:-$now_ms}" "$2" "$3" "$4" > "$CLAUDE_CONFIG_DIR/sessions/$1.json"
}

# registry <pid> <status> [waitingFor]: set a registry entry's status as Claude Code does.
registry() {
  local f="$CLAUDE_CONFIG_DIR/sessions/$1.json"
  jq -c --arg status "$2" --arg why "${3:-}" --argjson at "$now_ms" \
    '.status = $status | .statusUpdatedAt = $at | if $why != "" then .waitingFor = $why else . end' "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
}

# transcript <id> <timestamp> <last entry: assistant|user|user-blocks|harness|working|asking|calling> <text>
transcript() {
  {
    printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"start"}}\n' "$2"
    printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"tool_use","id":"t0","name":"Bash"}]}}\n' "$2"
    printf '{"type":"user","timestamp":"%s","message":{"content":[{"type":"tool_result","tool_use_id":"t0","content":"x"}]}}\n' "$2"
    printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"text","text":"Earlier question."}]}}\n' "$2"
    case $3 in
      assistant) printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$2" "$4" ;;
      user) printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"%s"}}\n' "$2" "$4" ;;
      user-blocks) printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":[{"type":"text","text":"%s"},{"type":"image"}]}}\n' "$2" "$4" ;;
      harness)
        printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$2" "$4"
        printf '{"type":"user","isMeta":true,"timestamp":"%s","message":{"role":"user","content":"Base directory for this skill"}}\n' "$2"
        printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"<task-notification>\\n<status>failed</status>\\n</task-notification>"}}\n' "$2"
        printf '{"type":"user","isSidechain":true,"timestamp":"%s","message":{"role":"user","content":"sub-agent brief"}}\n' "$2"
        ;;
      working)
        printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"text","text":"%s"},{"type":"tool_use","id":"t1","name":"Bash"}]}}\n' "$2" "$4"
        printf '{"type":"user","timestamp":"%s","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"x"}]}}\n' "$2"
        ;;
      asking)
        printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$2" "$4"
        printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"tool_use","id":"t2","name":"AskUserQuestion","input":{"questions":[{"question":"Ship it today?","options":[{"label":"Yes"},{"label":"No"}]}]}}]}}\n' "$2"
        ;;
      calling)
        printf '{"type":"assistant","timestamp":"%s","message":{"content":[{"type":"tool_use","id":"t3","name":"Bash","input":{"command":"%s"}}]}}\n' "$2" "$4"
        ;;
    esac
    printf '{"type":"system","timestamp":"%s"}\n{"type":"assistant","timestamp":"%s",' "$2" "$2"
  } > "$CLAUDE_CONFIG_DIR/projects/p/$1.jsonl"
}

# Project alpha: the repository and its linked worktree.
spawn; p_alpha=$pid;    session "$p_alpha" aaaa-1 "$alpha" alpha-session
spawn; p_holder=$pid;   session "$p_holder" cccc-3 "$alpha" holder-session
spawn; p_wt=$pid;       session "$p_wt" wwww-1 "$work/alpha-wt" worktree-session
spawn; p_harness=$pid;  session "$p_harness" hhhh-8 "$alpha" harness-session
spawn; p_asking=$pid;   session "$p_asking" llll-2 "$alpha" asking-session
spawn; p_subagent=$pid; session "$p_subagent" mmmm-3 "$alpha" subagent-session
spawn; p_prompt=$pid;   session "$p_prompt" nnnn-4 "$alpha" prompt-session
spawn; p_running=$pid;  session "$p_running" oooo-5 "$alpha" running-session
spawn; p_busy=$pid;     session "$p_busy" qqqq-6 "$alpha" busy-session
spawn; p_writing=$pid;  session "$p_writing" rrrr-7 "$alpha" writing-session
spawn; p_gamma_a=$pid;  session "$p_gamma_a" gaaa-1 "$work/gamma-a" gamma-a-session
spawn; p_gamma_b=$pid;  session "$p_gamma_b" gbbb-2 "$work/gamma-b" gamma-b-session
# Project beta: a plain directory.
spawn; p_beta=$pid;     session "$p_beta" bbbb-2 "$beta" ""
spawn; p_replied=$pid;  session "$p_replied" dddd-4 "$beta" replied-session
spawn; p_blocks=$pid;   session "$p_blocks" gggg-7 "$beta" blocks-session
spawn; p_stale=$pid;    session "$p_stale" eeee-5 "$beta" stale-session
spawn; p_reused=$pid;   session "$p_reused" iiii-9 "$beta" reused-session "$long_ago_ms"
spawn; p_working=$pid;  session "$p_working" jjjj-0 "$beta" working-session
spawn dead; p_dead=$pid; session "$p_dead" ffff-6 "$beta" dead-session
# pid 1 belongs to root, so a non-root kill -0 gets EPERM, as a sandboxed shell does for a peer.
# shellcheck source=SCRIPTDIR/../skills/anderton/scripts/session-lib.sh
. "$scripts/session-lib.sh"
session 1 kkkk-1 "$beta" unsignalled-session "$(( $(date +%s) - $(proc_age 1) ))000"

registry "$p_asking" waiting "input needed"
registry "$p_subagent" waiting "permission prompt"
registry "$p_busy" busy
registry "$p_writing" busy

transcript aaaa-1 "$recent" assistant "Should I merge the alpha change?"
transcript cccc-3 "$recent" assistant "Holder question."
transcript wwww-1 "$recent" assistant "Question from the worktree."
transcript hhhh-8 "$recent" harness "Question before harness records."
transcript llll-2 "$recent" asking "Two options for the release."
transcript mmmm-3 "$recent" assistant "Sub-agent is checking the branch."
mkdir -p "$CLAUDE_CONFIG_DIR/projects/p/mmmm-3/subagents"
printf '{"type":"assistant","isSidechain":true,"timestamp":"%s","message":{"content":[{"type":"tool_use","id":"s1","name":"Bash","input":{"command":"git push --force"}}]}}\n' \
  "$recent" > "$CLAUDE_CONFIG_DIR/projects/p/mmmm-3/subagents/agent-x1.jsonl"
transcript nnnn-4 "$five_min_ago" calling "rm -rf build"
transcript oooo-5 "$recent" calling "pnpm test"
transcript qqqq-6 "$five_min_ago" calling "sleep 600"
transcript rrrr-7 "$recent" assistant "Next I will run the tests."
transcript gaaa-1 "$recent" assistant "Question from gamma's first worktree."
transcript gbbb-2 "$recent" assistant "Question from gamma's second worktree."
transcript kkkk-1 "$recent" assistant "Question from a session this shell cannot signal."
transcript bbbb-2 "$recent" assistant "Beta needs a decision on the schema."
transcript dddd-4 "$recent" user "Yes, go ahead."
transcript gggg-7 "$recent" user-blocks "Here is the screenshot."
transcript eeee-5 2020-01-01T00:00:00Z assistant "Stale question."
transcript iiii-9 "$recent" assistant "Question from a crashed session."
transcript jjjj-0 "$recent" working "Running the build now."
transcript ffff-6 "$recent" assistant "Dead question."

state=$(holder_path "$alpha")
claim_status() { # claim_status <session id> <pid> [args...]: sets $out and $status
  local id=$1 p=$2
  shift 2
  set +e
  out=$(env CLAUDE_CODE_SESSION_ID="$id" CLAUDE_PID="$p" "$scripts/claim.sh" "$@" 2>&1)
  status=$?
  set -e
}
contains() { grep -qF -- "$1" <<EOF
$out
EOF
}

# A holder left by an earlier version in the machine-wide file still holds its project.
printf '{"pid":%s,"sessionId":"cccc-3","claimedAt":"%s"}\n' "$p_holder" "$recent" > "$CLAUDE_CONFIG_DIR/anderton.json"
claim_status aaaa-1 "$p_alpha"
check "a holder in the machine-wide file of earlier versions still holds its project" [ "$status" -eq 3 ]
check "the refusal names the holder and the project" contains "Anderton for $alpha is held by live session 'holder-session'"
claim_status bbbb-2 "$p_beta"
check "it does not hold another project" [ "$status" -eq 0 ]
check "the other project's holder is recorded in its own file" [ "$(jq -r .sessionId "$(holder_path "$beta")")" = bbbb-2 ]
check "the machine-wide file is left alone by another project's claim" [ -f "$CLAUDE_CONFIG_DIR/anderton.json" ]

# claim.sh in project alpha
check "the holder re-claims, its pid read from the registry when CLAUDE_PID is unset" \
  env CLAUDE_CODE_SESSION_ID=cccc-3 "$scripts/claim.sh"
check "the claim moves the holder into the project's own file" \
  [ "$(jq -r '"\(.root) \(.pid) \(.startedAt) \(.sessionId)"' "$state")" = "$alpha $p_holder $now_ms cccc-3" ]
check "the machine-wide file is retired" [ ! -e "$CLAUDE_CONFIG_DIR/anderton.json" ]
claim_status wwww-1 "$p_wt"
check "a session in a linked worktree of the same repository is refused" [ "$status" -eq 3 ]
mkdir "$state.lock"
echo "$p_dead" > "$state.lock/pid"
claim_status cccc-3 "$p_holder"
check "a lock left by a dead claim stops the claim" [ "$status" -eq 1 ]
check "that lock is not deleted" [ -d "$state.lock" ]
check "the report names the lock to remove" contains "was left by claim process $p_dead"
rm -f "$state.lock/pid"
rmdir "$state.lock"
check "the holder claims once the lock is removed" env CLAUDE_CODE_SESSION_ID=cccc-3 "$scripts/claim.sh"
check "the lock is released" [ ! -e "$state.lock" ]

# /clear: the holder's process keeps its pid and gets a new session id and transcript.
session "$p_holder" cccc-9 "$alpha" holder-session
transcript cccc-9 "$recent" assistant "Holder question after clear."
claim_status aaaa-1 "$p_alpha"
check "after the holder runs /clear, a second session is still refused" [ "$status" -eq 3 ]

# waiting.sh, called from project alpha, with the cleared holder process holding alpha
out=$(env CLAUDE_PID="$p_alpha" "$scripts/waiting.sh")
check "lists a waiting session in the caller's project" contains "=== alpha-session  $alpha"
check "shows the tail of the last assistant text" contains "Should I merge the alpha change?"
check "counts a linked worktree as the same project" contains "=== worktree-session"
check "leaves out another project by default" eval '! contains "Beta needs a decision"'
check "leaves out the project's Anderton, after /clear too" eval '! contains "Holder question after clear."'
check "skill loads, task notifications and sidechains are not replies" contains "Question before harness records."
check "lists a session blocked on AskUserQuestion, with its question" contains "Ship it today? [Yes / No]"
check "names what an AskUserQuestion session waits for" contains "=== asking-session  $alpha  (waiting: input needed"
check "shows a sub-agent's open call when the registry says it waits on a prompt" \
  contains "[sub-agent agent-x1] Bash (pending"
check "names what a permission-prompt session waits for" contains "=== subagent-session  $alpha  (waiting: permission prompt"
check "flags a tool call unanswered for over a minute as a likely permission prompt" \
  contains "=== prompt-session  $alpha  PERMISSION PROMPT? (pending 3"
check "shows that call's tool and input" contains 'Bash (pending 3'
check "shows the input text" contains '{"command":"rm -rf build"}'
check "does not flag a tool call made seconds ago" eval '! contains "running-session"'
check "does not flag a long call when the registry says the session is busy" eval '! contains "busy-session"'
check "does not list a busy session whose newest block is text" eval '! contains "writing-session"'

out=$(env CLAUDE_PID="$p_alpha" "$scripts/waiting.sh" --all)
check "--all lists other projects, a session named by id when unnamed" contains "=== bbbb  $beta"
check "--all still flags permission prompts" contains "PERMISSION PROMPT? (pending"
check "--all still leaves out the caller's Anderton" eval '! contains "Holder question after clear."'
check "leaves out a session whose user replied last" eval '! contains "replied-session"'
check "leaves out a session whose user replied with text and an image" eval '! contains "blocks-session"'
check "leaves out a turn older than two days" eval '! contains "Stale question."'
check "leaves out a session whose process is gone" eval '! contains "Dead question."'
check "leaves out a stale registry entry whose pid now runs another process" eval '! contains "Question from a crashed session."'
check "leaves out a session whose last assistant record is a tool call" eval '! contains "working-session"'
check "lists a live session this shell may not signal" contains "=== unsignalled-session"

out=$(env CLAUDE_PID="$p_beta" "$scripts/waiting.sh")
check "from project beta, lists beta's sessions" contains "=== unsignalled-session  $beta"
check "from project beta, leaves out beta's own Anderton" eval '! contains "Beta needs a decision"'
check "from project beta, leaves out alpha" eval '! contains "alpha-session"'

claim_status gaaa-1 "$p_gamma_a"
check "a worktree of a bare repository claims for the repository" [ "$status" -eq 0 ]
claim_status gbbb-2 "$p_gamma_b"
check "another worktree of the same bare repository is refused" [ "$status" -eq 3 ]
out=$(env CLAUDE_PID="$p_gamma_a" "$scripts/waiting.sh")
check "lists the other worktree of a bare repository as the same project" contains "Question from gamma's second worktree."

check "the cleared holder re-claims under its new session id" env CLAUDE_CODE_SESSION_ID=cccc-9 "$scripts/claim.sh"

# A holder whose pid now belongs to a later Claude Code process no longer holds the role.
jq -c '.startedAt = 1' "$state" > "$state.tmp" && mv "$state.tmp" "$state"
claim_status aaaa-1 "$p_alpha"
check "a holder pid reused by a later session does not block a claim" [ "$status" -eq 0 ]

# A holder that crashed leaves its registry file; its pid now runs an unrelated process.
session "$p_reused" iiii-9 "$alpha" reused-session "$long_ago_ms"
jq -nc --argjson pid "$p_reused" --argjson started "$long_ago_ms" '{pid: $pid, startedAt: $started, sessionId: "iiii-9"}' > "$state"
claim_status wwww-1 "$p_wt"
check "a crashed holder whose pid was reused does not block a claim" [ "$status" -eq 0 ]

# A record from an earlier version has no start time; a later process given its pid is not the holder.
mkdir "$work/delta"
spawn; p_delta=$pid;  session "$p_delta" dlta-1 "$work/delta" delta-reused
spawn; p_delta2=$pid; session "$p_delta2" dlta-2 "$work/delta" delta-claimant
printf '{"pid":%s,"sessionId":"gone-1","claimedAt":"%s"}\n' "$p_delta" "$five_min_ago" > "$CLAUDE_CONFIG_DIR/anderton.json"
claim_status dlta-2 "$p_delta2"
check "a pid from an earlier version's record, now running a later process, does not block a claim" [ "$status" -eq 0 ]

# A project root too long to be one file name still gets a holder file.
long="$work/$(printf 'l%.0s' {1..120})/$(printf 'm%.0s' {1..120})/$(printf 'n%.0s' {1..120})"
mkdir -p "$long"
spawn; p_long=$pid; session "$p_long" long-1 "$long" long-session
claim_status long-1 "$p_long"
check "a project whose root is longer than a file name can be claimed" [ "$status" -eq 0 ]
check "its record keeps the full root" [ "$(jq -r .root "$(holder_path "$long")")" = "$long" ]

# Without git, worktrees of one repository would be separate projects: refuse instead.
nogit="$work/nogit"
mkdir "$nogit"
for t in jq ps tr dirname; do ln -s "$(command -v "$t")" "$nogit/$t"; done
set +e
out=$(env PATH="$nogit" "$BASH" "$scripts/waiting.sh" 2>&1)
status=$?
set -e
check "refuses to run without git" [ "$status" -eq 1 ]
check "says git is missing" contains "needs: git."

[ "$failures" -eq 0 ] || { echo "$failures check(s) failed"; exit 1; }
echo "all checks passed"
