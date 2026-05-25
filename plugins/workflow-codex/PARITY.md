# workflow-codex parity contract

`workflow-codex/` is the Codex/OpenCode port of the Claude `workflow/` plugin. The
**substance is identical**; only the orchestration primitives differ. This file is the
contract for keeping the two in parity — read it before editing any skill here, and
before adding a Claude skill that needs a port.

> OpenCode reads these same skills (the OpenCode adapter resolves `workflow-codex/skills`
> first). There is no separate `workflow-opencode/` — one port serves both runtimes via
> per-runtime sections.

## The one rule

**Augment, don't gut.** A ported skill carries the *entire* runtime-neutral substance of
its Claude original — every process step, principle, checklist, criterion, anti-pattern,
rationalization-resistance table, and output contract — **verbatim**. The ONLY things that
change are the orchestration primitives (how subagents are spawned, how they converge, how
the team is town down) and other Claude-specific touchpoints (tool names, agent-type refs,
`.claude/` paths). If you find yourself summarizing or dropping substance, stop — that is
gutting, and the parity-lint will fail it.

## How to port a skill (verbatim-baseline + translate)

1. **Verbatim baseline.** Copy the Claude original wholesale:
   `cp workflow/skills/<s>/SKILL.md workflow-codex/skills/<s>/SKILL.md` and
   `cp -r workflow/skills/<s>/references workflow-codex/skills/<s>/` (if any). This
   guarantees substance fidelity and restores the reference files.
2. **Frontmatter.** Ensure `name`, `version`, `description` are present (gutted ports lost
   `version`). Keep the same `name`; keep `description` unless it names a Claude-only tool.
3. **Translate orchestration + Claude touchpoints only.** Walk the body and translate:
   - Subagent spawning / team choreography → a `## Dispatch by Runtime` section (template
     below) + a link to `../shared/codex-workflow-primitives.md`. Move ALL per-runtime
     dispatch syntax INTO that section; the body above it stays runtime-neutral.
   - Claude tool names in prose: `Skill tool` → "your runtime's skill/command invocation";
     `the Task tool` / `Agent(...)` / `TeamCreate` / `SendMessage` → the dispatch section.
   - Agent-type references (`bootstrap-workflow:security-reviewer`) → keep the role name as
     a *prompt-defined* role label (workers are generic; identity is the prompt).
   - `.claude/` paths → `AGENTS.md`/`docs/` per the shared primitives doc.
4. **Gate.** `node ../../evals/harness/parity-lint.mjs <s>` must PASS (substance headings
   preserved ≥85%, references restored, Claude tokens confined, frontmatter intact). For
   skills with a behavioral suite, also run the eval (`evals/`).

## `## Dispatch by Runtime` template (validated against review-swarm)

Use this verbatim shape for any skill that spawns workers. Keep the runtime-neutral body
referring to "spawn the reviewers/builders/validators" abstractly; this section is where
that becomes concrete.

```
## Dispatch by Runtime

The <work> substance above is runtime-agnostic. The orchestration primitives below are the
only runtime-specific part.

> Use your runtime's native, in-session subagent delegation — workers that report back to
> the lead. Do NOT use cross-agent/cross-container dispatch (e.g. NanoClaw's `spawn_task`
> MCP): those launch separate sessions that can't converge. Stay in-session.

### Codex
Codex delegates to subagents out of the box. Run each <worker> as an independent Codex
subagent, in parallel where supported, following ../shared/codex-workflow-primitives.md
(§ Codex Subagents). Lead-mediated convergence (workers report to the lead; the lead
reconciles). Re-delegate a failed worker once; lead owns integration + the final claim.

### OpenCode
Issue parallel `task({ subagent_type: 'general', description, prompt, background: true })`
calls in ONE tool turn — one per worker. `background: true` is the parallel key. OpenCode's
worker is `general` (NOT `general-purpose`). Lead-mediated convergence, same as Codex.

### Claude (reference — for parity, not used on this runtime)
On Claude this uses `TeamCreate` + `Agent(team_name=…)`, `SendMessage` rounds for peer
convergence, and `SendMessage(shutdown_request)` + `TeamDelete`. The lead-mediated
convergence above is the near-parity equivalent (fire-and-return workers have no peer
channel).
```

## Skill classification (for the rollout)

**Worker-dispatching** (need the full Dispatch-by-Runtime section): `review-swarm` (done),
`team-qa` (parallel validators), `team-build` (parallel builders), `team-review` (3
reviewers).

**Orchestrator via sub-skills** (`team-auto`): does NOT spawn subagents — it invokes the
other workflow skills in sequence with gates. Translate skill-invocation, not dispatch.

**Single-agent** (no dispatch section; translate Claude tool/agent/path refs + add
`version` + cite shared primitives for verification/artifacts): `team-brief`, `team-design`,
`team-plan`, `team-tdd`, `team-ship`, `team-retro`, `team-debug`, `team-drift`,
`team-verification-before-completion`, `team-receiving-review-feedback`,
`best-practice-check`, `workflow-routing`.

## What "parity" is NOT

- Not a rewrite. If the codex skill reads as a fresh, shorter take on the topic, it's wrong.
- Not behavior change. Same gates, same stop-points, same anti-patterns, same thresholds.
- Not Claude-primitive leakage. `TeamCreate`/`SendMessage`/`Agent(`/`subagent_type` never
  appear in the runtime-neutral body — only inside Dispatch-by-Runtime.
