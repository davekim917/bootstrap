# Bootstrap workflow simplification

Status: approved 2026-07-26
Scope: `bootstrap-workflow` (Claude) and `bootstrap-workflow-agents` (Codex/OpenCode)

## Outcome

Replace the current ceremony-heavy workflow with a small, risk-scaled system that preserves the controls that have earned their keep:

1. `/team-plan` — first and only planning entry point; writes this feature's normative `plan.md`.
2. `/team-build` — implements the approved plan with proportional testing and delegation.
3. `/team-review` — reviews either a plan or an implementation and verifies findings before acting on them.
4. `/team-auto` — runs approved plan → build → review, then stops at the ship gate.
5. `/team-debug` — standalone evidence-first debugging.
6. `/team-ship` — separate human-controlled publish/merge boundary.
7. `/team-retro` — optional, short learning capture.

The routine artifact budget is:

- `docs/specs/<feature>/plan.md` — the approved product, design, and execution contract.
- `docs/specs/<feature>/run.md` — implementation state, verified findings, and verification evidence.
- `docs/specs/<feature>/.team-auto-active` — ephemeral auto-run sentinel, removed on exit.

## Non-negotiable behavior

### Simplicity contract

- Use the smallest mechanism that satisfies the real requirements and failure boundaries.
- Prefer existing project primitives, platform capabilities, and standard libraries.
- Add complexity only for evidenced scale, repetition, concurrency, security, or failure impact.
- Harden trust, authorization, credential, destructive-operation, and data-loss boundaries regardless of code size.
- A blocker must identify a violated requirement, invariant, or concrete failure mode.
- If the workflow's own revision or enforcement mechanism creates the blocker, stop after one productive correction. Classify it as either a flawed mechanism to remove or an external invariant that genuinely requires complexity; do not start another loop.
- `/team-auto` never ships.

### Cross-model diversity contract

Cross-model review remains mandatory at both consequential gates:

- `/team-plan` runs one independent other-family review of the raw proposed `plan.md` before asking for approval.
- `/team-review --implementation` runs one independent other-family review of the approved plan plus raw implementation diff after the build.

The reviewer gets the source artifact, not the lead model's conclusions. It is read-only and its findings are hypotheses. The lead must trace each proposed MUST-FIX to source and prove a violated invariant or concrete failure mode.

Default transports:

- Claude primary → Codex: `codex exec --ignore-user-config --model gpt-5.6-sol -c 'model_reasoning_effort="xhigh"' --ephemeral --sandbox read-only`. The review contract sets both values explicitly and does not inherit model or effort from any host or container `config.toml`.
- Codex/OpenCode primary → Claude: `claude -p --model claude-opus-5 --effort high --safe-mode --no-session-persistence --permission-mode plan --tools "" --strict-mcp-config --output-format json`.

An explicitly configured safe target from another model family may substitute when the default target is unavailable, but the run must record the actual model and transport. Runtime diversity alone does not count: an OpenCode target satisfies this gate only when its model family differs from the primary.

Every external review process has a fixed 10-minute timeout and must return non-empty, parseable structured output with a verdict. A timeout, non-zero exit, malformed output, or empty result is unavailability—not a completed review. Do not retry automatically. Never weaken sandboxing or permissions to preserve diversity. A same-family pass may add coverage but cannot be reported as cross-model. If no other-family target succeeds, report degraded coverage explicitly; manual workflows require the user's decision to proceed, and `/team-auto` stops once with the evidence instead of looping.

The skill preflight distinguishes missing CLI, unauthenticated CLI, unsupported flags, timeout, and invalid reviewer output in `run.md`. Installation tests verify the exact flags against the installed CLIs and execute a no-op structured review in each direction. Claude receives the review bundle on stdin with `--tools ""`, so it has no repository tools; any alternate target must provide an equivalent read-only sandbox or an isolated review workspace containing only the copied input.

One other-family reviewer is the default. Add lenses or reviewers only when the changed trust boundary or domain risk justifies them.

## Changes

### 1. Collapse the skill surface

Rewrite these skills in both runtime plugins around one short shared contract:

- `team-plan`
- `team-build`
- `team-review`
- `team-auto`
- `team-debug`
- `team-ship`
- `team-retro`

Delete these standalone skills and absorb only their useful behavior:

- `best-practice-check`
- `review-swarm`
- `team-brief`
- `team-design`
- `team-drift`
- `team-qa`
- `team-receiving-review-feedback`
- `team-tdd`
- `team-verification-before-completion`

Specific ownership after the collapse:

