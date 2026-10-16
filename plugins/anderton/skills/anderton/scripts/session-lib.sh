# shellcheck shell=bash
# Sourced by claim.sh and waiting.sh. Bash 3.2 and BSD userland: POSIX ps fields only.

# Seconds since process $1 started, from POSIX `ps -o etime` ([[dd-]hh:]mm:ss); nothing when it is gone.
proc_age() {
  local t d=0 h=0 m s a b c
  t=$(ps -o etime= -p "$1" 2>/dev/null | tr -d ' ') || true
  [ -n "$t" ] || return 0
  case $t in *-*) d=${t%%-*}; t=${t#*-} ;; esac
  IFS=: read -r a b c <<EOF
$t
EOF
  if [ -n "$c" ]; then h=$a m=$b s=$c; else m=$a s=$b; fi
  echo $(( ((10#$d * 24 + 10#$h) * 60 + 10#$m) * 60 + 10#$s ))
}

# True when pid $1 is running and started when the session registry says it did ($2, epoch ms).
# A registry file outlives a crashed session, and its pid can then belong to an unrelated process,
# so kill -0 alone is not proof. Without a recorded start time, kill -0 is all there is.
registered_alive() {
  local age drift
  kill -0 "$1" 2>/dev/null || return 1
  [ -n "$2" ] || return 0
  age=$(proc_age "$1")
  [ -n "$age" ] || return 1
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
