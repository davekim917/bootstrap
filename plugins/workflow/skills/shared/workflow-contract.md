# Shared workflow contract

This contract applies to `/team-plan`, `/team-build`, `/team-review`, `/team-auto`,
`/team-debug`, `/team-ship`, and `/team-retro`.

## Simplicity

- Use the smallest mechanism that satisfies the real requirements and failure boundaries.
- Prefer existing project primitives, platform capabilities, and standard libraries.
- Add complexity only for evidenced scale, repetition, concurrency, security, or failure impact.
- Always harden trust, authorization, credentials, destructive operations, and data-loss boundaries.
- A blocker must name a violated requirement, invariant, or concrete failure mode.
- If a workflow revision or enforcement mechanism creates its own blocker, stop after one
  productive correction. Classify the mechanism as flawed and removable, or show the external
  invariant that genuinely requires more complexity. Do not start another loop.

## Grounding and findings

- Read the applicable repository instructions and the exact source or artifact before deciding.
- Verify changeable external facts against authoritative current sources when they affect the work.
- Treat reviewer comments as hypotheses. A finding becomes `MUST-FIX` only after the lead traces it
  to source and proves a violated requirement, invariant, or concrete failure mode.
- `SHOULD-FIX` identifies evidenced improvement that is not ship-blocking. Everything else is a
  question, preference, or rejected finding.

## Artifacts

The feature directory is `docs/specs/<feature>/`.

- `plan.md` is the single normative product, design, scope, and execution contract.
- `run.md` is the append-friendly operational record: stage, decisions, verified findings,
  corrections, commands, results, checked edge cases, reviewer coverage, and known risks.
- `.team-auto-active` is an ephemeral auto-run sentinel. It is not a decision record.

Do not create routine brief, design, review, drift, QA, decision, pause, or build-state artifacts.
Put durable intent in `plan.md` and execution evidence in `run.md`.

## Verification

Before claiming a stage complete:

1. Run fresh checks appropriate to the actual risk and changed surface.
2. Read their output and record command, result, and relevant counts in `run.md`.
3. Inspect the final diff or artifact.
4. Record edge cases and failure paths checked, not only the happy path.
5. State explicitly when a check could not run and why.

No workflow stage may weaken repository safety rules, bypass a hook, or treat old green output as
current evidence. `/team-auto` never ships.
