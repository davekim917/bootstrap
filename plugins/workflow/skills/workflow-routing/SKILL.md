---
name: workflow-routing
description: >
  ROUTING RULE: Non-trivial features (new APIs, data models, multi-file changes,
  ambiguous requirements) MUST start with /team-brief. Invoke the skill — do not approximate.
user-invocable: false
---

# Workflow Routing

When a user requests work that involves any of:
- New API endpoints or data models
- Changes spanning 3+ files
- New subsystems or integrations
- Ambiguous or underspecified requirements

Start with `/team-brief` by invoking it via the Skill tool: `Skill({ skill: "team-brief" })`.

Follow the workflow chain: brief -> design -> review -> plan -> build -> qa -> ship. Each step has an explicit approval gate. Do not skip ahead.

## What counts as trivial (skip the workflow)

Single-file bug fixes, config changes, typos, simple queries, research, conversation.

## Common mistakes

- Writing a brief-like document yourself instead of invoking `/team-brief`. The skill has specific file paths (`.context/specs/<feature>/`), a Q&A process, and output templates that only load when invoked.
- Chatting through requirements and jumping to implementation. That skips the brief and design.
- Creating plan or design files ad-hoc. The `/team-design` and `/team-plan` skills produce those.

The skill descriptions in your context are summaries. The full instructions load only when you invoke the skill via the Skill tool. Approximating from the description will get file paths, process steps, and gate structure wrong.
