#!/usr/bin/env bash
# agy runs the tool when a PreToolUse hook exits 0 with empty output. This wrapper turns that, a crash, a non-zero exit,
# output that is not a decision, and a guard still running at the watchdog into a deny. The watchdog sits above the
# guard's one-hour approval wait; register the hook with a longer timeout.
WATCHDOG_SECONDS=3630

deny() {
    printf '{"decision":"deny","reason":"BLOCKED: %s"}' "$1"
    exit 0
}

here="$(cd "$(dirname "$0")" && pwd)" || deny 'The tool guard could not be located, so the call was not run.'
out="$(mktemp)" || deny 'The tool guard could not start, so the call was not run.'
trap 'rm -f "$out"' EXIT

# A background job in a non-interactive shell reads /dev/null unless given stdin explicitly.
exec 3<&0
bun "$here/agy-guard.ts" "$@" <&3 >"$out" &
guard=$!
exec 3<&-
(
    waited=0
    while kill -0 "$guard" 2>/dev/null; do
        if [ "$waited" -ge "$WATCHDOG_SECONDS" ]; then
            kill -9 "$guard" 2>/dev/null
            exit 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
) &
watchdog=$!
wait "$guard"
status=$?
kill "$watchdog" 2>/dev/null

# One whole line, as JSON.stringify prints it: a decision cut short is not one. The read and the print are builtins.
reply="$(<"$out")"
if [ "$status" -eq 0 ] && [[ "$reply" =~ ^\{\"decision\":\"allow\"\}$|^\{\"decision\":\"deny\",\"reason\":\".*\"\}$ ]]; then
    printf '%s' "$reply"
    exit 0
fi
deny "The tool guard did not finish with a decision (exit $status), so the call was not run. Tell the user; do not retry or work around it."
