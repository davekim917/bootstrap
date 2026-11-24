#!/usr/bin/env bash
# Codex runs the tool when a PreToolUse hook times out, crashes or prints nothing, and it has no setting to block
# instead. This wrapper turns each of those into a deny: the guard's own decision passes through only when the guard
# exits 0 with a well-formed reply, and a guard still running at the watchdog is killed and denied, before Codex's hook
# timeout would fire. The watchdog sits above the guard's one-hour approval wait and below the manifest's timeout.
WATCHDOG_SECONDS=3630

deny() {
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: %s"}}' "$1"
    exit 0
}

here="$(cd "$(dirname "$0")" && pwd)" || deny 'The command guard could not be located, so the command was not run.'
out="$(mktemp)" || deny 'The command guard could not start, so the command was not run.'
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
bun --no-env-file --config=/dev/null "$here/codex-guard.ts" "$@" <&3 >"$out" &
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

# Codex records a reply it cannot parse and runs the tool, so only one that parses and has a hook decision's shape is
# forwarded.
if [ "$status" -eq 0 ] && reply="$(bun --no-env-file --config=/dev/null "$here/guard-reply.ts" codex <"$out")" && [ -n "$reply" ]; then
    printf '%s' "$reply"
    exit 0
fi
deny "The command guard did not finish (exit $status), so the command was not run. Tell the user; do not retry or work around it."
