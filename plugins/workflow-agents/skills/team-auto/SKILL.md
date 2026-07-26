---
name: team-auto
description: >
  User-invoked autonomous runner for an explicitly approved plan. Runs team-build then
  team-review --implementation, permits one bounded correction, and stops at the team-ship gate.
  Maintains a recoverable two-hour sentinel and never ships.
---

# /team-auto — Approved plan to pre-ship gate

Read `../shared/workflow-contract.md` and `../shared/cross-model-review.md` first.

Never auto-trigger. The user must invoke `/team-auto`, and the exact
`docs/specs/<feature>/plan.md` must already have explicit approval.

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
   no missing product decision or unapproved plan revision.
2. **Build:** invoke `/team-build` against that plan. Refresh the sentinel. Stop on an ungrounded
   scope/trust/irreversibility decision or a safety control.
3. **Review:** invoke `/team-review --implementation`. Its cross-model review is mandatory.
4. **Correct once:** if review returns verified `MUST-FIX`, apply one cohesive, evidence-backed
   correction batch and re-run only affected checks once.
5. **Stop:** if clear, remove the sentinel and report readiness for the separate `/team-ship`
   decision. Never invoke shipping.

If the correction creates a workflow-only blocker, a required reviewer is unavailable, the same
mechanism fails again, or affected checks remain red, record one concrete blocker in `run.md`,
remove the sentinel, and stop. Do not start another review/repair cycle.

## Authority

Grounded implementation judgment inside the approved plan is allowed and recorded. Stop for a
decision that changes product intent, scope, a hard constraint, a trust or correctness invariant,
or irreversible behavior. Never bypass destructive/protected-file/email/self-approval controls.
