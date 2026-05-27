# Agent eval harness

A reusable harness for evaluating **agent behavior** — does an agent, given a skill/
prompt + a faithful environment, produce the expected behavior and output quality? It
runs the same suite across multiple runtimes (Codex, OpenCode, Claude) and tabulates
**parity**, but it is not parity-specific: any single target can be evaluated on its own,
A/B'd against another, or regression-tracked over time.

- **DESIGN.md** — architecture, the normalized-transcript contract, scoring model, and the
  open design decisions.
- **harness/README.md** — operational usage (how to run, adapter contract, per-runtime
  headless quirks, warm-template requirement).
- **This file** — the canonical **metric and verdict definitions** that suite rubrics
  (`suites/<suite>/rubric.md`) inherit. A rubric overrides thresholds; it does not redefine
  what a metric *means*.

## Run

```bash
node harness/run.mjs --suite <suite> [--case <case>] (--target <t> | --compare a,b,c) \
     [--tier smoke|done|release] [--trials N] [--out <dir>]
node harness/lint.mjs <suite>           # Gate-1 static lint (suite anchors.json)
node harness/parity-lint.mjs --all      # structural parity-lint (workflow-agents vs Claude)
node --test                             # unit tests for the pure scoring/normalize logic
```

The skill-under-test is declared by the suite (`anchors.json` `skill`) and provisioned
from the **working tree** into each run's fixture, so every runtime evaluates the current
branch's content through one mechanism. Baseline (claude) draws the original `workflow/`
skill; ports (codex/opencode) draw the augmented `workflow-agents/` skill.

## Two gates (ordered)

Scoring is gate-ordered — a later gate runs only if the earlier one passed.

1. **Gate 1 — deterministic hard gates** (`score.mjs`, from the normalized transcript).
   Process facts a regex/structured check can decide: was a tool called, were ≥N subagents
   spawned in parallel, does the output match a required format. Infra outcomes (timeout,
   non-zero exit) resolve to `TIMEOUT`/`ENV_ERROR`, never a behavioral `FAIL`.
2. **Gate 2 — LLM judge** (`judge.mjs`), only when Gate 1 passed and the rubric defines
   `judge`. Scores semantic quality a regex can't: did it catch the real issue, is a
   finding a genuine bug. The judge sees only the ground truth + the agent's final report
   (never the live run) and must cite evidence.

## Verdict taxonomy

| Verdict | Meaning |
|---------|---------|
| `PASS` | Hard gates passed AND (if a judge ran) semantic thresholds met. |
| `FAIL` | A behavioral gate failed — the agent ran but did the wrong thing. |
| `ENV_ERROR` | The declared environment couldn't be provisioned (missing auth/MCP/skill). Not a behavioral signal — fix the env and re-run. |
| `TIMEOUT` | The run exceeded the tier timeout or exited non-zero for infra reasons. |

Per-tier aggregate: hard gates must pass **every** trial; if a judge ran, the semantic
pass-**rate** across trials must clear the tier's `semanticMin`.

## Tiers (stochasticity)

| Tier | Trials | Hard gates | Semantic min | Timeout |
|------|--------|-----------|--------------|---------|
| `smoke` | 3 | every trial | — | 240s |
| `done` | 5 | every trial | 0.8 | 600s |
| `release` | 10 | every trial | 0.8 | 600s |

`--trials N` overrides the trial count for a quick single-shot during development.

## Code-review metrics (Gate 2)

These are the metric definitions a code-review suite's `rubric.md` inherits. Thresholds are
rubric-overridable; the definitions are fixed.

- **recall (must-catch)** = `must_catch_caught / must_catch_total`. A must-catch truth
  finding is "caught" only if the report identifies the *same underlying issue* (semantic
  match, not keyword). Default threshold `minRecall` = 0.8; code-review suites typically
  raise it to 1.0 for security/data findings.

- **secDataMissed** = count of `security`/`data-correctness` must-catch findings **missed
  _or_ downgraded to `[SUGGESTION]`**. A **hard gate**: any value > 0 fails the fixture
  regardless of other metrics. Security/data severity is authoritative — those issues are
  unambiguously must-fix, so reporting one at SUGGESTION is as dangerous as missing it (it
  may ship). This is why "catching everything important, at the right severity" cannot be
  averaged away by other strong numbers.

- **false-BUG rate** = `false_bugs / reported_bug_count`. **A reported `[BUG]` is "false"
  ONLY if** (a) it flags a declared `false_positive_trap` (a known non-issue), or (b) it is
  affirmatively incorrect — the described defect doesn't exist, or it is vague/duplicative
  padding. **A true, distinct, code-grounded finding that simply isn't enumerated in the
  truth set is NOT a false bug** — the truth set lists must-catch issues + traps, not every
  valid observation, and thoroughness is not imprecision. This is the precision metric's
  load-bearing distinction: it penalizes crying wolf on non-issues and hallucination, not
  surfacing additional real issues. Default `maxFalseBugRate` = 0.2.

- **severity accuracy** = `severity_correct / severity_judged` over matched must-catch
  findings — **ADVISORY (reported, not gated).** Severity splits on finding KIND: for
  **security/data-correctness** it is authoritative and is enforced by the `secDataMissed`
  hard gate above (a downgrade there is an effective miss). For **performance / style /
  maintainability**, BUG-vs-SUGGESTION is a genuinely debatable judgment call — competent
  reviewers and the truth author can disagree (e.g. is an N+1 query a `[BUG]` or a
  `[SUGGESTION]`?) — so it is not a pass/fail gate; it is surfaced for human read. This is
  deliberate: gating on a debatable performance-severity label would fail a review that
  caught every bug with zero false positives, which is the eval being wrong, not the agent.

- **process behavior** — from the transcript via hard gates (e.g. `subagents_spawned`),
  not the judge. E.g. a review swarm must dispatch ≥2 reviewers in parallel; a solo pass
  fails the process gate even with a perfect report.

> **Anti-gaming.** "Don't reward verbosity" is enforced by criterion (b), not by counting
> every unlisted finding against precision: padding with vague/duplicative/incorrect BUGs
> *is* false (b), so a report listing 20 findings to "cover" 3 real ones still fails
> precision — because the 17 fillers are incorrect or duplicative, not merely unlisted.

## Adding a suite

A suite is `suites/<name>/` with one or more `case-*/` dirs. Each case has `input.md` (the
task; `{{FIXTURE_DIR}}` is substituted) and `truth.json` (`setup.files`, expected findings
with `must_catch`/`severity`/`kind`, `false_positive_traps`, and a `rubric` with `tier`,
`hardGates`, and optional `judge` thresholds). An optional `anchors.json` names the
skill-under-test (provisioned into the fixture) and Gate-1 static-lint substrings; an
optional `rubric.md` documents overrides and judge guidance.
