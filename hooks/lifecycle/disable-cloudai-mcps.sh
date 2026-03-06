#!/bin/bash
set -euo pipefail

# SessionStart hook: disable claude.ai MCP connectors that sync from the web UI.
# Local MCPs (exa, chrome-devtools) in ~/.claude.json mcpServers are unaffected.

CLAUDE_JSON="$HOME/.claude.json"
[ ! -f "$CLAUDE_JSON" ] && exit 0

# Read the current working directory from hook stdin
CWD=$(jq -r '.cwd // empty' < /dev/stdin 2>/dev/null || true)
[ -z "$CWD" ] && exit 0

# All claude.ai connectors to disable in Claude Code.
# Add or remove entries as needed.
CONNECTORS='[
  "claude.ai Canva",
  "claude.ai ChatPRD",
  "claude.ai Exa",
  "claude.ai Gmail",
  "claude.ai Google Calendar",
  "claude.ai Linear",
  "claude.ai Rube",
  "claude.ai Vercel"
]'

jq --arg cwd "$CWD" --argjson connectors "$CONNECTORS" '
  .projects[$cwd].disabledMcpServers = (
    (.projects[$cwd].disabledMcpServers // []) + $connectors | unique
  )
' "$CLAUDE_JSON" > "${CLAUDE_JSON}.tmp" && mv "${CLAUDE_JSON}.tmp" "$CLAUDE_JSON"

exit 0
