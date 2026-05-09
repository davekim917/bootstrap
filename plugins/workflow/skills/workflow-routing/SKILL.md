---
name: workflow-routing
description: >
  Routes non-trivial feature work to the team-* workflow skills. Use when a request involves new
  APIs, data models, schemas, multi-file changes, new integrations, or ambiguous requirements —
  invoke /team-brief instead of writing brief/design/plan documents directly. Triggers on phrases
  like "build feature X", "add new endpoint/model/integration", "refactor across files", or any
  request where the requirements are not yet pinned down.
user-invocable: false
version: 1.1.0
---

# Workflow Routing

## When to invoke `/team-brief` first

The workflow chain — brief → design → review → plan → build → qa → ship — exists because each stage produces an artifact the next stage depends on. Skipping ahead means designing without crystallized requirements, planning without a committed design, or building without a planned task decomposition. The result is rework, scope creep, or features that don't match what was asked for.

Start with `/team-brief` (invoke via the Skill tool: `Skill({ skill: "team-brief" })`) when the request involves any of:

- **New API endpoints, data models, or schemas** — anything that creates a new contract.
- **Changes spanning 3+ files** — multi-file changes need a planned decomposition, not ad-hoc edits.
- **New subsystems, integrations, or services** — anything introducing a new dependency or surface.
- **Ambiguous or underspecified requirements** — when "build X" doesn't pin down what done looks like.

Each downstream skill (`/team-design`, `/team-review`, `/team-plan`, `/team-build`, `/team-qa`, `/team-ship`) has an explicit approval gate. Don't skip ahead.

## What counts as trivial — skip the workflow

The workflow has overhead that's only worth it for genuinely non-trivial work. For these cases, do the work directly:

- Single-file bug fixes
- Config changes (env vars, package.json, tsconfig, .gitignore)
- Typo fixes, formatting, comment edits
- Simple queries against existing data
- Research, exploration, conversation
- Reverting a recent commit

If you're unsure, ask the user. "This looks small enough to handle directly — should I skip the brief?" is a valid check.

## Common mistakes

- **Writing a brief-like document yourself instead of invoking `/team-brief`.** The skill has specific file paths (`docs/specs/<feature>/`), a Q&A process, and output templates that only load when invoked. A hand-written brief misses all three.
- **Chatting through requirements and jumping to implementation.** That skips the brief *and* the design — the two stages that pin down what done looks like and what the architecture should be.
- **Creating `plan.md` or `design.md` files ad-hoc.** `/team-design` and `/team-plan` produce these with constraint analysis, decision records, and conflict checks the manual version doesn't replicate.
- **Reading a skill's description and approximating from it.** The descriptions in your context are summaries. The full instructions, file paths, process steps, and gate structure load only when you invoke the skill via the Skill tool.

## Routing decision in one line

If the user asked for *a feature*, run `/team-brief`. If the user asked for *a fix or a question*, do it directly.
