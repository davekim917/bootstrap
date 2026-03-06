#!/bin/bash
set -e

# PostToolUse formatter: runs Prettier on edited JS/TS files if available.

# Dependencies: jq for parsing; Prettier is optional (skips if not installed locally)
if ! command -v jq >/dev/null 2>&1; then
  # Silent skip to avoid breaking workflows on systems without jq
  exit 0
fi

HOOK_INPUT=$(cat)
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // ""')

# Get project directory reliably
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR=$(echo "$HOOK_INPUT" | jq -r '.cwd // empty')
fi
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(pwd)"
fi

case "$TOOL_NAME" in
  Edit|Write)
    FILE_PATHS=$(echo "$HOOK_INPUT" | jq -r '.tool_input.file_path // empty')
    ;;
  MultiEdit)
    FILE_PATHS=$(echo "$HOOK_INPUT" | jq -r '.tool_input.edits[].file_path // empty')
    ;;
  *)
    exit 0
    ;;
esac

# Detect local prettier binary without invoking network installs
PRETTIER_BIN=""
if command -v prettier >/dev/null 2>&1; then
  PRETTIER_BIN="prettier"
elif [ -x "$PROJECT_DIR/node_modules/.bin/prettier" ]; then
  PRETTIER_BIN="$PROJECT_DIR/node_modules/.bin/prettier"
elif [ -x "node_modules/.bin/prettier" ]; then
  PRETTIER_BIN="node_modules/.bin/prettier"
else
  # No local Prettier; skip gracefully
  exit 0
fi

format_file() {
  local f="$1"
  # Only format ts/tsx/js/jsx
  if echo "$f" | grep -E '\\.(ts|tsx|js|jsx)$' >/dev/null 2>&1; then
    "$PRETTIER_BIN" --write "$f" >/dev/null 2>&1 || true
  fi
}

for f in $FILE_PATHS; do
  [ -n "$f" ] && format_file "$f"
done

exit 0
