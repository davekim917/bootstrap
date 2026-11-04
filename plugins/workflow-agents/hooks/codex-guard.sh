#!/usr/bin/env bash
# Codex runs the tool when a PreToolUse hook times out, crashes or prints nothing, and it has no setting to block
# instead. This wrapper turns each of those into a deny: the guard's own decision passes through only when the guard
# exits 0 with output, and a guard still running at the watchdog is killed and denied, before Codex's hook timeout
# would fire. The watchdog sits above the guard's one-hour approval wait and below the manifest's timeout.
WATCHDOG_SECONDS=3630

deny() {
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: %s"}}' "$1"
    exit 0
}

here="$(cd "$(dirname "$0")" && pwd)" || deny 'The command guard could not be located, so the command was not run.'
out="$(mktemp)" || deny 'The command guard could not start, so the command was not run.'
trap 'rm -f "$out"' EXIT

# A background job in a non-interactive shell reads /dev/null unless given stdin explicitly.
exec 3<&0
bun "$here/codex-guard.ts" "$@" <&3 >"$out" &
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

if [ "$status" -eq 0 ] && [ -s "$out" ]; then
    cat "$out"
    exit 0
fi
deny "The command guard did not finish (exit $status), so the command was not run. Tell the user; do not retry or work around it."
