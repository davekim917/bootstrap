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
| Claude Code | `bootstrap-workflow` | 5.7.0 | The seven `team-*` skills and the safety gates |
| Codex / OpenCode | `bootstrap-workflow-agents` | 2.7.0 | The same, runtime-neutral |
| Claude Code / Codex / OpenCode | `bootstrap-orchestrate` | 2.0.0 | `/orchestrate`, an invoke-only skill, plus the five effort shims it dispatches to |
| Claude Code / Codex | `wwbd` | 1.3.0 | Boris Cherny-inspired engineering-judgment advisory skill |
| Claude Code / Codex / NanoClaw | `concise` | 1.0.1 | Session-only concise, grammatical chat mode |

### Delegation is invoke-only

Automatic delegation pressure is off. Working directly is the normal mode: nothing
tells a session to reach for a sub-agent, and nothing gates a session that reads
source, runs a check, or implements a fix itself.

`bootstrap-orchestrate` activates nothing on its own: no `always-on.md`, no
`SessionStart` hook, no `hooks` field in either manifest. Invoke it when you want one
sub-agent to do all the implementation in a single thread — "use an opus subagent
with high effort", "delegate this to fable", or plain `/orchestrate`.

Two mechanisms used to create the pressure, and both were deleted rather than moved:
the standing `SessionStart` directive that told every session to load the skill, and
the `dispatch-first` PreToolUse guard, which warned and then BLOCKED a coordinator
that read implementation source or ran a check before dispatching.

The `team-*` skills still delegate when you invoke one — the shared workflow contract
they load says to hand substantive work to a sub-agent and keep it for the whole task.
That is deliberate: `/team-build` is an explicit request for the delegated workflow.
What is gone is the *automatic* pressure, not delegation itself.

### What `/orchestrate` is

A parameterized delegation prompt, and nothing else. You give it a model and an effort
level; it dispatches ONE sub-agent, hands it the brief, and keeps that same sub-agent
for every later round. You coordinate and test; the sub-agent is told not to test or
review its own work, so the verification comes from outside it.

| Parameter | Meaning | Default |
|---|---|---|
| `{model}` | the sub-agent's model, as this runtime names it | this session's model |
| `{effort_level}` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | this session's effort |
| `{rounds}` | coordinate→delegate cycles before stopping | 3 |
| `{done}` | the completion signal | the sub-agent says the work is complete |

There is no role behind it, no approved model floor, and no helper CLI. Dispatch goes
through whatever the runtime already has: Claude Code's `Agent` tool, Codex's
`spawn_agent`, OpenCode's `task` tool.

The one thing the plugin ships besides the skill is five near-empty agent definitions,
`agents/delegate-<level>.md`. They exist because Claude Code's `Agent` tool takes a
`model` per call but not an `effort` — effort can only be pinned in an agent
definition's frontmatter. So each shim pins one level, sets `model: inherit` so the
dispatch still chooses the model, and carries a single line of body. They are not
roles, and the drift gates assert exactly that: five files, `model: inherit`, and a
body too short to hold a contract.

`scripts/plugin-enablement.mjs` prints the composed session for any plugin set, and
`scripts/plugin-enablement.test.mjs` resolves and RUNS the hooks each state registers,
asserting that enabling `bootstrap-orchestrate` adds no directive and no gate:

```bash
node scripts/plugin-enablement.mjs bootstrap-workflow                        # disabled
node scripts/plugin-enablement.mjs bootstrap-workflow bootstrap-orchestrate  # enabled
```

The workflow plugins expose the seven team skills; `/orchestrate` ships beside them
in its own plugin:

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

## Delegating work

The `team-*` skills hand substantive work — design, implementation, research,
debugging, judgment-heavy review — to a sub-agent, and keep that same sub-agent for
the whole task. Independent review still starts in a fresh context, because a reviewer
is chosen for independence from the artifact's author.

There is no approved model floor and no named worker role. Pick the model and the
effort at dispatch from the task shape, record what you actually picked, and retain it
for that sub-agent's build/test/fix loop. `shared/workflow-contract.md` carries the
effort rubric: `low` for mechanical work, the dispatched default for bounded
implementation, `high` for debugging without a known root cause or a trust-boundary
change, `xhigh` when `high` did not resolve it, `max` only on evidence that `xhigh`
was insufficient.

The previous release pinned all of this to one hand-edited JSON policy file in the
workflow plugin. It rendered a named worker agent definition, a Codex role TOML, a
`SessionStart` installer that copied the TOML into the user's Codex home, and a Node
CLI transport mirrored into four plugins. Every piece of that is deleted. Naming a
model and an effort at dispatch is the thing the policy existed to decide, and the
runtime's own sub-agent tool is the transport. Upgrading needs no cleanup on your
side: the role only ever reached a Codex home through that installer, and
`node scripts/retire-bootstrap-agents.mjs` still removes marker-owned leftovers.

Record saved defaults, requested settings and actual runtime metadata separately: a
saved setting does not prove what the session ran at. Existing conversational approval
survives factual and test-detail plan refinements; new product, scope, trust and
destructive boundaries keep their gates. Reuse evidence only for the unchanged
artifact, environment and command, and invalidate it after relevant changes.


## Install

### Claude Code

```text
/plugin marketplace add davekim917/bootstrap
/plugin install bootstrap-workflow@davekim917-bootstrap
/plugin install bootstrap-orchestrate@davekim917-bootstrap
/plugin install wwbd@davekim917-bootstrap
/plugin install concise@davekim917-bootstrap
```

### Codex

