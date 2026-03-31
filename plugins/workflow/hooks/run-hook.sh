#!/bin/bash
# Minimal wrapper to run bundled JS hooks via node.
# Matches the pattern the SDK expects: a path-based command that receives stdin.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cat | node "$SCRIPT_DIR/$1"
