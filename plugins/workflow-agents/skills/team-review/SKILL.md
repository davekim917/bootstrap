---
name: team-review
description: Review plans or implementation with independent context and source-backed findings.
---

# /team-review — Verify the contract or implementation

Read `../shared/workflow-contract.md` and `../shared/cross-model-review.md` first.

## Modes

- `--plan`: review a proposed `plan.md`. `/team-plan` normally invokes this mode before approval.
- `--implementation`: review the approved plan against the raw implementation diff after build.

If the mode is omitted, infer it only when exactly one is unambiguous; otherwise ask.

## Review lenses

Always check correctness, simplicity, plan fidelity, failure handling, and verification quality.
Add specialist lenses only when the changed surface warrants them:

- authorization, credentials, untrusted input, destructive actions, or data loss → security;
- concurrency, lifecycle, persistence, or migration → state and rollback;
- hot paths or material scale claims → performance;
- user-visible UI or workflow → relevant product/accessibility behavior;
- changing external API, framework, security rule, or standard → current authoritative sources.

Do not spawn a fixed swarm. One other-family reviewer is required at consequential plan and implementation
gates; routine work does not automatically require both. Honor explicit review requests; other reviewers need a named risk justification.

Select lenses here; judge against the rubric in `../shared/cross-model-review.md`. Send each
reviewer the rubric items for its selected lenses, and require every finding to cite one of them or
a named external invariant. A rubric match is a hypothesis — the lead still traces it to source
before it can become `MUST-FIX`.

## Plan mode

1. Read the raw proposed `plan.md`, applicable repository instructions, and cited source.
2. Check that requirements are testable, scope is explicit, design is the smallest safe mechanism,
   trust/data-loss boundaries are hardened, and rollout/rollback match the risk.
3. Run the shared cross-model review on the raw plan.
4. Verify every candidate finding and record accepted/rejected results in `run.md`.
5. Return `clear`, `must_fix`, or `degraded`. Do not approve the plan for the user.

## Implementation mode

1. Read the approved plan and `run.md` when present, the authorized request, repository instructions,
   git status, and complete raw implementation diff including untracked files in scope.
   Simple work may use the conversation as its contract.
2. Map every requirement and invariant to implementation evidence. Inspect changed code and the
   relevant call paths, not only test names.
3. Run the shared cross-model review on the approved plan (or authorized request) plus raw diff.
4. Use risk-selected tests, typechecks, lint/build, security, migration, or visual checks.
   Reuse evidence only for the unchanged exact artifact, relevant environment and command;
   invalidate affected evidence after relevant changes. Do not repeat checks just for a new stage.
5. Verify each reviewer claim. Record accepted/rejected findings, exact commands/results, checked
   edge cases, coverage, and known risks in `run.md`.
6. Return:
   - `clear` when no verified `MUST-FIX` remains and evidence supports the plan;
   - `must_fix` with the smallest bounded correction batch;
   - `degraded` when required evidence or cross-model coverage is unavailable.

## Correction rule

Return accepted findings to the same retained sub-agent. Use the shared default maximum of 3
corrective rounds across the task, with one reconsideration on a repeated failure signature.
Re-run affected checks and review the changed surface as risk requires. Stop on exhausted budget,
no progress or repeated workflow-created obstruction, not merely a second productive failure.
