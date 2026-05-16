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

## Worker Use

Use Codex subagents only when delegation is clearly implied by the workflow request or the build has separable work. Give each worker:

- Exact files or modules it owns
- A warning that others may be editing and it must not revert outside changes
- Required tests or inspections
- A final response format listing changed files and verification

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
