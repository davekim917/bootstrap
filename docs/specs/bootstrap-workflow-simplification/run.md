# Bootstrap workflow simplification — run

Status: ship authorized; bounded correction verified; release and host refresh in progress

## Approved contract

- Source: `docs/specs/bootstrap-workflow-simplification/plan.md`
- Approval: user approved implementation on 2026-07-26.
- Target: testable in fresh NanoClaw Claude, Codex, and OpenCode container sessions today.
- Branch: `main` (continued in the existing checkout by user-directed execution).

## Baseline

- `node scripts/check-parity.mjs`: PASS
- `plugins/workflow/hooks`: 446 tests passed
- `plugins/workflow-agents/hooks`: 28 tests passed
- `node --test evals/harness/*.test.mjs`: 39 tests passed

## Build ownership

### Group A — workflow core

Exclusive write scope:

- `plugins/workflow/skills/**`
- `plugins/workflow-agents/skills/**`
- `plugins/workflow-agents/scripts/sync-agent-skills.mjs`
- `plugins/workflow-agents/PARITY.md`

Contract: seven skills only; one generated cross-runtime source; explicit cross-model review models and efforts; no retired workflow stages.

### Group B — hooks

Exclusive write scope:

- `plugins/workflow/hooks/**`
- `plugins/workflow-agents/hooks/**`
- `scripts/vendor-guards.mjs`

Contract: remove workflow-created artifact/drift enforcement, preserve destructive/file/email/self-approval safety, and keep the simplified two-hour team-auto sentinel guard.

### Group C — integration and rollout

Runs after Groups A and B.

Exclusive write scope:

