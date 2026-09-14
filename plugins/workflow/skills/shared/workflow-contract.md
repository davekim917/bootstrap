# Shared workflow contract

Applies to orchestrate and all seven team skills during the one-week frontier-owner trial.

## Ownership and judgment

Specialized QA/release technical owners retain their explicit judgment, independence and
sole-verdict authority until separately migrated; ordinary-coordinator instructions do not
replace those contracts or downgrade those roles.

Ordinary coordinators are Sonnet/xhigh or Terra/xhigh. Direct coordinator work is limited to
brief logistical or mechanical actions. Delegate substantive design, implementation,
research/synthesis, debugging, technical planning and judgment-heavy review to a retained worker
from the approved floor: Fable 5.1 or Opus 5 for Claude, Astra 6 or Sol for Codex. Fable/Astra are
the default at medium effort; Opus/Sol are first-class dynamic worker selections, not exceptions.
Choose once at task start based on user direction, task/model fit, observed trial results, or
provider availability, then retain that same owner. Record the actual model, effort, selection
reason and checks. Ambiguity, novel design, visual taste, security, concurrency and
high-consequence judgment favor frontier quality. Independent review still uses its own fresh
context.

### Autonomous effort selection

The complete autonomous worker vocabulary is `low`, `medium`, `high`, `xhigh`, and `max` for
both provider families. `ultra` is deliberately excluded from autonomous selection. A coordinator
may use Codex `ultra` only after the current human explicitly directs it (for example, “delegate
this to an ultra worker”): record that instruction and invoke the helper with
`--human-directed-ultra true`. Never infer the directive from task difficulty, retries, urgency,
or a prior human preference. Do not treat `ultracode` as a worker effort either; it is a separate
Claude-session mode.

This rubric governs effort on the dispatched worker, not the coordinating session — the user is
free to run any model at any effort as the coordinator. `medium` is this trial's measured
cost/quality default. Because workers are frontier models (Fable/Opus/Astra/Sol), effort level on
them is the primary cost lever. Anthropic's API defaults to `high` for current models; OpenAI
defaults GPT-5.5/5.6 to `medium`. Select the level at dispatch from observable task shape, then
retain it for that owner's build/test/fix loop.

Step down to `low`:
- Focused single-file lookup or grep
- Mechanical edit with zero judgment (rename, format fix, known substitution)
- Narrow check with a known answer (does file X exist, what's the value of Y)

Stay at `medium` (default):
- Bounded implementation with clear acceptance criteria
- Ordinary research with a known approach
- Test writing for understood behavior
- Single-module changes

Step to `high`:
- Debugging without a known root cause
- Concurrency, race conditions, state machines
- Security or trust boundary changes
- Multi-module changes with implicit cross-module contracts
- Consequential review

Step to `xhigh`:
- Elusive failure after `high` didn't resolve it
- Many dependent design decisions with no codebase precedent
- Substantial uncertainty about the right approach

`max` — evidence that `xhigh` was demonstrably insufficient; prefer evidence over automatic
escalation.

Fix missing context, contradictory instructions, and unclear completion criteria before raising
effort. Do not use severity labels, a failed command, or a desire to retry as a proxy for harder
reasoning. There is no automatic effort ladder: an owner continues at its selected level unless a
meaningful phase boundary or demonstrated insufficiency justifies a newly recorded override.

### Dispatch-first gate

Before the coordinator reads nontrivial implementation source, inspects a deployment or log,
chooses/runs a diagnostic or regression check, or makes a technical correctness judgment, it must
dispatch the retained frontier owner. The coordinator may read the request, find a source location,
check status/authorization, create the worktree or claim, and pass existing evidence; it must not
use that setup to pre-solve the task. Record either `frontier owner dispatched` with its model and
effort, or the narrow direct action and why it is purely logistical/mechanical. This applies to
scheduled work and incident recovery too. A useful technical conclusion reached directly by a
Sonnet/Terra coordinator is still a trial-policy miss, not an exception created after the fact.

Never delegate substantive work below the approved Opus/Sol floor. This covers discovery,
implementation, verification, repair, scheduled tasks and review; Sonnet, Terra, Luna and routine
cheap subagents are not worker substitutes. If no approved worker is available, report and obtain
a recovery decision; no silent downgrade, extra worker tier or automatic retry ladder.
Use the smallest mechanism satisfying the requirements and failure boundaries. Prefer existing
primitives; justify complexity by evidenced scale, concurrency, security or failure impact.
Never weaken trust, authorization, credential, destructive-action or data-loss safeguards.
Read exact source and applicable instructions; verify relevant changing external facts.

## Session and effort continuity

Choose native dispatch or the CLI helper at task start. A model-pinned native Codex worker cannot
become an alternate model through prompting; start an approved alternate with helper `--model`. Retain native child handles within the
spawning parent; follow-ups preserve existing effort unless a runtime explicitly supports updates.
Native effort overrides apply at spawn only. When mid-task effort changes or CLI resume are
needed, start a helper-owned CLI session and retain its exact UUID, runtime and runtime home.
Helper `--resume` accepts only its own CLI session UUID, never a native child handle. These
transports cannot resume each other's sessions. A failed switch does not authorize silent restart,
replay or replacement: preserve current work and obtain an explicit recovery decision.

Record saved defaults, requested settings and actual runtime metadata separately. Saved settings
do not prove active session behavior; mark missing actual model/effort evidence unverified. Use
supported native settings for explicit overrides, not prompt wording. The helper rejects anything
outside the shared five-level autonomous vocabulary, except Codex `ultra` with the recorded direct
human directive and `--human-directed-ultra true`; report every other preflight failure rather than
falling back or emulating an effort change in prose.

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
