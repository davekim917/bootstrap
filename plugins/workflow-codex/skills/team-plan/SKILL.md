---
name: team-plan
description: Turn a reviewed design into a Codex-buildable implementation plan with ordered tasks, exact files, tests, dependencies, and validation gates.
---

# Team Plan

Use this skill after `team-design` and `team-review`, or directly when the user already provided a clear implementation target.

Read `../shared/codex-workflow-primitives.md`, the brief, design, review findings, current project instructions, and relevant code paths before writing the plan.

## Plan Requirements

Create `docs/specs/<slug>/plan.md` with:

- Summary of the chosen approach
- Ordered implementation phases
- Exact files or modules expected to change
- Tests to add or update
- Manual verification steps
- Risks, blockers, and assumptions
- Rollback or cleanup notes where relevant

For each task, include:

- Owner role: lead, worker, reviewer, or user
- Inputs
- Expected edits
- Acceptance criteria
- Verification command or inspection
- Dependencies on earlier tasks

Do not create a task that says only "implement feature" or "fix tests". Make each task independently executable.

## Codex Build Readiness

Before calling the plan build-ready, check that:

- Every accepted review finding is addressed or explicitly deferred.
- Test coverage matches the risk of the change.
- Parallel tasks have disjoint write scopes.
- No task requires an unknown external secret, account, or approval without saying so.
