# Shared workflow contract

Applies to all seven team skills.

## Ownership and judgment

Specialized QA/release technical owners retain their explicit judgment, independence and
sole-verdict authority until separately migrated; ordinary-coordinator instructions do not
replace those contracts or downgrade those roles.

Direct coordinator work is limited to brief logistical or mechanical actions.
Delegate substantive design, implementation, research/synthesis, debugging, technical planning
and judgment-heavy review to a sub-agent, and keep one sub-agent for the whole task rather than
starting a new one per step.
Use a plain native sub-agent, or `/orchestrate` when the request names a model and an effort.
When a model or effort is missing, preserve any confident usable picker route. Picker abstention,
failure, or an unusable route means no workflow override: preserve explicit choices subject to the
existing model-effort compatibility caps, otherwise use normal native model, role and effort
judgment and leave fields omitted when the runtime should resolve them. Select an effort shim only
when that effort was deliberately chosen. Never replace a custom role or retained worker handle,
and never create a retry ladder or capacity bypass.
Record the actual model, effort, selection reason and checks. Independent review still uses its own
fresh context.
The retained owner implements, runs the checks and repairs failures. The coordinator verifies
acceptance evidence without duplicating substantive owner work. Owner testing is not independent
review. Honor an explicit user override naming the check or its verification owner.
For a new bounded Codex worker, explicitly select fresh context using its exposed native schema:
`fork_turns: "none"` (v2) or `fork_context: false` (v1). Never omit the control. Inherit history
only when the current user explicitly requests it, with that schema's full/partial control; v1
silently ignores `fork_turns`, while v2 rejects `fork_context`. Native full-fork role/model/effort
restrictions still apply. Supply a self-contained brief with
scope, authority, paths, acceptance criteria and relevant evidence. Resume the same agent id for
build, test and repair; a stage boundary does not justify a replacement.

A native concurrency/capacity rejection ends the dispatch burst. Record unstarted work and its original deadline in the normal summary/checkpoint; retain accepted worker handles. Never change names, models, effort or owners to bypass the limit. A new native completion/close notification for an accepted handle, or a native limit-change notice, permits one admission attempt; it does not prove a free slot. Rejection stops the burst until another such change; duplicate notices permit no extra attempt. Preserve failed-worker evidence and make one owned recovery decision; send test repairs to the same live owner. Completion is not acceptance: keep artifact checks and required independent review.

### Autonomous effort selection

The autonomous effort vocabulary is `low`, `medium`, `high`, `xhigh`, and `max`. `max` is not
universally available: dispatching an OpenAI model from a Claude session goes through the Codex
companion, whose accepted efforts stop at `xhigh`, so `max` there means `xhigh` and the coordinator
says so. Do not treat `ultracode` as an effort; it is a separate Claude-session mode.

This rubric governs effort on the dispatched sub-agent, not the coordinating session — the user is
free to run any model at any effort as the coordinator. Effort is the primary cost lever on a
sub-agent. Anthropic's API defaults to `high` for current models; OpenAI defaults GPT-5.5/5.6 to
`medium`. Select the level at dispatch from observable task shape, then retain it for that
sub-agent's build/test/fix loop.

Read the rows below against the default the dispatch names. Model tier buys judgment and effort
buys reasoning depth; stack both only when the task shape demands both.

Step down to `low`:
- Focused single-file lookup or grep
- Mechanical edit with zero judgment (rename, format fix, known substitution)
- Narrow check with a known answer (does file X exist, what's the value of Y)

Stay at the dispatched default:
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
reasoning. There is no automatic effort ladder: a sub-agent continues at its selected level unless a
meaningful phase boundary or demonstrated insufficiency justifies a newly recorded override.

### Scope of direct work

Use the smallest mechanism satisfying the requirements and failure boundaries. Prefer existing
primitives; justify complexity by evidenced scale, concurrency, security or failure impact.
Never weaken trust, authorization, credential, destructive-action or data-loss safeguards.
Read exact source and applicable instructions; verify relevant changing external facts.

## Session and effort continuity

A model-pinned native sub-agent cannot become an alternate model through prompting; pick the model
at spawn. Retain native child handles within the spawning parent; follow-ups preserve existing
effort unless a runtime explicitly supports updates. Native effort overrides apply at spawn only. A
failed switch does not authorize silent restart, replay or replacement: preserve current work and
obtain an explicit recovery decision.

Record saved defaults, requested settings and actual runtime metadata separately. Saved settings
do not prove active session behavior; mark missing actual model/effort evidence unverified. Use
supported native settings for explicit overrides, not prompt wording. Report a preflight failure
rather than falling back or emulating an effort change in prose.

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
