# Agent Eval Harness — Design

A reusable harness for evaluating **agent behavior** — not just workflow-skill parity.
"Does Codex match Claude on review-swarm" is one expressible eval; so is "did my prompt
edit regress tool use", "does this skill catch the planted bug", "is the agent avoiding a
known failure mode", and "has capability X drifted since last week".

The design goal: a future agentic use case is **drop in a suite + (optionally) a target**,
not "write a new eval script".

## Why this exists / what bit us

A behavioral eval is only as honest as the environment it runs in. Our first attempt ran an
agent headless with auth + skill but **no MCP research tools**, so a skill that mandates a
research protocol stalled for 20 minutes and produced nothing. Two invariants fall out of
that single failure: **the environment is declared and provisioned** (not assumed), and a
**capability preflight** must prove the agent actually sees that environment before the task
runs — otherwise an env gap gets misattributed to model quality.

## Scope boundary (read first)

This harness evaluates **single-turn, black-box task evals**: one task input (optionally a
seed list of messages), a file/repo fixture, run to completion, score the transcript +
output. That covers a large class of agentic work (skill invocation, review/QA, tool use,
single-shot generation).

**Explicitly OUT of scope for v1** — these need *engine* changes, not just a new suite, so
don't assume the abstraction covers them:
- Multi-turn conversations with scripted follow-ups / dynamic user responses
- Human-approval checkpoints and policy gates mid-run
- Injected tool failures / adversarial fault injection
- Mutable external-API state or stateful task-board workflows

When one of these is needed, it is a deliberate engine extension (a richer `Case` with a
turn script + event-injection hooks), tracked as such — not a surprise discovered by
breaking the runner.

## Core abstraction

An eval is `(target, case) → verdict`. Four nouns:

### Target — *how* to run the agent (a fully-specified agent configuration)
```jsonc
{
  "id": "opencode-kimi",
  "adapter": "opencode",            // opencode | codex | claude | ...
  "model": "opencode-go/kimi-k2.6",
  "env": {                          // the FULL capability surface — all provisioned, none assumed
    "auth": "~/.local/share/opencode-illysium-opencode/auth.json",
    "mcp": ["exa", "context7", "deepwiki"],
    "skills": ["review-swarm"],     // skill files materialized into the runtime's skill path
    "subagents": ["security-reviewer", "..."],  // agent defs materialized into the agent path
    "systemPromptAppend": null,
    "repo": null                    // optional working-tree fixture
  }
}
```
A target captures runtime + model + tools + skills + subagents + prompt. Swapping any field
is a new target — that's what makes A/B and parity fall out for free. **Every `env` field is
provisioned by the adapter and verified by the preflight (below); MCP alone is not enough.**

### Case — *what* to test
```jsonc
{
  "id": "01-ts-api",
  "input": "…task / user message (or a path to input.md)…",
  "setup": { "files": [/* fixture files to materialize in the repo */] },
  "expect": { /* truth.json — structured ground truth */ },
  "rubric": {
    "hardGates": [/* absolute, per-case: required findings + required transcript behaviors */],
    "assertions": [/* deterministic transcript checks (dispatch count, tools called, format) */],
    "judge": { /* LLM-judge instructions + semantic thresholds */ },
    "tier": "done"                  // smoke | done | release → trial count + pass-rate (below)
  }
}
```

### Run — `adapter.run(target, case) → transcript`

Two phases, both mandatory:

**(a) Capability preflight.** Before the task, the adapter proves the agent's *model-visible*
surface matches `target.env`: the declared MCP tools, skills, and subagents are actually
reachable from inside the running agent (probe / enumerate). On mismatch → verdict
`ENV_ERROR`, abort the run. This is the guard against the 20-min-stall failure: an env gap
becomes a loud, attributable error, never a silent "the model did poorly."

**(b) Task run**, headless + streaming (kill-safe, no TTY, no Slack):
- opencode → `opencode run --format json` + `OPENCODE_CONFIG_CONTENT` (reuse nanoclaw's
  `mcpServersToOpenCodeConfig` to materialize the `mcp` block) + skill/agent dirs in XDG
