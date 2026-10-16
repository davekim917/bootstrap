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

# Exits unless jq, git and a ps that reports elapsed time are present. Without git every worktree
# would be its own project, and without etime (busybox ps, for one) every session would read as gone,
# so any claim would succeed.
require_tools() {
  local tool missing=""
  for tool in jq git; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  if [ -n "$missing" ]; then
    echo "$1 needs:$missing. Install with brew or your package manager, and rerun." >&2
    exit 1
  fi
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

# The project directory $1 belongs to: its repository, named by the main checkout or, for a bare
# repository or a separate git dir, by the git dir itself, so every worktree of one repository shares
# a project. Outside a repository, the directory.
project_root() {
  local common top
  if common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    case $common in
      */.git) dirname "$common" ;;
      *) printf '%s\n' "$common" ;;
    esac
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

# A fixed-length file name for project root $1: the root itself can exceed the 255-byte limit on
# one path component. The record keeps the full root.
project_key() {
  printf '%s' "$1" | git hash-object --stdin
}

# The holder file for project $1.
holder_path() {
  printf '%s/%s.json\n' "$holders" "$(project_key "$1")"
}

# True when registry entry $1 is the live process that holder record $2 names. A pid alone would
# also match a later process given the same pid, so the start times must agree; a record written by
# an earlier version has none, and then the process must have started before the claim.
is_holder() {
  [ -f "$1" ] && [ -f "$2" ] || return 1
  jq -en --slurpfile reg "$1" --slurpfile rec "$2" '
    $reg[0] as $s | $rec[0] as $r
    | $s.pid == $r.pid
      and (if $s.startedAt == null then true
           elif $r.startedAt != null then ($s.startedAt | floor) == ($r.startedAt | floor)
           else (($r.claimedAt // "") | fromdateiso8601? // null) as $at | $at == null or $at * 1000 >= $s.startedAt
           end)' >/dev/null 2>&1 &&
    registered_alive "$(jq -r .pid "$1")" "$(jq -r '.startedAt // empty | floor' "$1")"
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
