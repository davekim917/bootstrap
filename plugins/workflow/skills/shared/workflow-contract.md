# Shared workflow contract

Applies to orchestrate and all seven team skills during the one-week frontier-owner trial.

## Ownership and judgment

A cheap coordinator handles logistics, status, authorization and evidence collection. One retained
frontier owner investigates, designs, implements, tests and fixes. Default medium effort; explicit
overrides must use validated supported runtime configuration. Simple tasks may execute directly.
Use the smallest mechanism satisfying the requirements and failure boundaries. Prefer existing
primitives; justify complexity by evidenced scale, concurrency, security or failure impact.
Never weaken trust, authorization, credential, destructive-action or data-loss safeguards.
Read exact source and applicable instructions; verify relevant changing external facts.

## Scope and approval

Ground authority in the existing conversation and applicable operator instructions. A request to
implement authorizes implementation within its stated scope; do not require ceremonial approval
of a newly written plan. Factual corrections and test-detail refinements do not reset authorization.
Record them. New product intent, scope, trust boundaries, hard constraints or destructive and
irreversible behavior require the missing decision before dependent work. Planning-only requests
remain planning-only. No stage bypasses repository safety controls or adds deployment authority.

## Minimal artifacts

For work needing a written contract use `docs/specs/<feature>/plan.md` for outcome, scope,
observable acceptance criteria, source-grounded design and material risks/decisions. Keep it short.
Use `run.md` for authority, owner/runtime settings, stage, decisions, command evidence, findings,
repair rounds and remaining risks. Simple tasks need no mandatory plan/run files; report evidence
in the conversation. Do not create routine additional workflow artifacts.
`.team-auto-active` is an ephemeral concurrency sentinel, never approval or a decision record.

## Acceptance and verification

Acceptance criteria describe observable outcomes. Add meaningful tests when practical, preferably
confirming the expected failure before a behavioral fix. There is no mandatory exact test skeleton
before every change. For prose or behavior that cannot be isolated, record the proportional check.
Never weaken or silently retarget an assertion merely to make it pass.

Evidence is reusable only for the unchanged exact artifact, relevant environment and command.
Record the commit/tree or content fingerprint (including in-scope untracked files), command,
environment inputs that affect it, result and checked edge cases. Invalidate affected evidence
after relevant changes; run the affected checks again. A stage transition alone does not justify
rerunning a test. Read actual output and inspect the final artifact before claiming completion.
Report unavailable checks honestly. A green suite with skipped acceptance coverage is not proof.

## Review and corrections

Use independent fresh cross-model review at consequential plan and implementation gates; routine
changes do not automatically need both. Honor explicitly requested reviews. Apply the shared
cross-model contract. Findings are hypotheses: the owner verifies source and concrete failure
before accepting MUST-FIX. Record rejected findings and nonblocking SHOULD-FIX separately.

The retained owner has a default maximum of 3 corrective rounds per task across build, test and
review. A round is a cohesive evidence-backed repair batch plus affected verification; count it in
run.md. A second productive failure is not a stop condition. On a repeated failure signature,
reconsider the root cause or test premise once before another repair; do not repeat the same patch.
Stop at the bound, on no progress, or repeated workflow-created obstruction. Name the external
invariant, or identify the removable workflow mechanism; do not manufacture more process to
satisfy a flawed rule. A new round budget needs an explicit grounded decision.

## One-week measurement

For each accepted task record task id, acceptance evidence, started/completed times, elapsed time,
owner/model/effort, measured usage and cost when available (otherwise unknown), repair rounds,
escaped defects, and human interruptions with reasons. Include stopped/unaccepted attempts in the
weekly denominator and report acceptance rate and total usage per accepted task; do not hide failed
work or claim savings from model pricing alone. Keep measurements in run.md or the existing task
ledger, without introducing a second tracking system.

## Shipping

Preserve `/team-ship` authority and exact-target checks. `/team-auto` carries work only to authorized
reversible publication and stops at anything that deploys; it cannot silently add deploy authority.
Destructive, protected-file, outbound-email and self-approval controls remain in force.
