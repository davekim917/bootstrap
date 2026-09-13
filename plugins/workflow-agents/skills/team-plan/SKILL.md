---
name: team-plan
description: Ground a minimal technical plan and review consequential decisions.
---

# /team-plan — Ground the outcome

Read `../shared/workflow-contract.md` and `../shared/cross-model-review.md` first.
The retained frontier owner investigates and designs; the coordinator carries logistics and status.

1. Read the relevant source and instructions in full. Ground outcome, scope, existing approval,
   constraints and observable acceptance criteria in the conversation and evidence.
2. Choose the smallest safe design. Write a short `docs/specs/<feature>/plan.md` only when a written
   contract is useful: current behavior with source evidence, proposed change, checks, and material
   safety, rollout or rollback considerations. Record unresolved decisions.
3. Before consequential implementation, obtain independent cross-model plan review on the raw plan.
   Routine changes do not automatically require both review gates; record the risk-based choice.
4. Verify candidate findings and use the shared correction budget. Record evidence in `run.md`.
5. Present the plan and unresolved decisions. Ask for approval only where existing authority does
   not cover the work; factual or test-detail revisions do not restart approval.

A planning-only request authorizes investigation and planning artifacts, not product implementation.
Resume the same frontier owner for an authorized build; do not discard its technical context.
