---
name: team-qa
description: Validate a Codex implementation or diff with a structured QA pipeline covering correctness, tests, security, performance, docs, UX, and residual risk.
---

# Team QA

Use this skill after implementation or when the user asks whether a diff is safe.

Read `../shared/codex-workflow-primitives.md`, project instructions, the plan/design artifacts, and the current diff.

## QA Pipeline

1. Identify changed files and behavioral surfaces.
2. Map each acceptance criterion to code and tests.
3. Run focused automated checks available in the project.
4. Inspect edge cases, failure paths, permissions, data exposure, and rollback behavior.
5. For UI changes, inspect responsive behavior and text overflow when feasible.
6. For database or data work, verify migrations, contracts, and representative data paths.
7. For external APIs or current libraries, use current official docs when behavior matters.

Use Codex subagents for independent validator passes when the diff is large or risky. Suggested validators:

- Correctness and contract validator
- Test quality validator
- Security and privacy validator
- Performance and operations validator
- UX and accessibility validator
- Adversarial hidden-assumption validator

## Output

Write `docs/specs/<slug>/qa.md` or return inline:

- Overall status: pass, pass with risk, or fail
- Checks run and results
- Accepted findings with evidence
- Rejected or unproven findings
- Edge cases checked
- Remaining unverified areas
- Required fixes before ship

Do not mark QA passed if required verification was skipped.