- `team-plan` absorbs requirements clarification, constraints, alternatives when they are real, architecture, scope, acceptance criteria, implementation decomposition, and plan-stage cross-model review.
- `team-build` absorbs proportional test-first work, delegation, debugging, and implementation-state recording.
- `team-review` absorbs drift checks, QA, best-practice lookup, security/performance/domain lenses, review-feedback verification, and completion evidence.
- `team-auto` becomes a short state machine over the three stages; it permits one evidence-backed correction and trips immediately on self-created obstruction.
- `team-plan`'s description owns semantic routing for non-trivial feature work; there is no separate routing skill.

Behavior retained from each removed skill:

| Removed skill | Retained behavior | New owner |
|---|---|---|
| `team-brief`, `team-design` | Requirements, constraints, acceptance criteria, architecture, and real alternatives | `team-plan` |
| `best-practice-check` | Current authoritative-source lookup when a decision depends on a changeable external API, framework, security rule, or standard | `team-plan` or `team-review`, where the question arises |
| `review-swarm` | Independent review context, cross-model diversity, and risk-selected specialist lenses | `team-review` |
| `team-drift` | Approved-plan versus implementation-diff comparison | `team-review --implementation` |
| `team-qa` | Relevant tests, typechecks, lint/build checks, diff review, and ship-readiness evidence | `team-review --implementation` |
| `team-tdd` | Test-first implementation when behavior can fail and a focused test is practical | `team-build` |
| `team-receiving-review-feedback` | Treat findings as hypotheses; trace and verify before changing code | `team-review` lead |
| `team-verification-before-completion` | Fresh command output and checked edge cases before completion claims | `team-build`, `team-review`, and `team-ship` |

Do not preserve headings, templates, or subprocesses merely for parity with the old workflow.

### 2. Make one source produce both runtime contracts

- Add one shared workflow contract and one shared cross-model review contract under the Claude source tree.
- Update `plugins/workflow-agents/scripts/sync-agent-skills.mjs` to generate every mechanically equivalent skill and shared reference into the Codex/OpenCode tree.
- Keep runtime-specific dispatch in small explicit sections or runtime-specific references only where the actual tool APIs differ.
- Replace the current heading-count parity test with contract tests for skill names, required invariants, mirrored shared files, safe cross-model transports, and absence of retired stages.
- Update `plugins/workflow-agents/PARITY.md` to describe this source-of-truth boundary.

### 3. Remove workflow-created enforcement machinery

Delete the pre-build drift gate and its artifact protocol:

- `plugins/workflow/hooks/guards/workflow-gate-enforcement.ts`
- `plugins/workflow/hooks/guards/workflow-gate-enforcement.test.ts`
- the `TaskCreated` registration in `plugins/workflow/hooks/workflow-hooks.json`

Delete the advisory workflow-artifact-path hook and its tests. `plan.md` and `run.md` locations are a skill contract, not a filesystem safety boundary.

Keep the real safety controls:

- destructive-command approval/blocking
- protected-file enforcement
- outbound-email approval
- self-approval prevention
- the `.team-auto-active` user-input guard

Simplify the auto guard's recovery message to: remove the sentinel, record the single evidenced blocker in `run.md`, and stop. Remove `auto-pause.md`, `decisions.yaml`, and multi-cycle instructions.

The sentinel is a guard, not an unbounded lock. A fresh sentinel for the same feature means another auto run may be active, so a second run stops. The active run refreshes it at every stage transition and immediately before and after any command expected to run longer than ten minutes. Sentinels with no refresh for two hours are stale: the input guard ignores them, and a new run records and removes the stale file before starting. Normal success, review failure, tool failure, and deliberate stop all remove the sentinel. A hard process kill is recovered through the stale rule rather than pretending cleanup can be guaranteed.

### 4. Retire leaked permanent agents safely

Add `scripts/retire-bootstrap-agents.mjs` as an idempotent cleanup/migration:

- Dry-run by default; `--apply` performs deletion.
- Inspect active Claude (`~/.claude/agents`), Codex sibling-home (`~/.codex*/agents`), and OpenCode (`~/.config/opencode/agent` and `~/.local/share/opencode*/agent`) locations, but never plugin caches.
- Delete only one of the six retired basenames when the file also contains the exact Bootstrap ownership marker `# managed by bootstrap-workflow-agents agent-sync`.
- Preserve every unmanaged file and every non-retired managed file.
- Cover all discovered `~/.codex*/agents` sibling homes, not only the default `~/.codex`.

The retired names are:

- `architecture-advisor`
- `code-review-specialist`
- `cpo-advisor`
- `cto-advisor`
- `performance-analyzer`
- `security-reviewer`

