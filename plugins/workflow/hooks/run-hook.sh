#!/bin/bash
# Minimal wrapper to run TypeScript hooks via bun.
# Matches the pattern the SDK expects: a path-based command that receives stdin.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The hook runs in the project directory, where a .env or a bunfig.toml preload could switch a check off.
# Bun before 1.3.3 accepts --no-env-file and still loads the .env, so an older or unrecognised bun is refused. A canary
# or build suffix (1.4.2-canary.1, 1.4.2+abc) is read by its release number.
too_old='BLOCKED: The hook needs Bun 1.3.3 or newer, so the tool call was not run. Tell the user; do not retry or work around it.'
version="$(bun --version 2>/dev/null)" || { echo "$too_old" >&2; exit 2; }
[[ "$version" =~ ^([0-9]{1,9})\.([0-9]{1,9})\.([0-9]{1,9})([-+][0-9A-Za-z.+-]*)?$ ]] || { echo "$too_old" >&2; exit 2; }
major=$((10#${BASH_REMATCH[1]})) minor=$((10#${BASH_REMATCH[2]})) patch=$((10#${BASH_REMATCH[3]}))
(( major > 1 || (major == 1 && (minor > 3 || (minor == 3 && patch >= 3))) )) || { echo "$too_old" >&2; exit 2; }

cat | bun --no-env-file --config=/dev/null "$SCRIPT_DIR/$1"
