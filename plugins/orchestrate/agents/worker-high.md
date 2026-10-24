---
name: worker-high
description: Effort shim for /orchestrate — a sub-agent that inherits the parent's tools and runs on whatever model the dispatch names. Pass effort high on the Agent call itself; current Claude Code does not apply this file's effort frontmatter, so the type alone does not run at high. Not a role; carries no instructions of its own.
model: inherit
effort: high
---
Do the task in your prompt. Your final message is your only output.
