# Frontier owner trial

Status: approved in conversation 2026-09-13; implementation authorized.

## Outcome

For a one-week trial, use inexpensive coordination and one persistent frontier technical
worker instead of a ladder of progressively stronger workers. Cover both Bootstrap variants,
host Claude/Codex worker definitions, and NanoClaw's generated container definitions.
Claude frontier is Fable 5.1; Codex frontier is GPT-6 Astra. Default effort is medium;
an explicit supported runtime setting can change effort for a task or resumed turn.
Ordinary coordinators use Sonnet/xhigh on Claude and Terra/xhigh on Codex, as explicitly
selected by the user. Substantive real work naturally delegates to the frontier owner;
Opus 5/Sol are explicit exceptions, never a cheap-first ladder or silent downgrade.

## Approved behavior

- The coordinator preserves the original request, constraints and existing authority; handles
  dispatch, status and evidence bookkeeping; does not prescribe the worker's technical solution.
- The frontier worker owns investigation, technical planning, implementation, testing and fixes.
  Resume its exact task-specific session throughout a cohesive task, never a global last session.
  Native handles and CLI UUIDs are not interchangeable. Choose transport at task start; use a
  helper-owned CLI session when effort needs to change across resumptions.
- Independent review uses a fresh context and raw artifacts. Other-family selection is relative
  to the artifact author. Depth and number of review gates follow risk and explicit user requests.
- Reuse checks for the identical artifact and relevant environment. Record identity, command,
  result and invalidation conditions. Relevant changes invalidate affected evidence.
- Meaningful acceptance criteria and proportional tests replace mandatory test-name skeletons.
  Factual implementation/verification amendments do not erase existing approval; changed product
  intent, scope, trust boundaries or irreversible actions still require authority.
- Allow bounded productive repair with the same worker. Repeated failure or workflow-created
  obstruction triggers reconsideration rather than another identical loop.
- Keep existing authorization, destructive-action, isolation, cancellation and publication controls.
- Retire only the owned generic intelligence tiers. Preserve specialist agents and independent
  cross-provider review transport.
- Keep plan.md/run.md as existing artifacts. Measure accepted tasks, premium usage, elapsed time,
  repair rounds, escaped defects and human interruptions; do not equate API cost with quota.

## Scope and ownership

Bootstrap canonical skills are plugins/workflow/skills; workflow-agents is generated. Update all
seven team skills, orchestrate, both shared contracts, generation/parity checks and packaging.
NanoClaw owns container/agents and src/claude-agent-md.ts conversion, plus primary and companion
Codex config generation. Personal host worker files are another source and must be reconciled.

The main agent owns a small foreground CLI fallback for dynamic effort, this plan/run record,
integration and installed-state reconciliation. One Astra/medium builder owns Bootstrap workflow
source, one Astra/medium builder owns NanoClaw runtime source. Work is isolated in separate git
worktrees. User explicitly restricts any subagents in this implementation session to Astra at
low or medium: independent review here therefore uses Astra/medium with fresh context, records
same-family coverage, and does not launch Claude/Fable inference.

## Acceptance and verification

1. Both distributions express the same ownership, evidence reuse, review and repair contract.
   Generation/parity checks and behavioral scenario review verify the resulting routing.
2. Native Claude frontier resolves to Fable 5.1/medium. Codex frontier resolves to Astra/medium
   by default and permits an explicit low/medium effort without a role-file effort lock.
3. Claude's native Agent tool has no per-call effort field in the installed SDK. A scoped CLI
   invocation supplies CLAUDE_CODE_EFFORT_LEVEL plus --effort, uses a recorded session ID on
   resume, and never changes the parent environment or disables safety hooks.
4. Known old generic worker definitions retire without removing unrelated/operator definitions.
5. CLI helper rejects invalid runtime/effort/session/options before spawn, keeps prompts on stdin,
   preserves exit failures and cancellation, and uses explicit pinned models/default medium.
6. Targeted runtime tests, affected typechecks/builds, plugin parity and helper subprocess tests
   pass. Actual installed config and fresh Codex session metadata establish activation separately.

## Rollout and rollback

Record baseline git heads and privately snapshot only modified installed configuration/profile
files before migration. No credential values enter logs or repository artifacts. Reconcile owned
host profiles, install both versioned plugin variants, and verify generated container definitions.
Record source, installation and fresh-runtime verification separately. No unrelated fleet-primary
model defaults, auth, mounts or live workloads are changed merely to simplify workers. Trial
coordinators use explicit lower-cost launch settings so production specialist identities stay intact.
Retain the old source commits and restore the backed-up installed files to roll back the trial.

The user additionally requested a Dinesh/Gilfoyle campaign audit. Their root judgment assignments,
stored task pins, and QA-specific profiles require a separate coordinated migration; do not
downgrade these roots while they still own verdicts. Apply the agreed ordinary defaults to the
14 ordinary groups and remove their three redundant channel overrides; preserve QA/release
specialists and OpenCode providers. Host CLI coordinator defaults are included in activation.

No broad benchmark framework or new routing service is part of this change. A full week of
behavioral evidence remains operational follow-up rather than an implementation-completion claim.
