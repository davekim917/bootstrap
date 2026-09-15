#!/bin/bash
# Minimal wrapper to run TypeScript hooks via bun.
# Matches the pattern the SDK expects: a path-based command that receives stdin.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cat | bun "$SCRIPT_DIR/$1"
