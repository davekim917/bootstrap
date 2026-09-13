---
name: team-auto
description: Carry authorized work through bounded build, review and safe publication.
---

# /team-auto — Approved plan to pull request

Read `../shared/workflow-contract.md` and `../shared/cross-model-review.md` first.

Never auto-trigger. The user must invoke `/team-auto`, with implementation authority for the scope recorded in
`docs/specs/<feature>/plan.md`. Ground it in the existing conversation; a new factual or test-detail
revision does not require ceremonial reapproval.

## Sentinel

Use `docs/specs/<feature>/.team-auto-active`.

1. If it exists and its modification time is less than two hours old, stop: another run may be
   active.
2. If it is at least two hours stale, record the stale recovery in `run.md`, remove it, and start.
3. Create it at start. Refresh its modification time at every stage transition and immediately
   before and after a command expected to exceed ten minutes.
4. Remove it on success, review failure, tool failure, degraded review, or deliberate stop. A hard
   process kill recovers through the stale rule.

The sentinel is only a concurrency guard. It is not approval or workflow state.

## State machine

1. **Preflight:** read the approved plan, repository instructions, git state, and `run.md`. Confirm
   no missing product, scope, trust or irreversible decision.
2. **Build:** invoke `/team-build` against that plan. Refresh the sentinel. Stop on an ungrounded
   scope/trust/irreversibility decision or a safety control.
3. **Review:** invoke `/team-review --implementation`. Apply consequential review gates and honor explicit review requests.
4. **Correct within budget:** return verified MUST-FIX to the retained owner. Use the shared maximum
   of 3 corrective rounds across build/test/review, including one reconsideration on a repeated
   failure signature. Re-run only affected checks; reuse valid exact evidence.
5. **Ship what is safe:** if clear, remove the sentinel and invoke `/team-ship`. It lands the
   reversible tier itself — commit, push the working branch, open the PR — and asks a human only
   for an action that deploys or cannot be cleanly undone. Do not stop here and report "ready to
   ship": an approved plan that passed review and preflight has the authority to become a pull
   request.

If the budget is exhausted, progress stops, workflow-created obstruction repeats, or a required
reviewer is unavailable without explicit accepted coverage, record the concrete blocker in `run.md`,
remove the sentinel, and stop. A second productive failure alone does not stop the run.

`/team-auto` stops at anything that deploys and cannot silently add deploy authority.

## Authority

Grounded implementation judgment inside the approved plan is allowed and recorded. Stop for a
decision that changes product intent, scope, a hard constraint, a trust or correctness invariant,
or irreversible behavior. Never bypass destructive/protected-file/email/self-approval controls.
