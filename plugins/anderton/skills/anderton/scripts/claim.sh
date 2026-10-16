#!/usr/bin/env bash
# Claim the Anderton role for the calling Claude Code session.
# Exit 0: claimed (or already held by this session). Exit 3: held by another live session.
# Portable to macOS's bash 3.2 and BSD userland: macOS has no flock, so the lock is a directory.
set -euo pipefail
# shellcheck source=session-lib.sh
. "$(dirname "$0")/session-lib.sh"

command -v jq >/dev/null 2>&1 || {
  echo "claim.sh needs jq: install it (brew install jq, or your package manager) and rerun." >&2
  exit 1
}
require_ps claim.sh

home="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
sessions="$home/sessions"
state="${ANDERTON_STATE:-$home/anderton.json}"
sid="${CLAUDE_CODE_SESSION_ID:?not running inside a Claude Code session}"
force="${1:-}"

# The pid of the session whose id is $1, from its registration file, or nothing.
session_pid() {
  for f in "$sessions"/*.json; do
    [ -e "$f" ] || continue
    if [ "$(jq -r '.sessionId // empty' "$f" 2>/dev/null)" = "$1" ]; then
      jq -r '.pid // empty' "$f"
      return
    fi
  done
}

pid="${CLAUDE_PID:-$(session_pid "$sid")}"
if [ -z "$pid" ]; then
  echo "Cannot find the pid of session $sid under $sessions." >&2
  exit 1
fi

lock="$state.lock"
tries=0
until mkdir "$lock" 2>/dev/null; do
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    rm -rf "$lock"
    continue
  fi
  tries=$((tries + 1))
  if [ "$tries" -ge 50 ]; then
    echo "Could not take $lock within 10 seconds. If no other claim is running, remove it and rerun." >&2
    exit 1
  fi
  sleep 0.2
done
trap 'rm -rf "$lock"' EXIT
echo $$ > "$lock/pid"

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

if [ -f "$state" ] && [ "$force" != "--take-over" ]; then
  hpid=$(jq -r '.pid // empty' "$state" 2>/dev/null || true)
  hstart=$(jq -r '.startedAt // empty' "$state" 2>/dev/null || true)
  if [ -n "$hpid" ] && [ "$hpid" != "$pid" ] && holder_alive "$hpid" "$hstart"; then
    name=$(jq -r '.name // empty' "$sessions/$hpid.json" 2>/dev/null || true)
    hsid=$(jq -r '.sessionId // empty' "$sessions/$hpid.json" 2>/dev/null || true)
    echo "Anderton is held by live session '${name:-unknown}' (pid $hpid, session ${hsid:-unknown})."
    echo "Rerun with --take-over only if the user says so."
    exit 3
  fi
fi

jq -nc --argjson pid "$pid" --arg started "$(started_at "$pid")" --arg sid "$sid" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{pid: $pid, startedAt: ($started | tonumber? // null), sessionId: $sid, claimedAt: $at}' > "$state.tmp"
mv "$state.tmp" "$state"
echo "Anderton claimed by session $sid (pid $pid)."
