#!/bin/bash
set -euo pipefail

# SessionStart hook: disable all claude.ai MCP connectors that sync from the web UI.
# Local MCPs (exa, chrome-devtools) in ~/.claude.json mcpServers are unaffected.
#
# Configuration (optional):
#   Users can allowlist specific claude.ai MCPs they want to keep enabled.
#   Create a .local.md file with YAML frontmatter listing allowed MCPs:
#
#   ~/.claude/bootstrap-workflow.local.md        (global — applies to all projects)
#   <project>/.claude/bootstrap-workflow.local.md (project — overrides global)
#
#   ---
#   mcp_allow:
#     - "claude.ai Linear"
#     - "claude.ai Gmail"
#   ---
#
# Cascade: project-level config overrides global if present.

CLAUDE_JSON="$HOME/.claude.json"
[ ! -f "$CLAUDE_JSON" ] && exit 0

# Read the current working directory from hook stdin
CWD=$(jq -r '.cwd // empty' < /dev/stdin 2>/dev/null || true)
[ -z "$CWD" ] && exit 0

# ── Read allowlist from config cascade ────────────────────────────────────────

GLOBAL_CONFIG="$HOME/.claude/bootstrap-workflow.local.md"
PROJECT_CONFIG="$CWD/.claude/bootstrap-workflow.local.md"

# Extract mcp_allow entries from a .local.md file's YAML frontmatter.
# Reads lines between --- markers, extracts bare values from "  - " list items
# under the mcp_allow: key.
read_allowlist() {
    local file="$1"
    [ ! -f "$file" ] && return
    # Extract YAML frontmatter (between first two --- lines), then pull mcp_allow values
    sed -n '/^---$/,/^---$/p' "$file" \
        | sed -n '/^mcp_allow:/,/^[^ ]/p' \
        | grep '^  - ' \
        | sed 's/^  - *//; s/^"//; s/"$///; s/^'"'"'//; s/'"'"'$//'
}

# Project config overrides global if it contains mcp_allow
ALLOWLIST=""
if [ -f "$PROJECT_CONFIG" ] && grep -q '^mcp_allow:' "$PROJECT_CONFIG" 2>/dev/null; then
    ALLOWLIST=$(read_allowlist "$PROJECT_CONFIG")
elif [ -f "$GLOBAL_CONFIG" ] && grep -q '^mcp_allow:' "$GLOBAL_CONFIG" 2>/dev/null; then
    ALLOWLIST=$(read_allowlist "$GLOBAL_CONFIG")
fi

# Convert allowlist to a jq-friendly JSON array
ALLOW_JSON=$(echo "$ALLOWLIST" | jq -R -s 'split("\n") | map(select(. != ""))')

# ── Disable all claude.ai MCPs except allowlisted ones ────────────────────────

# Run jq and capture the list of disabled MCPs for the output message
RESULT=$(jq --arg cwd "$CWD" --argjson allow "$ALLOW_JSON" '
  # Find all claude.ai MCPs
  (.mcpServers | keys | map(select(startswith("claude.ai ")))) as $all_cloud |
  # Subtract allowlisted ones
  ($all_cloud - $allow) as $to_disable |
  # Merge into existing disabled list
  .projects[$cwd].disabledMcpServers = (
    (.projects[$cwd].disabledMcpServers // []) + $to_disable | unique
  ) |
  # Output the count for the status message
  { json: ., count: ($to_disable | length), allowed: ($allow | length) }
' "$CLAUDE_JSON")

# Write updated config
echo "$RESULT" | jq '.json' > "${CLAUDE_JSON}.tmp" && mv "${CLAUDE_JSON}.tmp" "$CLAUDE_JSON"

# Output status message (shown to user at session start)
DISABLED_COUNT=$(echo "$RESULT" | jq -r '.count')
ALLOWED_COUNT=$(echo "$RESULT" | jq -r '.allowed')

if [ "$DISABLED_COUNT" -gt 0 ] 2>/dev/null; then
    MSG="Disabled ${DISABLED_COUNT} claude.ai MCP connector(s)"
    if [ "$ALLOWED_COUNT" -gt 0 ] 2>/dev/null; then
        MSG="$MSG (${ALLOWED_COUNT} allowlisted)"
    fi
    MSG="$MSG. Configure: ~/.claude/bootstrap-workflow.local.md"
    echo "$MSG"
fi

exit 0