- codex → `codex exec --json` with its MCP config + skill/agent provisioning
- claude → Agent SDK / `-p --output-format stream-json`

### Normalized transcript — the contract that makes cross-runtime scoring possible

**This is the hardest piece and the highest implementation risk.** The three runtimes emit
the same behavior in incompatible shapes (OpenCode nested agent event; Claude `Task` tool
call; Codex tool invocation, different naming). Scoring CANNOT read raw adapter output.

Each adapter must emit a **normalized transcript** conforming to one schema:
```jsonc
{
  "finalOutput": "…",
  "events":        [{ "t": 0, "type": "...", "raw": {...} }],
  "toolCalls":     [{ "name": "exa.search", "args": {...}, "result": {...}, "ok": true }],
  "subagentSpawns":[{ "role": "security-reviewer", "parentId": "...", "parallel": true }],
  "researchCalls": [{ "tool": "context7|deepwiki|exa", "ok": true }],
  "durationMs": 0, "exitOk": true, "timedOut": false
}
```
Rules: stable tool-name aliasing across runtimes (`task`/`Task`/native-delegation →
`subagentSpawn`), parent-child IDs for parallelism detection, tool→result mapping. Every
adapter ships a **transcript conformance test** (raw fixture → normalized shape) that runs
before any eval; a non-conforming adapter is a hard build failure, not a silent bad verdict.

### Score — `score(case, transcript) → verdict` (hybrid, gate-ordered)

Gates apply **in order**; a later gate can never rescue an earlier failure:

1. **Absolute hard gates (primary).** Per-case requirements from `expect` + deterministic
   transcript assertions: required findings caught (e.g. security/data-correctness recall =
   1.00), required behaviors present (dispatched ≥N reviewers in parallel, called the
   mandated research tools, output-format compliant). **Must pass every trial.** These are
   cheap, exact, model-free, and ungameable.
2. **Semantic judge (secondary).** LLM judge (strong model, isolated from the answers) scores
   recall/precision/severity against `expect`, **and must cite transcript evidence** — it
   FAILs a finding when the required tool/reviewer evidence is absent, so fluent-but-unsupported
   output cannot pass.
3. **Baseline-relative parity gate (tertiary, regression catch only).** Only evaluated after
   (1) and (2) pass. "No metric > 1 tier below the pinned Claude baseline." This catches
   *quality* regressions; it is NEVER a substitute for the absolute gates (an agent that skips
   required behavior fails at gate 1, regardless of how close to baseline its prose reads).

Verdict taxonomy: `PASS | FAIL | ENV_ERROR | TIMEOUT`. `ENV_ERROR`/`TIMEOUT` are infra
outcomes, reported separately from behavioral `FAIL` — never counted as model quality.

## Stochasticity — tiered trials + provenance

Agents are stochastic; one green run is not validation. **Tiered policy:**

| Tier | Trials | Pass bar | Use |
|------|--------|----------|-----|
| smoke | 3 | hard gates 3/3 | per-PR, changed suites only, frozen env |
| done | 5 | hard gates 5/5, semantic ≥4/5 | declaring a skill done |
| release/parity | 10 | hard gates 10/10, semantic ≥8/10 | cross-runtime parity sign-off |

