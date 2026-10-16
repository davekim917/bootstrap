#!/usr/bin/env bash
# Claim the Anderton role for the calling Claude Code session, in that session's project.
# Exit 0: claimed (or already held by this session). Exit 3: held by another live session in this project.
# Portable to macOS's bash 3.2 and BSD userland.
set -euo pipefail
# shellcheck source=SCRIPTDIR/session-lib.sh
. "$(dirname "$0")/session-lib.sh"

command -v jq >/dev/null 2>&1 || {
  echo "claim.sh needs jq: install it (brew install jq, or your package manager) and rerun." >&2
  exit 1
}
require_ps claim.sh

sid="${CLAUDE_CODE_SESSION_ID:?not running inside a Claude Code session}"
force="${1:-}"

pid="${CLAUDE_PID:-$(session_pid "$sid")}"
if [ -z "$pid" ]; then
  echo "Cannot find the pid of session $sid under $sessions." >&2
  exit 1
fi
root=$(invoking_root)
state=$(holder_path "$root")
mkdir -p "$holders"
lock="$state.lock"

# The claim lock is a directory, since macOS has no flock. Only the claim that made it removes it:
# deleting one whose owner looks dead races a concurrent claim that has just made a fresh one.
take_lock() {
  local tries=0 owner
  until mkdir "$lock" 2>/dev/null; do
    owner=$(cat "$lock/pid" 2>/dev/null || true)
    if [ -n "$owner" ] && [ -z "$(proc_age "$owner")" ]; then
      echo "$lock was left by claim process $owner, which is gone. Remove it and rerun." >&2
      exit 1
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 50 ]; then
      echo "Could not take $lock within 10 seconds. If no other claim is running, remove it and rerun." >&2
      exit 1
    fi
    sleep 0.2
  done
  trap 'rm -rf "$lock"' EXIT
  trap 'exit 1' INT TERM HUP
  echo $$ > "$lock/pid"
}
take_lock

# The holder is a Claude Code process, not a session id: /clear gives the same process a new
# session id. The registry's startedAt tells that process apart from a later one given its pid.
started_at() {
  jq -r '.startedAt // empty | floor' "$sessions/$1.json" 2>/dev/null || true
}

holder_alive() {
  local started
  [ -f "$sessions/$1.json" ] || return 1
  started=$(started_at "$1")
  { [ -z "$2" ] || [ "$started" = "$2" ]; } && registered_alive "$1" "$started"
}

record=$(holder_record "$root")
if [ -n "$record" ] && [ "$force" != "--take-over" ]; then
  hpid=$(jq -r '.pid // empty' "$record" 2>/dev/null || true)
  hstart=$(jq -r '.startedAt // empty' "$record" 2>/dev/null || true)
  if [ -n "$hpid" ] && [ "$hpid" != "$pid" ] && holder_alive "$hpid" "$hstart"; then
    name=$(jq -r '.name // empty' "$sessions/$hpid.json" 2>/dev/null || true)
    hsid=$(jq -r '.sessionId // empty' "$sessions/$hpid.json" 2>/dev/null || true)
    echo "Anderton for $root is held by live session '${name:-unknown}' (pid $hpid, session ${hsid:-unknown})."
    echo "Rerun with --take-over only if the user says so."
    exit 3
  fi
fi

jq -nc --arg root "$root" --argjson pid "$pid" --arg started "$(started_at "$pid")" --arg sid "$sid" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{root: $root, pid: $pid, startedAt: ($started | tonumber? // null), sessionId: $sid, claimedAt: $at}' > "$state.tmp"
mv "$state.tmp" "$state"
# The machine-wide file now speaks for no project, so nothing reads a stale holder from it.
if [ "$record" = "$legacy_holder" ]; then mv "$legacy_holder" "$legacy_holder.migrated"; fi
echo "Anderton for $root claimed by session $sid (pid $pid)."
