#!/usr/bin/env bash
# agy runs the tool when a PreToolUse hook exits 0 with empty output. This wrapper turns that, a crash, a non-zero exit,
# output that is not a decision, and a guard still running at the watchdog into a deny. The watchdog sits above the
# guard's one-hour approval wait. agy's hook timeout defaults to 30 seconds and would cut this wrapper off first, so the
# registration must set "timeout" above WATCHDOG_SECONDS.
WATCHDOG_SECONDS=3630

deny() {
    printf '{"decision":"deny","reason":"BLOCKED: %s"}' "$1"
    exit 0
}

here="$(cd "$(dirname "$0")" && pwd)" || deny 'The tool guard could not be located, so the call was not run.'
out="$(mktemp)" || deny 'The tool guard could not start, so the call was not run.'
trap 'rm -f "$out"' EXIT
# bun ignores a flag it does not know, so a bun older than --no-env-file would load the agent's .env after all.
bun_version="$(bun --version 2>/dev/null)" || bun_version=""
bun_version="${bun_version//[!0-9A-Za-z.+-]/}"
case $bun_version in
    '' | 0.* | 1.[0-2].* | 1.3.[0-2] | 1.3.[0-2][!0-9]*) deny "bun ${bun_version:-(missing)} is older than 1.3.3, so the guard cannot keep the agent's .env out." ;;
esac

# A background job in a non-interactive shell reads /dev/null unless given stdin explicitly.
exec 3<&0
# bun otherwise loads a .env and a bunfig.toml (with its preload) from the agent's working directory, which the agent
# controls: either could switch a check off or replace the guard.
bun --no-env-file --config=/dev/null "$here/agy-guard.ts" "$@" <&3 >"$out" &
guard=$!
exec 3<&-
# Timed by the clock since this wrapper started, which is what the host's timeout measures, not by counting sleeps.
(
    while kill -0 "$guard" 2>/dev/null; do
        if [ "$SECONDS" -ge "$WATCHDOG_SECONDS" ]; then
            kill -9 "$guard" 2>/dev/null
            exit 0
        fi
        sleep 1
    done
) &
watchdog=$!
wait "$guard"
status=$?
kill "$watchdog" 2>/dev/null

# Only a reply that parses as JSON and has agy's decision shape is forwarded; agy's handling of anything else is not
# something to rely on.
if [ "$status" -eq 0 ] && reply="$(bun --no-env-file --config=/dev/null "$here/guard-reply.ts" agy <"$out")" && [ -n "$reply" ]; then
    printf '%s' "$reply"
    exit 0
fi
deny "The tool guard did not finish with a decision (exit $status), so the call was not run. Tell the user; do not retry or work around it."
