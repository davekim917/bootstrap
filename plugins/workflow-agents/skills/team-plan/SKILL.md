---
name: team-plan
description: >
  First and only planning entry for non-trivial feature work. Grounds requirements, chooses the
  simplest safe architecture, writes docs/specs/FEATURE/plan.md, and runs independent cross-model
  review before asking for approval. Use before team-build; do not create separate brief or design
  stages.
---

# /team-plan — Plan the smallest complete solution

Read `../shared/workflow-contract.md` and `../shared/cross-model-review.md` first.

## Entry and routing

Use this skill when work needs an explicit contract because it changes behavior, crosses a trust
boundary, has meaningful rollback risk, or benefits from coordinated implementation. File count
alone is not a reason to add ceremony: a mechanical multi-file edit may use a short plan, while a
one-file credential migration needs deep safety analysis.

Planning may inspect and write planning artifacts only. Do not implement production code.

## Process

1. Resolve `<feature>` with the user or from the named task. Read all applicable repository
   instructions and relevant source end to end.
2. Establish the real contract: outcome, users, in-scope and out-of-scope behavior, constraints,
   acceptance criteria, invariants, failure modes, rollout, and rollback. Ask only decisions that
   cannot be grounded safely from existing evidence.
3. Choose the smallest design that satisfies that contract. Discuss alternatives only when more
   than one materially credible option exists. Record why any added machinery is justified by
   scale, repetition, concurrency, security, or failure impact.
4. Write `docs/specs/<feature>/plan.md` with:
   - status and approval state;
   - outcome, scope, and non-goals;
   - requirements and acceptance criteria;
   - relevant current architecture with source evidence;
   - proposed design, interfaces, state changes, and invariants;
   - safety, migration, rollback, and observability where relevant;
   - an ordered implementation path with exact ownership boundaries, dependencies, and checks;
   - known risks, unresolved user decisions, and verification commands.
5. Create or update `run.md` and run the plan-stage review required by the cross-model contract on
   the raw proposed `plan.md`.
6. Verify each review finding. Apply one bounded correction batch for accepted `MUST-FIX` findings.
   If that correction creates a workflow-only blocker, stop and report it rather than reviewing in
   another loop.
7. Present the final plan, accepted/rejected findings, review coverage, and unresolved risks. Ask
   for explicit plan approval.

## Gate

`/team-build` may begin only after the user explicitly approves this `plan.md`. Degraded
cross-model coverage requires an explicit user decision to proceed. Approval of a previous
artifact or an inferred “looks good” is not approval of the current plan revision.
