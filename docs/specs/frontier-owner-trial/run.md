# Frontier owner trial — implementation record

## Latest state: activated 2026-09-13T06:17:53Z

The exact user-approved activation completed. Both services are active; OneCLI preflight passed
at 06:17:57Z and NanoClaw reported running at 06:18:05Z. The active runner snapshot matches source.
All 37 task contents/pins and unchanged schedule fields were verified after activation, as were
both QA central defaults and all 14 QA file hashes. Host defaults are Sonnet/xhigh and Terra/xhigh;
one generic frontier profile per runtime defaults to medium, with no Codex role effort lock.
The 14 ordinary groups plus the QA coordinator and QA challenger total 16 coordinators. The release specialist stays Fable/medium.

Shared QA source is committed on main as 9289fa106. No Docker rebuild or remote push occurred.
Group files contain unrelated pre-existing edits; their owned migration patch and before/after
bytes are backed up without a broad group commit. Applied receipt/backups are private at
/home/ubuntu/.local/state/bootstrap-frontier-trial/20260913T044107Z/joint-campaign-applied/.

Operational trial start: 2026-09-13T06:18:05Z; target evaluation: 2026-09-20T06:18:05Z.
No automatic review timer was created. Fresh natural container/model execution remains to observe;
no extra production task or Fable inference was triggered. Title-generation credential exhaustion
and a retired Discord-channel warning predate activation; main startup and OneCLI preflight passed.
Build metadata trails documentation/skill changes only; no compiled host-code drift was detected.
Earlier preparation sections below are historical and do not mean activation is still pending.

## Worker-floor policy supersession — 2026-09-13

The user broadened the worker policy after activation. Bootstrap Claude 5.0.2 and Codex 2.0.2
now allow one retained worker to be Fable 5.1 or Opus 5 on Claude, and Astra 6 or Sol on Codex.
Fable/Astra remain the medium-effort default. Opus/Sol are first-class task-start selections rather
than exceptions. Every substantive delegation has this floor; Sonnet, Terra, Luna and other cheap
workers are disallowed for delegated discovery, implementation, checks, repair, scheduled work and
review. The coordinator defaults remain Sonnet/xhigh and Terra/xhigh because they are not worker
delegations. The helper allowlist enforces the same four-model floor. Parity and helper tests pass.

Both local plugins were refreshed. Claude Code applies its updated plugin in a fresh host session.
NanoClaw has no running agent containers; fresh container sessions mount the revised plugin source
directly, so no host restart or image build is needed for this instruction-only update.

Approved: user explicitly authorized the discussed changes and confirmed both Claude and Codex.
Implementation-session constraint: subagents only GPT-6 Astra at low or medium effort.

## Baseline

- Bootstrap: e0ebb3546c8847d72c26b45960e20cfc3e979322.
- NanoClaw: b0987d39c3745f7af3509b9651da624cff2a0d99.
- Both source checkouts were clean before isolated worktrees were created.
- Host CLIs: Codex 0.154.0; Claude Code 2.1.270.
- Qodo configuration absent; no Qodo rules loaded.
- Existing user approval governs; obsolete exact-plan-revision/cross-family gates do not override
  the user's implementation authorization and Astra-only delegation restriction.

## Execution

- Bootstrap builder: Astra/medium, persistent task frontier_workflow_builder.
- NanoClaw builder: Astra/medium, persistent task frontier_runtime_builder.
- Parent owns CLI effort fallback, installed-state reconciliation and integration.
- Native Claude AgentInput has no effort field; frontmatter medium needs a scoped CLI environment
  override for per-call effort. Codex role effort must be omitted to preserve spawn override.

## Implementation verification

- Bootstrap Claude 5.0.1 and Codex 2.0.1 generated from the canonical workflow tree. Patch bump
  propagates the later strong-frontier/default-coordinator instructions and transport clarification.
- Plugin parity passed; 48 harness/retirement tests passed; 8 foreground-helper tests passed.
- Both hook typechecks and 30 Codex hook tests passed. Claude hooks unchanged: 586/586 pass from
  canonical cwd; /tmp worktree cwd changes ephemeral-path semantics and causes 12 fixture failures.
- Independent fresh Astra/medium review found the unnecessary frontier transport wrapper and
  missing descendant cancellation. Wrapper retired; direct helper retained. Process-group timeout
  and signal cleanup now pass original reviewer reproduction and descendant survival regressions.
- Review coverage is same-family by explicit user instruction; no Fable inference was launched.
- Native provider inference/default-effort activation and live host restart remain separate below.