```bash
codex plugin marketplace add davekim917/bootstrap --ref main
codex plugin add bootstrap-workflow-agents@davekim917-bootstrap
codex plugin add bootstrap-orchestrate@davekim917-bootstrap
codex plugin add wwbd@davekim917-bootstrap
codex plugin add concise@davekim917-bootstrap
```

For a local checkout at `~/plugins/bootstrap`:

```bash
codex plugin marketplace add ~/plugins/bootstrap
codex plugin add bootstrap-workflow-agents@davekim917-bootstrap
codex plugin add bootstrap-orchestrate@davekim917-bootstrap
codex plugin add wwbd@davekim917-bootstrap
```

Codex loads the plugin from its cache through `.codex-plugin/plugin.json`; do not copy workflow
skills or agent definitions into a user home.

`codex plugin add` is what writes the `[plugins."<name>@davekim917-bootstrap"]` stanza with
`enabled = true` into `~/.codex/config.toml`. Enablement is **per plugin and opt-in**, so an
existing Codex install does not pick up `bootstrap-orchestrate` when the marketplace gains
it — run the `add` above (or add the stanza by hand) once per host.

### Reaching NanoClaw containers

Container Claude agents need no NanoClaw change. `discoverPlugins` walks `~/plugins` three levels
deep for a `.claude-plugin/plugin.json` and hands each hit to the SDK as a `plugins:` entry, which
is what loads a plugin's declared hooks; `plugins/bootstrap/plugins/wwbd` matches at the third
level. The orchestrate plugin declares no hooks at all, so there is nothing to load for it.
Neither plugin ships a `nanoclaw-plugin.json`, and neither should: that file's
`preToolUseGuards` is a de-duplication signal telling NanoClaw to stand down one of its OWN
built-in gates, and `bash-email` is the only value anything consumes. `check-plugin-boundaries`
fails if one appears in the orchestrate plugin.

WWBD is installed separately from the workflow plugin. After installing it, start a new Codex
session so its WWBD skill is available. Verify installation with `codex plugin list`.
Both runtimes get the same SessionStart reminder from the plugin's own hook; Codex additionally
discovers the advisory skill through its native plugin skill loader.

WWBD is the only plugin here that still ships a standing directive, and it shows how one is
delivered: **the runtime's own plugin declares a `SessionStart` command hook that cats the
`always-on.md` in its own plugin root**, and the hook's stdout is injected into the model's
context. Claude's `hooks/wwbd-hooks.json` resolves `${CLAUDE_PLUGIN_ROOT}`; the Codex manifest
declares a second file, `hooks/wwbd-codex-hooks.json`, resolving `${PLUGIN_ROOT}` — Codex does not
expand the Claude token. Nothing outside a plugin delivers a directive, so disabling the plugin
removes it on every runtime at once. Adding a hook to a plugin that had none means Codex asks once
to trust that plugin's hooks on the next session start.

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
- `/orchestrate` installs from `plugins/orchestrate` on every runtime — one directory with both
  manifests, the `wwbd` shape. It is invoke-only, with no standing directive, no hooks and no
  scripts, so it can be disabled without touching the `team-*` skills or any safety guard.
- `skills/shared/` is carried by BOTH workflow plugins, not shared by reference: an installed
  marketplace cache materializes only the plugin's own subtree, so a relative path cannot cross a
  plugin boundary. `sync-agent-skills.mjs` generates the Codex copy from
  `plugins/workflow/skills/shared`, and `parity-lint` fails on any divergence. The orchestrate
  plugin reads no shared contract, so it carries none.
- Claude and Codex can also install the shared `plugins/wwbd` advisory plugin.
- Reviewer identities are bounded prompt roles, never globally installed permanent agents.
- Mechanically portable skills and shared contracts are generated from the Claude source tree.
- Shared destructive and protected-file guards are authored once and vendored to the agent plugin.
- Both plugins retain destructive-command, outbound-email, self-approval, managed-clone,
  Snowflake-connector, and protected-file safety checks.
- `bootstrap-workflow-agents` declares exactly one hook event, `PreToolUse`, for those safety
  checks. `check-plugin-boundaries` enforces that closed list — the `SessionStart` entry that used
  to install a worker role into the user's Codex home went with the role. `wwbd` declares
  `SessionStart` only, for its standing directive; `bootstrap-orchestrate` declares no hooks at all.
- Planning and review artifacts are workflow contracts, not filesystem safety boundaries.

## Repository structure

```text
bootstrap/
├── .agents/plugins/marketplace.json
├── .claude-plugin/marketplace.json
├── plugins/
│   ├── workflow/
│   ├── workflow-agents/
│   ├── orchestrate/
│   ├── wwbd/
│   └── concise/
├── evals/
├── scripts/
└── deprecated/
```

## Development checks

```bash
node --test scripts/retire-bootstrap-agents.test.mjs
node --test scripts/plugin-enablement.test.mjs
node --test evals/harness/*.test.mjs
node scripts/check-plugin-boundaries.mjs
node scripts/check-parity.mjs

cd plugins/workflow/hooks && bun test && bun run check
cd plugins/workflow-agents/hooks && bun test && bun run check
```

Use `node scripts/check-plugin-boundaries.mjs --strict-home` after retirement cleanup to fail on
marker-owned retired agents still active in Claude, Codex sibling-home, or OpenCode agent roots.

## Prerequisites

- Claude Code for `bootstrap-workflow` and `bootstrap-orchestrate`
- Codex with native plugin support for `bootstrap-workflow-agents` and `bootstrap-orchestrate`
- Bun for TypeScript hooks

## License

MIT
