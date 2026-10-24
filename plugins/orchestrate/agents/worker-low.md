---
name: worker-low
description: Effort shim for /orchestrate — a sub-agent that inherits the parent's tools and runs on whatever model the dispatch names. Pass effort low on the Agent call itself; Claude Code does not apply this file's effort frontmatter, so the type alone does not run at low. Not a role; carries no instructions of its own.
model: inherit
effort: low
---
Do the task in your prompt. Your final message is your only output.