## Native probes and rollout preparation

- Native project-only probe was not discovered; temporary user-scope role succeeded and was removed.
- Parent probe 01a09915-307f-7dd3-bbc1-5d929fbdad47 used Astra/low. Runtime turn metadata confirms
  child 01a09915-4c55-7020-996c-410ac3816f39 used Astra/medium with no explicit effort, and child
  01a09915-6aa6-74f0-bb63-3bce3cb64177 used Astra/low with an explicit override.
- Native child -> separate CLI resume is unsupported by Codex v2. The helper correctly reported
  failure and did not substitute a new thread. Skills now distinguish native and CLI ownership.
- Helper-owned thread 01a09919-75c8-7311-a4b7-7c0a01fafcc9 was started Astra/medium and resumed
  Astra/low; the same persisted thread contains both native turn-context records.
- Claude 5.0.0 and Codex 2.0.0 installed from local Bootstrap marketplace. Original marketplace,
  plugin cache and profiles backed up privately at
  /home/ubuntu/.local/state/bootstrap-frontier-trial/20260913T044107Z.
- NanoClaw 479b12277 built in the canonical checkout with BUILD_ALLOW_LOCAL=1; dashboard cache
  restored successfully. No service restart has occurred.
- Local PreToolUse restart guard blocked stopping the sync watcher. Final reconciliation/restart
  requires its exact real-user nonce approval; no guard was bypassed.
- User selected ordinary Sonnet/xhigh and Terra/xhigh coordinators; 14 group defaults were saved
  through ncl and verified in the central projection. Three redundant ordinary channel overrides
  were cleared to inherit (two wirings in one team channel and main/general).
- The QA coordinator, QA challenger and release specialist remain specialized judgment roots pending campaign-role migration.

## Campaign audit

The QA coordinator is Opus/xhigh and the QA challenger Sol/xhigh. Their QA-specific
workers remain Sonnet/xhigh and Luna/max, with separate frontier adjudicator profiles and a
parent-effort escalation ladder. The standing instructions and shared smoke-test skill still
assign substantive verdicts to the roots. Five pending QA-coordinator task rows include three explicit
Opus/high pins, one Sonnet/xhigh pin and one unpinned task; the stored PR/develop prompts match
their files. No active QA-pair containers were found at inspection. Saved group defaults alone
would not migrate these campaigns. Preserve the independent two-family conclusions, dissent,
evidence barriers and sole publisher when transferring judgment to retained frontier owners.
Ordinary scheduled task pins were not rewritten; explicit task intent stays separate from defaults.

## Source validation

NanoClaw: 63 roster/converter/sync tests, 353 receipt/generator tests, companion 27 pass/3 expected
skips, affected typechecks, build and reviewer freshness checks passed. Existing Sol/Opus exact-head
receipts remain accepted for compatibility; default new dispatch is frontier. Ratchet shrank six
lines. Source commits are local, not pushed. Final host profile reconciliation and service restart
remain approval-gated; no claim of fleet activation or week-long savings is made.

## Week measurement

For each accepted task record: task/artifact identity, coordinator and worker model/effort,
worker session ID, premium usage (measured or unavailable), elapsed time, repair rounds,
human interruptions and escaped defects. Keep API-equivalent cost separate from quota.
Trial starts only when installation and launch configuration are verified; no week outcome yet.

## Request reconciliation — 2026-09-13

The complete conversation-derived checklist is tasks.md. Latest installed versions are Claude
5.0.1 and Codex 2.0.1; installed orchestrate, shared contract and helper match canonical bytes.
All 14 ordinary container.json defaults were verified. No activation command has run: the
restart guard rejected it pending actual user approval. Campaign migration, ordinary scheduled-pin
audit, fresh activation checks and the seven-day evaluation remain open, not completed by audit.
The complete article could not be fetched on the latest retry (HTTP 403); do not claim it was read.

## Campaign migration implementation — staged, awaiting activation

Two Astra/medium owners completed the campaign policy and scheduled migration tooling; existing
independent Astra/medium reviewer cleared the final bundle. 56 live task rows audited; 37 changes
prepared with 17 files and two central config rows. Seven final synthetic migration cases pass.
Reviewed migrate.mjs SHA256: 60b0fc9c950385f87233e41d158cc17376ac1e48056adeec45484297a641ed34.
The task ledger records exact artifacts and the still-pending joint activation. Restart alone now
adopts existing containers, so activation includes explicit scoped container refresh.
