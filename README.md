# bootstrap

A risk-scaled delivery workflow for Claude Code, Codex, and OpenCode:

```text
/team-plan → /team-build → /team-review → /team-ship
```

The workflow uses the smallest mechanism that satisfies the real requirements and failure
boundaries. A four-file mechanical change should stay small; a one-file credential or destructive
migration still receives security, rollback, and verification depth. Complexity must be justified
by scale, repetition, concurrency, security, or failure impact—not by a fixed ceremony.

## Plugins

| Runtime | Plugin | Version | What it provides |
|---|---|---:|---|
| Claude Code | `bootstrap-workflow` | 5.0.5 | Claude-native workflow skills and safety gates |
| Codex / OpenCode | `bootstrap-workflow-agents` | 2.0.5 | Runtime-neutral workflow skills and safety gates |
| Claude Code / Codex | `wwbd` | 1.2.2 | Boris Cherny-inspired engineering-judgment advisory skill |
| Claude Code / Codex / NanoClaw | `concise` | 1.0.1 | Session-only concise, grammatical chat mode |

Both workflow plugins expose seven team skills plus `/orchestrate`:

| Skill | Purpose |
|---|---|
| `/team-plan` | First planning entry point; writes the normative `plan.md` and runs its independent review |
| `/team-build` | Implements the approved plan with proportional testing and delegation |
| `/team-review` | Reviews a plan or implementation, verifies findings, and records evidence |
| `/team-auto` | Runs approved plan → build → review, then hands off to `/team-ship` |
| `/team-debug` | Diagnoses root cause from evidence before changing production code |
| `/team-ship` | Lands reversible work itself; asks a human before anything that deploys or cannot be undone |
| `/team-retro` | Optionally captures short, reusable lessons after delivery |

`/team-plan` absorbs requirements, constraints, architecture, acceptance criteria, and execution
decomposition. `/team-review` selects QA, drift, security, performance, best-practice, and domain
lenses only when the actual risk warrants them. A finding becomes MUST-FIX only after the lead
traces it to a violated invariant or concrete failure mode.

`/team-auto` shares a maximum of 3 corrective rounds across build/test/review, with one
reconsideration on repeated failure signatures. No progress or repeated workflow-created obstruction
stops the run; a second productive failure alone does not. It never deploys: it hands off to `/team-ship`, which stops at anything that deploys.

## Workflow artifacts

Substantial work uses two minimal durable artifacts; simple tasks can report evidence in chat:

- `docs/specs/<feature>/plan.md` — the approved product, design, and execution contract.
- `docs/specs/<feature>/run.md` — current stage, verified findings, actual reviewer/model details,
  and verification evidence valid for the exact artifact, environment and command.

`docs/specs/<feature>/.team-auto-active` is an ephemeral concurrency sentinel, not another review
document. It is removed on normal exit and recovered after two hours without refresh.

## Cross-model review

Independent other-family review is mandatory at both consequential gates:

1. `/team-plan` reviews the raw proposed plan before consequential implementation.
2. `/team-review --implementation` reviews the approved plan plus raw implementation diff.

Routine work does not automatically need both gates; explicit requested reviews are honored.
Choose the other family relative to the artifact author, not the coordinator.
The review receives source artifacts, not the lead model's conclusions, and is non-mutating.
Findings are hypotheses until verified by the lead. The plugin explicitly selects reviewer model
and effort; it never inherits them from host or container configuration.

Claude-authored artifact reviews use (medium default, explicit validated overrides allowed):

```bash
codex exec \
  --ignore-user-config \
  --model gpt-6-astra \
  -c 'model_reasoning_effort="medium"' \
  --ephemeral \
  --yolo
```

Codex-authored artifact reviews use:

