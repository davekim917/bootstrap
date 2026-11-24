#!/usr/bin/env bash
# agy runs the tool when a PreToolUse hook exits 0 with empty output. This wrapper turns that, a crash, a non-zero exit,
# output that is not a decision, and a wrapper still running at the watchdog into a deny. The watchdog sits above the
# guard's one-hour approval wait. agy's hook timeout defaults to 30 seconds and would cut this wrapper off first, so the
# registration must set "timeout" above WATCHDOG_SECONDS.
WATCHDOG_SECONDS=3630
# A caller's SHELLOPTS can switch these on, and errexit would end the wrapper at the first failure without a reply.
set +o errexit +o nounset +o pipefail

deny() {
    printf '{"decision":"deny","reason":"BLOCKED: %s"}' "$1"
    exit 0
}

here="$(cd "$(dirname "$0")" && pwd)" || deny 'The tool guard could not be located, so the call was not run.'

if [ "${1-}" != --guarded ]; then
    out="$(mktemp)" && work="$(mktemp)" || deny 'The tool guard could not start, so the call was not run.'
    trap 'rm -f "$out" "$work"' EXIT
    # One deadline over the version probe, the guard and the reply check. timeout keeps its own clock and kills the
    # whole process group; $SECONDS would take its starting value from the caller's environment.
    timeout -s KILL "$WATCHDOG_SECONDS" "$BASH" "$here/agy-guard.sh" --guarded "$work" "$@" >"$out"
    status=$?
    if [ "$status" -eq 0 ] && [ -s "$out" ]; then
        printf '%s' "$(<"$out")"
        exit 0
    fi
    deny "The tool guard did not finish with a decision (exit $status), so the call was not run. Tell the user; do not retry or work around it."
fi
work="$2"
shift 2

# bun ignores a flag it does not know, so a bun older than --no-env-file would load the agent's .env after all. Only a
# plain release number is compared; anything else (a launcher's banner, a canary tag) is refused rather than guessed at.
bun_version="$(bun --version 2>/dev/null)" || bun_version=""
if ! [[ $bun_version =~ ^([0-9]{1,9})\.([0-9]{1,9})\.([0-9]{1,9})$ ]] \
    || ! (( 10#${BASH_REMATCH[1]} > 1 || (10#${BASH_REMATCH[1]} == 1 && (10#${BASH_REMATCH[2]} > 3 || (10#${BASH_REMATCH[2]} == 3 && 10#${BASH_REMATCH[3]} >= 3))) )); then
    deny "bun is older than 1.3.3 or reports a version this guard cannot read, so the guard cannot keep the agent's .env out."
fi

# bun otherwise loads a .env and a bunfig.toml (with its preload) from the agent's working directory, which the agent
# controls: either could switch a check off or replace the guard.
# Kept in a file: command substitution would drop NUL bytes, turning malformed output into a reply that parses.
bun --no-env-file --config=/dev/null "$here/agy-guard.ts" "$@" >"$work"
status=$?

# Only a reply that parses as JSON and has agy's decision shape is forwarded; agy's handling of anything else is not
# something to rely on.
if [ "$status" -eq 0 ] && reply="$(bun --no-env-file --config=/dev/null "$here/guard-reply.ts" agy <"$work")" && [ -n "$reply" ]; then
    printf '%s' "$reply"
    exit 0
fi
deny "The tool guard did not finish with a decision (exit $status), so the call was not run. Tell the user; do not retry or work around it."
