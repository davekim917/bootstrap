---
name: team-brief
description: Convert a fuzzy product, engineering, data, or workflow request into a structured Codex-ready brief with scope, constraints, non-goals, acceptance criteria, and open questions.
---

# Team Brief

Use this skill before design or planning when the request is ambiguous, high-impact, or cross-cutting.

Read `../shared/codex-workflow-primitives.md` first for project-instruction and artifact conventions.

## Inputs

Read the user request, applicable `AGENTS.md`, existing `docs/project-scope.md`, and nearby project docs. If this is the first workflow run in the repo, create or update `docs/project-scope.md` with stable product, stack, test, and deployment facts you verified locally.

Ask the user only for blockers that cannot be inferred safely. Otherwise make explicit assumptions and mark them as assumptions.

## Output

Create `docs/specs/<slug>/brief.md` with:

- Problem statement
- Target users or operators
- Current state, with source paths where known
- Desired outcome
- In scope
- Out of scope
- Constraints and risks
- Acceptance criteria
- Unknowns
- Recommended next skill

Use concrete language. Do not write marketing copy. Do not invent business facts that were not stated or verified.

## Verification

Before calling the brief complete, verify the artifact path exists and that every hard requirement in the user request appears in the brief or in an explicit open question.
