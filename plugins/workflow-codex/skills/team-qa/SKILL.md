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

## Parallel Validator Dispatch (DEFAULT for medium-or-larger diffs)

When the diff touches >100 LOC OR multiple files OR risk-sensitive surfaces (auth, mounts, migrations, external integrations), **dispatch validators IN PARALLEL as background subagents**. Fire concurrently in one tool turn:

- `security-reviewer` — security / privacy / permissions / data exposure pass
- `performance-analyzer` — performance and operations pass
- `code-review-specialist` — correctness and contract pass
- The **general-purpose worker** subagent (subagent_type = `general-purpose` in Claude/Codex, `general` in OpenCode) — run typecheck, tests, lint, build; report results

Use background dispatch:
- **OpenCode**: `task({subagent_type: 'security-reviewer', background: true, ...})` etc., all in one tool turn
- **Claude**: parallel `Agent(...)` calls in one tool block
- **Codex**: parallel `spawn_task` in one collab block

The lead correlates findings, runs the **adversarial hidden-assumption pass** itself (looking for what the specialists missed), and assembles the final QA verdict. UX/accessibility passes are lead-driven when feasible.

**Solo QA is appropriate ONLY for**: trivial diffs (single small fix, no risk surface) or when the user explicitly asks for a single-pass check.

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
