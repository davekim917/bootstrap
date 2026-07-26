---
name: team-build
description: >
  Implement an explicitly approved team-plan with proportional tests and evidence. Use one
  cohesive builder by default; delegate in parallel only when work is truly independent. Records
  execution in run.md and hands the completed diff to team-review.
---

# /team-build — Implement the approved plan

Read `../shared/workflow-contract.md` first.

## Prerequisites

Read the exact `docs/specs/<feature>/plan.md`. Confirm it is the revision the user approved and
that its requirements, ownership, and verification are executable. If implementation would require
a product, scope, trust-boundary, or irreversible decision absent from the plan, stop and request a
plan revision.

## Builder choice

Use one lead or one cohesive builder by default. Delegation has coordination cost.

Parallel builders are appropriate only when all of these are true:

- the workstreams are independently executable;
- their write sets do not overlap;
- their interface is already specified in the approved plan;
- parallelism materially reduces latency or adds risk-relevant expertise.

The lead may implement directly. When delegating, assign exact owned files, plan requirements,
verification, and a return contract. The lead remains responsible for integration and final
evidence.

### Dispatch by runtime

- Claude: use native in-session teammates and require each to report changes and fresh checks.
- Codex: use native in-session subagents with exclusive file ownership and lead convergence.
- OpenCode: use native `task` workers; request background execution only for independent work.

Do not use cross-container task dispatch for a cohesive build.

## Process

1. Record the approved plan path and build start in `run.md`. Inspect current git state so existing
   user changes are preserved.
2. Map implementation work to the smallest cohesive write ownership. Parallelize only under the
   rule above.
3. For behavior that can fail, write a focused failing test first when practical and confirm it
   fails for the expected reason. Do not force test-first work for prose, mechanical metadata, or
   behavior that cannot be isolated; state the proportional alternative.
4. Implement the smallest plan-compliant change. Prefer existing primitives. Do not broaden scope
   because a neighboring refactor is attractive.
5. On unexpected behavior, use `/team-debug`: establish reproduction and root cause before fixing.
6. Integrate delegated work, inspect every changed file, and run focused checks. Resolve overlaps
   deliberately; never overwrite another builder's or the user's changes.
7. Record files changed, decisions, fresh command results, checked edge cases, deviations, and
   remaining risks in `run.md`.

## Gate

The build is ready for `/team-review --implementation` only when the implementation is coherent,
focused checks pass, the diff has been inspected, and any plan deviation is explicit. Builder
self-reports are leads, not verification evidence.
