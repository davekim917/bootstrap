---
name: team-build
description: Implement a Codex workflow plan, optionally coordinating Codex subagents for parallel disjoint work while the lead owns integration, validation, and completion evidence.
---

# Team Build

Use this skill when the user wants implementation, not just advice.

Read `../shared/codex-workflow-primitives.md`, then read the relevant brief, design, review, and plan artifacts if they exist. If they do not exist and the work is still clear, proceed with a lightweight local plan.

## Lead Responsibilities

The lead Codex agent owns:

- Preflight status inspection
- Protecting unrelated user changes
- Task decomposition
- Worker coordination when useful
- Integration
- Tests and verification
- Final completion claim

Use `update_plan` for visible multi-step work when the task is non-trivial.

## Parallel Worker Dispatch (DEFAULT for plans with disjoint tasks)

When the plan has 2+ tasks with **disjoint write scopes** (no overlapping files), **dispatch them IN PARALLEL as background subagents** rather than executing sequentially.

Use the runtime's **general-purpose worker** subagent for each task — this is the runtime's built-in ephemeral worker, not a specialist:
- **Claude / Codex**: subagent_type = `general-purpose`
- **OpenCode**: subagent_type = `general` (OpenCode's built-in worker; description: "Use this agent to execute multiple units of work in parallel")

Give each worker:

- **Exact files or modules it owns** (must not overlap with sibling workers — disjoint scope is non-negotiable)
- A warning that others may be editing and it must not revert outside changes
- The task brief from `docs/specs/<slug>/plan.md`
- Required tests or inspections
- A final response format listing changed files and verification

Use background dispatch — fire all workers in one tool turn, then poll/wait for results.
- **OpenCode**: `task({subagent_type: 'general', description: 'Build task N', prompt: '...', background: true})`
- **Claude**: parallel `Agent(...)` calls in one tool block
- **Codex**: parallel `spawn_task` in one collab block

The lead **does not delegate the integration step** — once workers report, the lead pulls their changes together, resolves conflicts, runs the full suite of project gates, and produces the final completion claim.

**Solo execution is appropriate ONLY for**: single-task plans, linear-dependency tasks, or when the user explicitly asks for serial work. Default to parallel dispatch when scope allows.

Keep blocking work local. Do not wait on a worker until its result is needed.

## Build State

For larger builds, maintain `docs/specs/<slug>/.tmp/build-state.md` with:

- Task status
- Worker ownership
- Open integration issues
- Verification results
- Deferred items

## Completion Gate

Before saying the build is complete:

- Inspect the final diff.
- Run focused tests, build, typecheck, lint, or equivalent project gates.
- Check error paths and non-happy-path inputs proportional to risk.
- State exactly what passed and what was not verified.
