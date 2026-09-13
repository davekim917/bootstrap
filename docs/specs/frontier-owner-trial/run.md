# Frontier owner trial — implementation record

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

- Bootstrap Claude 5.0.0 and Codex 2.0.0 generated from the canonical workflow tree.
- Plugin parity passed; 48 harness/retirement tests passed; 7 foreground-helper tests passed.
- Both hook typechecks and 30 Codex hook tests passed. Claude hooks unchanged: 586/586 pass from
  canonical cwd; /tmp worktree cwd changes ephemeral-path semantics and causes 12 fixture failures.
- Independent fresh Astra/medium review found the unnecessary frontier transport wrapper and
  missing descendant cancellation. Wrapper retired; direct helper retained. Process-group timeout
  and signal cleanup now pass original reviewer reproduction and descendant survival regressions.
- Review coverage is same-family by explicit user instruction; no Fable inference was launched.
- Native provider inference/default-effort activation and live host restart remain separate below.

## Week measurement

For each accepted task record: task/artifact identity, coordinator and worker model/effort,
worker session ID, premium usage (measured or unavailable), elapsed time, repair rounds,
human interruptions and escaped defects. Keep API-equivalent cost separate from quota.
Trial starts only when installation and launch configuration are verified; no week outcome yet.