- `scripts/check-plugin-boundaries.mjs`
- `scripts/check-parity.mjs`
- `scripts/retire-bootstrap-agents.mjs`
- `scripts/retire-bootstrap-agents.test.mjs`
- `evals/**`
- `README.md`
- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`
- `plugins/workflow/.claude-plugin/plugin.json`
- `plugins/workflow-agents/.codex-plugin/plugin.json`
- `plugins/workflow-agents/marketplace-entry.json`

Contract: breaking-version packaging, contract-based parity tests, marker-safe reversible agent retirement, and container activation evidence.

## Findings and verification

### Build result

- Replaced the former workflow surface with exactly seven skills in both runtime plugins:
  `team-plan`, `team-build`, `team-review`, `team-auto`, `team-debug`, `team-ship`, and
  `team-retro`.
- Generated the Codex/OpenCode distribution from the canonical Claude source, including
  byte-identical workflow and cross-model contracts.
- Removed retired stages, references, drift/artifact hooks, and permanent-agent packaging.
- Kept destructive, protected-file, outbound-email, self-approval, managed-clone, and
  Snowflake-connector guards.
- Added breaking manifests: Claude `4.0.0`; Codex/OpenCode `1.0.0`.

### Deterministic verification

- `node --test scripts/retire-bootstrap-agents.test.mjs evals/harness/*.test.mjs`: 42 passed,
  0 failed.
- `plugins/workflow/hooks`: 436 tests passed, 0 failed; TypeScript check passed.
- `plugins/workflow-agents/hooks`: 29 tests passed, 0 failed; TypeScript check passed.
- `node scripts/check-parity.mjs`: passed generator, shared-contract, guard-vendoring, and
  boundary checks.
- `git diff --check`: passed.
- Edge cases checked: dry-run, marker-only deletion, unmanaged retired-name collision,
  collision-free multi-home quarantine, idempotent rerun, plugin-cache exclusion, exact marker
  matching, mutation between quarantine and deletion, stale/fresh auto sentinels, protected edits,
  destructive commands, email sends, and self-approval attempts.

### Independent implementation review

- Default Claude target: unavailable because the authenticated Claude account is quota-blocked.
- Approved alternate target: OpenCode `opencode-go/kimi-k2.7-code`, variant `high`.
- Isolation: one-off NanoClaw agent image with only `plan.md` and the 1.1 MB raw implementation
  diff mounted read-only; no repository or user-home mount.
- Effective runtime metadata: provider `opencode-go`, model `kimi-k2.7-code`, variant `high`.
- Timeout contract: 10 minutes. Process completed successfully within the boundary.
- Output: valid structured verdict `clear`; findings: none.
- Lead adjudication: no reviewer findings to accept or reject.

### Retired-agent migration

- Dry-run found exactly 12 marker-owned retired TOMLs across `~/.codex/agents` and
  `~/.codex-madison-reed-codex-fallback/agents`; no unmanaged collisions.
- Applied cleanup after quarantine, SHA-256 verification, and full-set live revalidation.
- Quarantine:
  `/home/ubuntu/.bootstrap-workflow-agent-quarantine/2026-07-26T14-13-11-472Z`
- Verified all 12 active originals are absent and all 12 quarantine copies match the manifest.
- Verified unrelated `worker`, `worker-codex`, `worker-opus`, and `codex-rescue` agents remain.
- `node scripts/check-plugin-boundaries.mjs --strict-home`: passed after cleanup.

### Container activation

- The first full NanoClaw restart exposed a stale-cache activation issue: the deployed image
  mounts the host Codex plugin cache read-only, and the host Bootstrap marketplace still targeted
  the last pushed Git revision (`0.5.1`).
- Repointed only `davekim917-bootstrap` to the live local checkout, reinstalled
  `bootstrap-workflow-agents@davekim917-bootstrap`, and verified the host cache is `1.0.0`.
- Removed the empty retired `plugins/workflow/agents/` and
  `plugins/workflow-agents/agents/` packaging directories before the final install.
- Verified from a live NanoClaw Codex container that the mounted cache contains only `1.0.0`,
  exposes exactly the seven skills, contains no retired advisor TOMLs, and carries both exact
  reviewer model/effort commands.
- Recycled `illysium-codex` again after correcting the cache. It is stopped and will start with a
  fresh in-memory registry on the next inbound message.
- Fresh Codex install in the current NanoClaw agent image accepted the `1.0.0` manifest and
  exposed exactly the seven skills.
- Fresh Claude install in the current NanoClaw agent image accepted the `4.0.0` manifest and
  exposed exactly the seven skills.
- The exact OpenCode startup discovery function returned exactly the seven skills from the live
  `~/plugins/bootstrap` source.
- Claude and OpenCode had no running containers to recycle; their next inbound messages will use
  fresh sessions and the current source.

### Bounded Codex-primary activation correction

- Live evidence showed that Codex-primary still copied host plugin tables and mounted
  `~/.codex/plugins` read-only even though peer-mode Codex had moved to container-owned
  registration. This made an unchanged local plugin version serve stale host-cache bytes.
- The correction removes host plugin/marketplace tables and the host-cache mount from the
  Codex-primary provider contribution. Each spawn rebuilds its derived session-local cache from
  `/workspace/plugins`.
- OAuth fallback homes now expose only their mutable host `auth.json` and rollout `sessions/`
  state through a session-local runtime home. They reuse the primary container-owned plugin cache
  and receive the same generated plugin/marketplace configuration.
- Focused host tests: 87 passed across the Codex provider, container runner, and provider surfaces.
- Focused container tests: 29 passed, 3 host-only filesystem cases skipped.
- Host and container TypeScript checks passed; `pnpm run build` passed; affected diff check passed.
- A one-off NanoClaw image verified Docker accepts the nested fallback auth/session mounts.
- A one-off NanoClaw image registered Bootstrap `1.0.0` once from `/workspace/plugins`; both the
  primary and fallback `CODEX_HOME` reported it installed and enabled, and the fallback cache was
  a symlink to the primary session-local cache.
- Full agent-runner run: 927 passed, 4 skipped, 2 failed. The timing failure passed immediately in
  isolation (509 ms). The remaining failure is outside this correction: the concurrent memory
  conformance test attempted to write the sandbox-read-only host
  `/home/ubuntu/.claude/settings.json`.
- Bootstrap verification remained green: 42 harness/migration tests, 436 Claude-hook tests,
  29 Codex/OpenCode-hook tests, both hook typechecks, parity generation/contracts, strict-home
  boundaries, and diff hygiene.

### Correction review state

- Required default reviewer command used Claude Opus 5 at high effort with the exact safe flags
  and a 10-minute timeout. The CLI accepted the invocation but returned HTTP 429 before inference:
  weekly limit reached, reset 2026-07-28 15:00 UTC.
- The previously approved Kimi K2.7 Code/high substitute was prepared with all tools denied and
  only `plan.md` plus the 39,761-byte affected-file diff attached.
- Execution was blocked before disclosure because sending private source artifacts to that
  external provider requires fresh explicit user authorization. No source was sent.
- The user then explicitly authorized disclosure of exactly `plan.md` and the 39,761-byte diff.
  The execution boundary still rejected the call because private-source disclosure to this
  external provider is non-overridable in the current environment. A second route was not
  attempted. No source was sent.
- Coverage is therefore `degraded` until that authorization is provided or Claude becomes
  available through the required trusted transport. Per `/team-auto`, no live restart or ship
  action was performed.

### User-directed fresh-context Codex review and bounded correction

- After the external Kimi transfer remained blocked, the user specifically directed a fresh-context
  Codex `5.6 Terra` subagent at `xhigh` effort as the replacement review for this run.
- Transport: platform `spawn_agent` with `fork_turns: none`, a read-only task brief, the approved
  `plan.md`, exact 39,761-byte affected-file diff, `run.md`, and applicable repository
  instructions. The subagent interface does not expose a model/effort selector or effective
  runtime metadata, so the requested model label and effort could not be independently
  cross-checked. This is independent fresh-context same-family coverage, not cross-model
  diversity; no cross-family claim is made.
- Status: `completed`. Raw verdict: `must_fix`.
- Accepted `MUST-FIX`: persisted session-local Codex runtime homes are container-writable, so the
  next host spawn could follow a planted intermediate `.tmp` symlink during cleanup or a planted
  generated-file symlink during writes and touch a host path outside the session.
- Accepted `MUST-FIX`: when no scoped or global host `config.toml` existed, the host did not replace
  the previous session-local config, allowing stale plugin/marketplace tables to survive while the
  cache was rebuilt.
- Accepted `SHOULD-FIX`: a first-use OAuth fallback without an existing host `sessions/` directory
  kept rollout history only in the NanoClaw session-local runtime, weakening rollback continuity.
- One bounded correction batch:
  - validates persisted runtime roots as real directories and fails closed on symlinks;
  - removes only final untrusted path entries, resets primary and fallback top-level derived
    `.tmp`/plugin entries, and recreates generated auth/config/agents targets without following
    prior symlinks;
  - always replaces primary and fallback `config.toml`, using an empty clean config when no host
    config exists;
  - validates fallback auth/config source entries as real files, then creates and validates the
    fallback host `sessions/` directory and binds it on every fallback spawn.
- Fresh correction evidence:
  - focused host suites: 91 passed across Codex provider, container runner, and provider surfaces;
  - focused container companion suite: 29 passed, 3 host-only filesystem cases skipped;
  - host TypeScript check, separate container TypeScript check, and `pnpm run build`: passed;
  - `git diff --check`: passed.
- Checked failure paths: poisoned primary and fallback `.tmp`, plugin, agents, auth, config,
  runtime-root, and fallback sessions/source symlinks; absent host config after stale session-local
  plugin tables; first-use fallback rollout directory creation; existing fallback rollout
  persistence; primary/fallback mount parity.
- Per the one-correction rule, only affected checks were rerun. No second repair/review loop was
  started.