Extend `scripts/check-plugin-boundaries.mjs --strict-home` to fail when marker-owned retired agents remain active. Before deleting, `--apply` writes every target beneath one timestamped quarantine root while preserving its full original home-relative path, plus a manifest of original absolute path and content hash. Files with the same basename from different homes cannot collide, and rollback is a file restore rather than a code reconstruction.

During this rollout, apply the cleanup to the two currently verified homes—`~/.codex/agents` and `~/.codex-madison-reed-codex-fallback/agents`—confirm the unrelated agent TOMLs remain, and restart the affected NanoClaw Codex sessions/containers so cached configuration is unloaded. No retired copies currently exist in the inspected Claude or OpenCode homes; if the migration discovers any at apply time, restart that affected runtime too. If live verification regresses because of the retirement, stop before ship, restore from quarantine, restart the affected runtime, and record the evidence in `run.md`.

### 5. Update packaging and documentation

- Update README workflow guidance and examples.
- Update both plugin manifests, both marketplace entries, interface copy, and keywords.
- Use breaking versions because installed skills disappear: Claude `4.0.0`; Codex/OpenCode `1.0.0`.
- Replace old brief/design/review/QA eval fixtures with workflow-core cases.
- Remove obsolete templates, references, source pins, and tests owned only by retired stages.

## Verification

### Deterministic tests

- Skill inventory is exactly the seven user-facing skills in both plugins.
- Shared contracts are byte-identical after generation.
- No active skill, hook, manifest, README section, or eval references a retired stage or artifact.
- Both cross-model commands retain their safe/read-only flags, explicitly set model and effort, and record those values in `run.md`.
- The Codex lane explicitly invokes `gpt-5.6-sol` / `xhigh` with `--ignore-user-config`; it does not inherit review settings from `config.toml`.
- The Claude lane explicitly invokes `claude-opus-5` / `high`.
- Cross-model preflight distinguishes missing, unauthenticated, unsupported, timed-out, and malformed-review failures.
- Cross-model unavailability is labeled degraded and cannot be silently replaced by a same-family reviewer.
- `team-plan` writes `plan.md` and performs the plan review before approval.
- `team-build` accepts one cohesive worker and does not require parallelism.
- `team-review` selects lenses from risk, validates findings, and records actual evidence in `run.md`.
- `team-auto` performs at most one productive correction batch: changes that resolve verified MUST-FIX findings without creating a new workflow-origin blocker. It re-runs only the affected checks once, then either clears or stops. It refreshes active sentinels, recovers stale ones, and never calls `team-ship`.
- Existing destructive, protected-file, email, and self-approval guard tests still pass in both runtime plugins.
- Removed drift/artifact hooks are absent from manifests and distributions.

### Behavioral fixtures

- A four-file mechanical change can use a direct plan/build/review path without a full assembly line.
- A one-file credential or destructive migration receives the necessary security and rollback depth.
- Repeated high-frequency work can justify automation even when one occurrence is simple.
- A simplified design still protects authorization and data-loss boundaries.
- A review claim without a violated invariant cannot become MUST-FIX.
- A correction that creates a new workflow-only blocker stops instead of entering another cycle.
- Both Claude-primary and Codex/OpenCode-primary runs use the other model family at plan and implementation review gates.

### Agent-retirement tests

- Dry-run reports but does not delete.
- `--apply` deletes only marker-owned retired basenames.
- Re-running is a no-op.
- An unmanaged collision with a retired basename is preserved and reported.
- Multiple `.codex*` homes are covered.
- Unrelated agents such as `worker`, `worker-codex`, `worker-opus`, `codex-rescue`, and Impeccable agents remain.

### Commands and live checks

- Run hook typechecks and test suites in both plugin trees.
- Run `node scripts/check-parity.mjs`.
- Run `node scripts/check-plugin-boundaries.mjs --strict-home` after cleanup.
- Run the eval harness's deterministic tests and selected workflow-core model fixtures.
- Validate both plugin manifests with their installed CLIs.
- Exercise one plan review and one implementation review in each primary-runtime direction.
- Verify the twelve currently identified stale TOMLs are gone, unrelated TOMLs remain, affected containers were restarted, and a fresh Codex session no longer advertises or invokes the retired advisors.

## Execution order

1. Rewrite the shared contract, retained skills, cross-model transports, and contract tests.
2. Remove retired skills, hooks, artifacts, and old evals; regenerate the Codex/OpenCode distribution.
3. Add and test the marker-safe agent cleanup.
4. Update packaging and documentation, then run the full deterministic and model-backed verification.
5. Apply the cleanup to active homes and verify the live NanoClaw behavior.
6. Stop at `/team-ship` with the complete diff, test evidence, cleanup evidence, and any genuinely degraded coverage.

## Approval gate

No implementation begins until this plan and its independent cross-model review are approved.