Hard gates must pass **every** trial at every tier (they encode "never silently miss an
injection bug"). Every result is stamped with **provenance** — adapter, model id, prompt +
skill version hash, fixture version, MCP set, timestamp — so a red run is unambiguously a
skill regression vs. fixture drift vs. baseline/model drift.

## Determinism of external tools — live vs frozen

context7/deepwiki/Exa are live and drift. Two run modes:
- **frozen** (default for CI/smoke/nightly): recorded MCP responses replayed, so a red run is
  attributable to the agent, not the internet.
- **live** (periodic, release): real MCP calls, to catch real-world breakage. Re-records the
  frozen cassettes.

## Composition modes (not core — just how you wire targets × cases)
- **Quality gate**: 1 target × suite → absolute gates + thresholds. ("Does this skill work?")
- **Parity**: N targets × same suite → absolute gates each, THEN baseline-relative comparison
  vs the pinned Claude baseline. (Today's workflow-skill need.)
- **A/B**: 2 targets differing by one `env` field (e.g. `systemPromptAppend`) → delta.
- **Regression**: 1 target × suite over time → diff vs stored baseline (with provenance, so
  baseline drift is detectable when Claude's own absolute metrics move).

## Baseline policy (parity)

The Claude baseline is **stored with full provenance and pinned**. Parity is measured against
the pinned baseline, not a live Claude run. When Claude's model/version changes, re-baseline
deliberately (a baseline refresh is a reviewed event); a parity regression and a baseline
drift are then distinguishable.

## Layout
```
evals/
  DESIGN.md
  harness/
    run.mjs            # CLI: run.mjs --suite <s> --target <t> [--tier <t>] [--compare a,b] [--mode live|frozen]
    preflight.mjs      # capability preflight: assert model-visible env matches target.env
    transcript.mjs     # normalized transcript schema + conformance test runner
    adapters/
      opencode.mjs     # run(target, case) → normalized transcript
      codex.mjs
      claude.mjs
    judge.mjs          # LLM judge: (expect, transcript, rubric) → evidence-cited verdict
    score.mjs          # gate-ordered: hard gates → judge → parity
    report.mjs         # per-run + aggregate + comparison + provenance artifacts
    targets/           # reusable target configs (opencode-kimi.json, codex-gpt.json, claude.json)
  suites/
    review-swarm/      # first suite (fixtures + truth + rubric + anchors + lint)
      case-*/ { input.md, truth.json }
      rubric.md
      cassettes/       # frozen MCP responses
```

## Non-negotiables (design invariants)
1. **Faithful, declared env** — all of `target.env` (mcp + skills + subagents + auth + prompt)
   is provisioned, never assumed.
2. **Capability preflight** — prove the agent sees that env before the task; env gap → `ENV_ERROR`.
3. **Normalized transcript** — adapters emit one schema; conformance-tested; scoring never
   reads raw adapter output.
4. **Headless, streamed, kill-safe capture** — JSON event streams to disk; no buffering loss.
5. **Gate ordering** — absolute hard gates primary; judge secondary; parity tertiary.
6. **Stochastic-aware** — tiered trials, hard gates pass every trial, provenance on every result.
7. **Infra ≠ behavior** — `ENV_ERROR`/`TIMEOUT` never count as model quality.
8. **Suite/target/adapter separation** — new use case = new suite (+ maybe target), within the
   single-turn scope boundary.

## v1 build plan (sequenced to surface the hardest risk first)

1. **Spine first:** define the normalized transcript schema (`transcript.mjs`), verdict
   taxonomy, and capability-preflight contract (`preflight.mjs`).
2. **Prove the spine across all three adapters cheaply:** a minimal **one-tool** case (e.g.
   "use Exa to answer X, then call tool Y") run on opencode + codex + claude, asserting the
   normalizer + preflight produce comparable transcripts. This catches cross-runtime
   normalization breakage when a one-case fix is cheap — *before* 17 swarm cases are built
   against one runtime's shape.
3. **OpenCode review-swarm vertical:** faithful env (frozen cassettes), gate-ordered scoring,
   `done`-tier trials → review-swarm green on `opencode-kimi`.
4. **Extend codex + claude adapters to the swarm case** → parity comparison for review-swarm
   lights up (the immediate deliverable).
5. **Roll to the remaining skills** + tiered CI (per-PR smoke / nightly / release-parity), with
   judge cost bounded by tier.

**Cost note:** the full matrix (17 skills × 3 runtimes × release trials × judge calls) is only
ever run at the release tier. Per-PR runs are smoke-tier on changed suites with deterministic
gates + a cheap judge, so CI stays usable and "validation is the done-bar" doesn't get bypassed.
