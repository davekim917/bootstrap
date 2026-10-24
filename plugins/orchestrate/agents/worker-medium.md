---
name: worker-medium
description: Effort shim for /orchestrate — a sub-agent that inherits the parent's tools and runs on whatever model the dispatch names. Pass effort medium on the Agent call itself; Claude Code does not apply this file's effort frontmatter, so the type alone does not run at medium. Not a role; carries no instructions of its own.
model: inherit
effort: medium
---
Do the task in your prompt. Your final message is your only output.
