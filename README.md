# bootstrap

A risk-scaled delivery workflow for Claude Code, Codex, and OpenCode:

```text
/team-plan → /team-build → /team-review → human-controlled /team-ship
```

The workflow uses the smallest mechanism that satisfies the real requirements and failure
boundaries. A four-file mechanical change should stay small; a one-file credential or destructive
migration still receives security, rollback, and verification depth. Complexity must be justified
by scale, repetition, concurrency, security, or failure impact—not by a fixed ceremony.

## Plugins

| Runtime | Plugin | Version | What it provides |
|---|---|---:|---|
| Claude Code | `bootstrap-workflow` | 4.0.3 | Claude-native workflow skills and safety gates |
| Codex / OpenCode | `bootstrap-workflow-agents` | 1.0.3 | Runtime-neutral workflow skills and safety gates |

Both plugins expose exactly seven user-facing skills:

| Skill | Purpose |
|---|---|
| `/team-plan` | First planning entry point; writes the normative `plan.md` and runs its independent review |
| `/team-build` | Implements the approved plan with proportional testing and delegation |
| `/team-review` | Reviews a plan or implementation, verifies findings, and records evidence |
| `/team-auto` | Runs approved plan → build → review, then stops at the ship gate |
| `/team-debug` | Diagnoses root cause from evidence before changing production code |
| `/team-ship` | Performs the separate, human-controlled publish or merge boundary |
| `/team-retro` | Optionally captures short, reusable lessons after delivery |

`/team-plan` absorbs requirements, constraints, architecture, acceptance criteria, and execution
decomposition. `/team-review` selects QA, drift, security, performance, best-practice, and domain
lenses only when the actual risk warrants them. A finding becomes MUST-FIX only after the lead
traces it to a violated invariant or concrete failure mode.

`/team-auto` permits one evidence-backed correction. If its own enforcement or revision creates a
new blocker, it records the evidence and stops instead of entering another loop. It never ships.

## Workflow artifacts

Routine work has only two durable artifacts:

- `docs/specs/<feature>/plan.md` — the approved product, design, and execution contract.
- `docs/specs/<feature>/run.md` — current stage, verified findings, actual reviewer/model details,
  and fresh verification evidence.

`docs/specs/<feature>/.team-auto-active` is an ephemeral concurrency sentinel, not another review
document. It is removed on normal exit and recovered after two hours without refresh.

## Cross-model review

Independent other-family review is mandatory at both consequential gates:

1. `/team-plan` reviews the raw proposed `plan.md` before asking for approval.
2. `/team-review --implementation` reviews the approved plan plus raw implementation diff.

The review receives source artifacts, not the lead model's conclusions, and is non-mutating.
Findings are hypotheses until verified by the lead. The plugin explicitly selects reviewer model
and effort; it never inherits them from host or container configuration.

Claude-primary reviews use:

```bash
codex exec \
  --ignore-user-config \
  --model gpt-5.6-sol \
  -c 'model_reasoning_effort="high"' \
  --ephemeral \
  --yolo
```

Codex/OpenCode-primary reviews use:

```bash
claude -p \
  --model claude-opus-5 \
  --effort high \
  --safe-mode \
  --no-session-persistence \
  --permission-mode plan \
  --tools "" \
  --strict-mcp-config \
  --output-format json
```

Each external reviewer runs in the foreground with a 60-minute process ceiling. For Codex,
`--yolo` avoids the inner sandbox that cannot create namespaces inside nested Docker; the NanoClaw
container is the external isolation boundary, while the review contract remains non-mutating and
supplies its source bundle on stdin. Missing or unauthenticated CLIs, unsupported flags, timeouts,
non-zero exits, and malformed or empty output are recorded distinctly in `run.md`. The workflow
does not retry automatically or call a same-family pass “diverse.” Manual work asks the user
whether to proceed with degraded coverage; `/team-auto` stops once.

## Install

### Claude Code

```text
/plugin marketplace add davekim917/bootstrap
/plugin install bootstrap-workflow@davekim917-bootstrap
```

### Codex

```bash
codex plugin marketplace add davekim917/bootstrap --ref main
codex plugin add bootstrap-workflow-agents@davekim917-bootstrap
```

For a local checkout at `~/plugins/bootstrap`:

```bash
codex plugin marketplace add ~/plugins/bootstrap
codex plugin add bootstrap-workflow-agents@davekim917-bootstrap
```

Codex loads the plugin from its cache through `.codex-plugin/plugin.json`; do not copy workflow
skills or agent definitions into a user home.

## Upgrading from pre-4.0 / pre-1.0

Older Bootstrap releases leaked six permanent Codex agent definitions into active runtime homes.
Version 4.0.0/1.0.0 no longer ships permanent agents. Preview the marker-safe cleanup:

```bash
node scripts/retire-bootstrap-agents.mjs
```

Then apply it:

```bash
node scripts/retire-bootstrap-agents.mjs --apply
```

Dry-run is the default. Apply mode removes only the six retired basenames carrying the exact
Bootstrap ownership marker. Before deletion it writes a timestamped quarantine preserving each
file's full home-relative path and a manifest containing its absolute source and SHA-256 hash.
Unmanaged collisions, unrelated agents, and plugin caches are preserved. Restart affected
Claude, Codex/NanoClaw, or OpenCode sessions after cleanup so cached definitions are unloaded.

## Runtime and safety boundaries

- Claude installs only `plugins/workflow`.
- Codex/OpenCode installs only `plugins/workflow-agents`.
- Reviewer identities are bounded prompt roles, never globally installed permanent agents.
- Mechanically portable skills and shared contracts are generated from the Claude source tree.
- Shared destructive and protected-file guards are authored once and vendored to the agent plugin.
- Both plugins retain destructive-command, outbound-email, self-approval, managed-clone,
  Snowflake-connector, and protected-file safety checks.
- Planning and review artifacts are workflow contracts, not filesystem safety boundaries.

## Repository structure

```text
bootstrap/
├── .agents/plugins/marketplace.json
├── .claude-plugin/marketplace.json
├── plugins/
│   ├── workflow/
│   └── workflow-agents/
├── evals/
├── scripts/
└── deprecated/
```

## Development checks

```bash
node --test scripts/retire-bootstrap-agents.test.mjs
node --test evals/harness/*.test.mjs
node scripts/check-plugin-boundaries.mjs
node scripts/check-parity.mjs

cd plugins/workflow/hooks && bun test && bun run check
cd plugins/workflow-agents/hooks && bun test && bun run check
```

Use `node scripts/check-plugin-boundaries.mjs --strict-home` after retirement cleanup to fail on
marker-owned retired agents still active in Claude, Codex sibling-home, or OpenCode agent roots.

## Prerequisites

- Claude Code for `bootstrap-workflow`
- Codex with native plugin support for `bootstrap-workflow-agents`
- Bun for TypeScript hooks

## License

MIT
