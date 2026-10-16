# shellcheck shell=bash
# Sourced by claim.sh and waiting.sh. Bash 3.2 and BSD userland: POSIX ps fields only.

# Seconds since process $1 started, from POSIX `ps -o etime` ([[dd-]hh:]mm:ss); nothing when it is gone.
proc_age() {
  local t d=0 h=0 m s a b c
  t=$(ps -o etime= -p "$1" 2>/dev/null | tr -d ' ') || true
  case $t in '' | *[!0-9:-]*) return 0 ;; esac
  case $t in *-*) d=${t%%-*}; t=${t#*-} ;; esac
  IFS=: read -r a b c <<EOF
$t
EOF
  if [ -n "$c" ]; then h=$a m=$b s=$c; else m=$a s=$b; fi
  echo $(( ((10#$d * 24 + 10#$h) * 60 + 10#$m) * 60 + 10#$s ))
}

# True when pid $1 is running and started when the session registry says it did ($2, epoch ms).
# A registry file outlives a crashed session, and its pid can then belong to an unrelated process.
# ps, not kill -0: a sandboxed shell can be denied signalling a live process (EPERM).
registered_alive() {
  local age drift
  age=$(proc_age "$1")
  [ -n "$age" ] || return 1
  [ -n "$2" ] || return 0
  drift=$(( $(date +%s) - age - $2 / 1000 ))
  [ "$drift" -ge -60 ] && [ "$drift" -le 60 ]
}

# Without a ps that reports elapsed time (busybox ps, for one), every session would read as gone:
# no listing, and any claim would succeed. Refuse instead.
require_ps() {
  [ -n "$(proc_age $$)" ] || {
    echo "$1 needs a POSIX ps that supports: ps -o etime= -p <pid>" >&2
    exit 1
  }
}

home="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
sessions="$home/sessions"
holders="$home/anderton"
legacy_holder="$home/anderton.json"

# The pid of the session whose id is $1, from its registration file, or nothing.
session_pid() {
  local f
  for f in "$sessions"/*.json; do
    [ -e "$f" ] || continue
    if [ "$(jq -r '.sessionId // empty' "$f" 2>/dev/null)" = "$1" ]; then
      jq -r '.pid // empty' "$f"
      return
    fi
  done
}

# The project directory $1 belongs to: its repository's main worktree, so a session in a linked
# worktree shares the project of the checkout it came from; outside a repository, the directory.
project_root() {
  local common top
  if common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
    [ "${common##*/}" = .git ]; then
    dirname "$common"
  elif top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null); then
    printf '%s\n' "$top"
  else
    (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"
  fi
}

# The project of the calling Claude Code session: the cwd its registry entry records, else this shell's.
invoking_root() {
  local pid cwd=""
  pid="${CLAUDE_PID:-}"
  if [ -z "$pid" ] && [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then pid=$(session_pid "$CLAUDE_CODE_SESSION_ID"); fi
  if [ -n "$pid" ]; then cwd=$(jq -r '.cwd // empty' "$sessions/$pid.json" 2>/dev/null || true); fi
  project_root "${cwd:-$PWD}"
}

# The holder file for project $1. Percent-encoding only % and / keeps distinct roots distinct.
holder_path() {
  printf '%s/%s.json\n' "$holders" "$(printf '%s' "$1" | sed -e 's/%/%25/g' -e 's|/|%2F|g')"
}

# The record of project $1's holder: its own file, else the machine-wide file earlier versions
# wrote, while that holder's session belongs to this project. Prints the path, or nothing.
holder_record() {
  local f lpid lcwd
  f=$(holder_path "$1")
  if [ -f "$f" ]; then
    printf '%s\n' "$f"
    return
  fi
  [ -f "$legacy_holder" ] || return 0
  lpid=$(jq -r '.pid // empty' "$legacy_holder" 2>/dev/null || true)
  [ -n "$lpid" ] || return 0
  lcwd=$(jq -r '.cwd // empty' "$sessions/$lpid.json" 2>/dev/null || true)
  if [ -n "$lcwd" ] && [ "$(project_root "$lcwd")" = "$1" ]; then printf '%s\n' "$legacy_holder"; fi
}
