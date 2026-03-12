#!/bin/bash
# Generic TypeScript hook runner for plugin context
# Usage: run-ts-hook.sh <path-to-ts-file>
#
# This single runner replaces individual .sh wrappers for TypeScript hooks.
# All TypeScript hooks can use shared libs via relative imports.

set -e

if [ -z "$1" ]; then
    echo "ERROR: No TypeScript file specified" >&2
    echo "Usage: run-ts-hook.sh <path-to-ts-file>" >&2
    exit 1
fi

# Security: Validate hook path is relative and contains no path traversal
if [[ "$1" == /* ]] || [[ "$1" == *..* ]]; then
    echo "ERROR: Hook path must be relative and cannot contain '..'" >&2
    exit 1
fi

# Resolve hooks directory from this script's own location (works regardless of PLUGIN_ROOT)
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Security: Validate the file exists
HOOK_FILE="$HOOKS_DIR/$1"
if [ ! -f "$HOOK_FILE" ]; then
    echo "ERROR: Hook file does not exist: $1" >&2
    exit 1
fi

if ! command -v bun &> /dev/null; then
    echo "ERROR: Required command 'bun' not found" >&2
    echo "Install with: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
fi

cd "$HOOKS_DIR"
cat | bun "$HOOK_FILE"
