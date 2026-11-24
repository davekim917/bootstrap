#!/usr/bin/env bash
# Codex runs the tool when a PreToolUse hook times out, crashes or prints nothing, and it has no setting to block
# instead. This wrapper turns each of those into a deny: the guard's own decision passes through only when the guard
# exits 0 with a well-formed reply, and a wrapper still running at the watchdog is killed and denied, before Codex's hook
# timeout would fire. The watchdog sits above the guard's one-hour approval wait and below the manifest's timeout.
WATCHDOG_SECONDS=3630
# A caller's SHELLOPTS can switch these on, and errexit would end the wrapper at the first failure without a reply.
set +o errexit +o nounset +o pipefail

deny() {
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: %s"}}' "$1"
    exit 0
}

here="$(cd "$(dirname "$0")" && pwd)" || deny 'The command guard could not be located, so the command was not run.'

if [ "${1-}" != --guarded ]; then
    out="$(mktemp)" && work="$(mktemp)" || deny 'The command guard could not start, so the command was not run.'
    trap 'rm -f "$out" "$work"' EXIT
    # One deadline over the version probe, the guard and the reply check. timeout keeps its own clock and kills the
    # whole process group; $SECONDS would take its starting value from the caller's environment.
    timeout -s KILL "$WATCHDOG_SECONDS" "$BASH" "$here/codex-guard.sh" --guarded "$work" "$@" >"$out"
    status=$?
    if [ "$status" -eq 0 ] && [ -s "$out" ]; then
        printf '%s' "$(<"$out")"
        exit 0
    fi
    deny "The command guard did not finish (exit $status), so the command was not run. Tell the user; do not retry or work around it."
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
bun --no-env-file --config=/dev/null "$here/codex-guard.ts" "$@" >"$work"
status=$?

# Codex records a reply it cannot parse and runs the tool, so only one that parses and has a hook decision's shape is
# forwarded.
if [ "$status" -eq 0 ] && reply="$(bun --no-env-file --config=/dev/null "$here/guard-reply.ts" codex <"$work")" && [ -n "$reply" ]; then
    printf '%s' "$reply"
    exit 0
fi
deny "The command guard did not finish (exit $status), so the command was not run. Tell the user; do not retry or work around it."
