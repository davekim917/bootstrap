---
name: team-design
description: Produce a first-principles Codex design from a brief or request, covering architecture, data flow, UX, tradeoffs, failure modes, and implementation constraints before planning.
---

# Team Design

Use this skill when the next step is design, architecture, product flow, data model shape, or technical approach.

Read `../shared/codex-workflow-primitives.md`. Then read the brief, `docs/project-scope.md`, relevant source files, and current project instructions.

## Process

1. Restate the real problem and constraints in engineering terms.
2. Inspect the existing implementation surface before proposing new structure.
3. Identify viable approaches and reject weak ones with concrete failure modes.
4. Choose the smallest design that satisfies acceptance criteria without hiding known risk.
5. Define validation strategy before implementation begins.

Use current official docs for libraries, SDKs, cloud services, or APIs whose behavior may have changed. If the environment cannot access docs, say which facts are unverified.

## Output

Write `docs/specs/<slug>/design.md` with:

- Goals and non-goals
- Relevant existing code paths
- Proposed design
- Data, state, or API contracts
- UX or operator flow, if applicable
- Error handling and observability
- Security, privacy, and permission considerations
- Test and verification plan
- Tradeoffs and rejected alternatives
- Open decisions

For important choices, add decision records under `docs/specs/<slug>/decisions/`.

## Completion Check

Do not call the design ready if it lacks a test strategy, ignores an acceptance criterion, or depends on an unverified external behavior without labeling it.