```bash
claude -p \
  --model claude-fable-5-1 \
  --effort medium \
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

## One-week frontier-owner trial

Ordinary coordinators run Sonnet/xhigh or Terra/xhigh and directly perform only brief logistical
or mechanical actions. Delegate substantive design, implementation, research/synthesis, debugging,
technical planning and judgment-heavy review to frontier models by default. No file-count or
cheap-first hurdle applies, and task length alone does not justify a downgrade. Ambiguity, novel
design, visual taste, security, concurrency and high-consequence judgments favor frontier quality.

One retained `worker-frontier` owns investigation, design, build, tests and repair. Its worker
floor is Claude Fable 5.1 or Opus 5, and Codex GPT-6 Astra or GPT-5.6 Sol. Fable/Astra default to
medium; Opus/Sol are first-class dynamic selections, chosen once at task start based on user
direction, task/model fit, observed trial results, or provider availability. Never delegate
substantive work below that floor. Record the actual model, effort, reason and checks; if no
approved worker is available, report the limitation instead of silently downgrading. There is one
worker role and no retry ladder.

Launch ordinary coordinator sessions with:

```sh
claude --model sonnet --effort xhigh
codex --model gpt-5.6-terra -c 'model_reasoning_effort="xhigh"'
```

Worker defaults remain medium. Validate actual runtime metadata separately from saved settings.
Choose native or CLI ownership at task start: native handles stay with their parent; helper
`--resume` accepts only its own CLI UUID. An approved alternate model uses helper `--model` from
the start because the native Codex worker is model-pinned. Never silently replay work after a
transport switch fails. Runtime profiles are host-managed; this plugin installs no permanent agents.

Existing conversational approval survives factual and test-detail plan refinements. New product,
scope, trust and destructive boundaries retain their gates. Tests target observable acceptance;
there is no required exact test skeleton or repeated stage-by-stage test ceremony. Reuse evidence
only for the unchanged artifact, relevant environment and command; invalidate it after relevant changes.

Record usage per accepted task (including failed attempts), elapsed time, repair rounds, escaped
defects and human interruptions with reasons. Mark unavailable measurements unknown. Review the
trial after one week using observed outcomes; this release does not claim measured savings.

## Install

### Claude Code

```text
/plugin marketplace add davekim917/bootstrap
/plugin install bootstrap-workflow@davekim917-bootstrap
/plugin install wwbd@davekim917-bootstrap
/plugin install concise@davekim917-bootstrap
```

### Codex

```bash
codex plugin marketplace add davekim917/bootstrap --ref main
codex plugin add bootstrap-workflow-agents@davekim917-bootstrap
codex plugin add wwbd@davekim917-bootstrap
codex plugin add concise@davekim917-bootstrap
```

For a local checkout at `~/plugins/bootstrap`:

```bash
codex plugin marketplace add ~/plugins/bootstrap
codex plugin add bootstrap-workflow-agents@davekim917-bootstrap
codex plugin add wwbd@davekim917-bootstrap
```

Codex loads the plugin from its cache through `.codex-plugin/plugin.json`; do not copy workflow
skills or agent definitions into a user home.

WWBD is installed separately from the workflow plugin. After installing it, start a new Codex
session so its WWBD skill is available. Verify installation with `codex plugin list`.
Claude also gets a SessionStart reminder; Codex discovers the advisory skill through its native
plugin skill loader.

### Concise

`concise` is opt-in and applies only to the current conversation. In Claude Code, Codex, or
NanoClaw, ask to "use the concise skill". Ask to "turn concise mode off" to restore the session's
usual response style. It never becomes a persistent preference, shared instruction, or always-on
mode. Start a fresh host session after installing the plugin so its skill catalog includes it.

The canonical skill for every runtime is
`~/plugins/bootstrap/plugins/concise/skills/concise/SKILL.md`. From the NanoClaw checkout, run the enabler to mirror its
skill to OpenCode; Claude and Codex read the declared plugin directly from the container mount:

```bash
pnpm exec tsx scripts/enable-agent-plugin.ts bootstrap
```

Respawn the target agent after an update. Do not copy this skill into `container/skills/` or create
a NanoClaw always-on ruleset.

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

- Claude's workflow plugin installs from `plugins/workflow`.
- Codex/OpenCode's workflow plugin installs from `plugins/workflow-agents`.
- Claude and Codex can also install the shared `plugins/wwbd` advisory plugin.
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
│   ├── workflow-agents/
│   ├── wwbd/
│   └── concise/
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
