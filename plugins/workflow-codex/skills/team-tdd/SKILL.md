---
name: team-tdd
description: Drive a Codex implementation with failing tests first, then minimal code changes, then focused verification and regression coverage.
---

# Team TDD

Use this skill when the user asks for test-driven development or when a change is risky enough that behavior should be pinned before editing implementation.

Read `../shared/codex-workflow-primitives.md` and the relevant code path before writing tests.

## Loop

1. Define the behavior in concrete examples.
2. Add or update the smallest failing test that captures the behavior.
3. Run the focused test and confirm it fails for the intended reason.
4. Implement the minimal production change.
5. Run the focused test and adjacent regression tests.
6. Refactor only when the tests stay green.

If the environment cannot run the test, inspect the test and implementation carefully and say verification was not possible.

## Guardrails

- Do not change test expectations to fit a broken implementation.
- Do not add broad snapshot tests when a precise assertion is possible.
- Do not skip negative/error-path cases for validation, auth, data, or protocol changes.
- Keep test fixtures representative and deterministic.

## Completion

Report the failing-before and passing-after evidence when available.
