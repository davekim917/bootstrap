#!/usr/bin/env bash
# agy runs the tool when a PreToolUse hook exits 0 with empty output, so every failure must end in a deny.
# agy-supervisor.ts owns everything after the exec; this file only starts bun without the caller's shell startup
# settings. SHELLOPTS and BASHOPTS are read-only in a bash that inherited them, so the supervisor drops them for the guard.
unset BASH_ENV ENV CDPATH GLOBIGNORE
shopt -s execfail
case $0 in */*) dir=${0%/*} ;; *) dir=. ;; esac
here="$(cd -- "$dir" && pwd -P)" && exec bun --no-env-file --config=/dev/null "$here/agy-supervisor.ts" "$@"
printf '%s' '{"decision":"deny","reason":"BLOCKED: The tool guard could not start (bun is missing or would not run), so the call was not run. Tell the user; do not retry or work around it."}'
