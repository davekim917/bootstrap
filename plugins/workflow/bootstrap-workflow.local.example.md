---
# Bootstrap Workflow Plugin — User Configuration
#
# Copy this file to one of:
#   ~/.claude/bootstrap-workflow.local.md          (global — all projects)
#   <project>/.claude/bootstrap-workflow.local.md  (project — overrides global)
#
# Project-level config takes priority over global when present.

# ── MCP Allowlist ─────────────────────────────────────────────────────────────
#
# By default, all claude.ai MCP connectors are disabled in Claude Code.
# Add entries here to keep specific connectors enabled.
#
# To see which connectors are available, check ~/.claude.json under mcpServers
# for keys starting with "claude.ai ".

mcp_allow:
  # - "claude.ai Linear"
  # - "claude.ai Gmail"
  # - "claude.ai Google Calendar"
  # - "claude.ai Vercel"
---
