# Agent Skills Development Guide

A source-grounded guide for building Agent Skills that are portable across Claude Code, Codex, and other tools adopting the Agent Skills format.

**Last Updated:** 2026-02-13  
**Audience:** Skill authors, tool builders, and engineering teams maintaining reusable skills libraries.

---

## Reliability legend

- **Confirmed (primary)**: Verified from official spec repos or official product docs.
- **Platform-specific**: Verified in one product's docs, not part of the core standard.
- **Anthropic deck guidance (date-scoped)**: From Anthropic's official deck, useful for practical implementation in Claude surfaces, but not automatically open-standard behavior.
- **Community pattern**: Common and useful, but not normative.

Use this guide to avoid mixing these categories.

---

## 1. What is canonical today

### 1.1 Core standard (Confirmed)

The Agent Skills standard is maintained at `agentskills.io` and in `agentskills/agentskills`.

At minimum, a skill is:

```text
skill-name/
└── SKILL.md
```

`SKILL.md` must contain:

1. YAML frontmatter
2. Markdown body

Minimal frontmatter:

```yaml
---
name: skill-name
description: What this skill does and when to use it.
---
```

### 1.2 Frontmatter fields (Confirmed)

From the current spec and `skills-ref` validator:

- Required:
  - `name`
  - `description`
- Optional:
  - `license`
  - `compatibility`
  - `metadata`
  - `allowed-tools` (experimental)

`name` constraints:

- 1-64 chars
- lowercase letters/numbers/hyphens
- no leading/trailing hyphen
- no consecutive hyphens
- must match folder name

`description` constraints:

- 1-1024 chars
- should explain both capability and trigger conditions

`compatibility` max length: 500.

### 1.3 Optional folders (Confirmed)

Standard optional folders:

- `scripts/` for executable helpers
- `references/` for on-demand docs
- `assets/` for templates/resources

### 1.4 Progressive disclosure (Confirmed)

Recommended loading model:

1. Metadata (`name`, `description`) at startup
2. Full `SKILL.md` when selected
3. Referenced resources on demand

Guidance from spec:

- keep `SKILL.md` focused
- keep deep detail in `references/`
- keep references one level from `SKILL.md`
- keep `SKILL.md` under ~500 lines (recommendation)

**Why 500 lines?** The SKILL.md body loads in full on skill invocation — the platform budget for this is ~5,000 tokens. At typical prose density (~10 tokens/line), 500 lines ≈ 5,000 tokens. Both the [Anthropic platform docs checklist](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#token-budgets) and this spec use 500 lines as the practical proxy. Lines and tokens are not the same unit — a file of 490 dense prose lines may exceed the budget while a file of 510 short checklist lines may not — but 500 lines is the official checkable rule. Move detailed content to `references/` to stay under it.

### 1.5 Reference validator (Confirmed)

Use `skills-ref`:

```bash
skills-ref validate ./my-skill
skills-ref to-prompt ./my-skill
```

---

## 2. Standard vs platform behavior

A large source of confusion is treating one platform's behavior as the standard.

### 2.1 Claude Code (Platform-specific)

Confirmed in Claude docs/repo:

- Skills stored in project/user scopes under `.claude/skills` and `~/.claude/skills`
- Custom slash commands are folded into the skills system
- Claude can infer missing frontmatter in some flows (docs note fields can be optional)

Portable authoring rule:

- Still include explicit `name` and `description` to remain standard-compliant across tools.

### 2.2 Codex / OpenAI (Platform-specific)

Confirmed in Codex docs and `openai/skills`:

- Codex docs describe discovery under `.agents/skills` (repo/user/admin/system scopes)
- Codex expects `SKILL.md` with `name` and `description`
- Optional `agents/openai.yaml` adds UI and invocation/dependency metadata

Important nuance:

- In some Codex environments, bundled/user skills may also appear under `$CODEX_HOME/skills` / `~/.codex/skills`
- Treat `.agents/skills` as the documented contract for repository/user scoping in current public docs

### 2.3 GitHub Copilot (Platform-specific)

Confirmed in GitHub docs:

- Skills can be placed in `.github/skills`
- Support is currently model/mode constrained (agent-mode oriented)
- Copilot also supports subagents, which are distinct from skills

### 2.4 Cursor (Platform-specific)

Confirmed in Cursor changelog:

- Cursor supports Agent Skills in editor and CLI
- Cursor explicitly positions skills as dynamic/procedural context and rules as always-on constraints

### 2.5 Gemini CLI (Platform-specific)

Confirmed in Gemini CLI docs:

- Uses skills directories under `.gemini/skills` and global user scope
- Uses `SKILL.md`-based structure with hierarchical loading

### 2.6 Anthropic deck overlay (Platform-specific, date-scoped)

Anthropic's official deck (`The-Complete-Guide-to-Building-Skill-for-Claude.pdf`, created January 26, 2026) adds high-value practical guidance that is not fully captured in the core spec docs:

- Strong framing for **Skills + MCP** (MCP provides connectivity, skills provide workflow knowledge)
- Three practical use-case categories (Document/Asset Creation, Workflow Automation, MCP Enhancement)
- Concrete trigger/functional/performance testing rubric
- Troubleshooting playbooks for undertriggering, overtriggering, MCP failure, and instruction-quality issues

Use this guidance as implementation best practices for Claude, while keeping open-standard claims anchored to `agentskills.io`.

### 2.7 Cross-source reconciliation policy

When sources disagree:

1. Treat `agentskills.io` as canonical for open standard behavior.
2. Treat Anthropic deck/documentation as Claude-specific guidance.
3. Date-scope operational claims that may change quickly (API beta requirements, distribution mechanics, admin rollout timelines).

---

## 3. Skills vs rules vs commands vs subagents

Use this decision model to avoid overloading skills.

| Mechanism | Trigger | Best for | Avoid when |
|---|---|---|---|
| Rules | Always on | Global invariants/safety/style constraints | Task-specific procedures |
| Skills | Agent or explicit invocation | Reusable domain workflows and conditional expertise | Universal constraints |
| Commands | Explicit user intent | User-controlled operations and shortcuts | Passive background guidance |
| Subagents | Agent delegation | Isolation, parallelism, separate context/tool policy | Lightweight knowledge injection |

### Practical split

- Put **must-never-miss constraints** in rules.
- Put **task-class procedures** in skills.
- Put **explicit "do action now" operations** in commands.
- Use **subagents** when you need separate execution context, permissions, or parallel exploration.

### Problem-first vs tool-first skill framing (Anthropic deck)

Use this framing before writing instructions:

- **Problem-first**: User states an outcome ("set up customer onboarding"). The skill orchestrates the needed tools and order.
- **Tool-first**: User already has tool access ("I have Notion MCP connected"). The skill teaches best-practice workflows on top of that tool.

Most production skills lean one way. Being explicit about direction improves trigger precision and instruction quality.

### Anthropic deck skill categories (for planning)

Use these as planning templates:

1. **Document & Asset Creation**: Branded artifacts, docs, presentations, UI artifacts, code output with quality constraints.
2. **Workflow Automation**: Repeatable multi-step operations with validation gates and consistent sequencing.
3. **MCP Enhancement**: Guidance layer that turns raw MCP tool access into reliable, domain-aware workflow execution.

---

## 4. Activation and routing reality

### 4.1 What is true across implementations

- Metadata drives discovery.
- Description quality materially affects activation.
- Full body loads only after a skill is chosen.

### 4.2 What is not universally true

Do not hardcode claims like:

- "routing is pure LLM reasoning in every tool"
- "no deterministic matching is used anywhere"

Reason: implementations differ and may add deterministic layers, UI hints, policy hooks, or tool-level routing logic.

Portable guidance:

- Write descriptions for semantic matching.
- Assume implementation details vary by tool.

---

## 5. Description-writing standard (highest leverage)

A strong description should include:

1. Capability statement
2. Trigger conditions
3. Clear boundaries (when **not** to use)

Template:

```yaml
description: >
  [What it does].
  Use when [task conditions / files / user intents].
  Do not use for [adjacent but out-of-scope tasks].
```

Good characteristics:

- specific nouns/verbs users actually say
- concrete file types/domains
- no marketing phrasing
- under 1024 chars

---

## 6. Folder structure patterns that scale

### 6.1 Minimal

```text
my-skill/
└── SKILL.md
```

Use when instructions are short and stable.

### 6.2 Standard

```text
my-skill/
├── SKILL.md
└── references/
    ├── examples.md
    └── edge-cases.md
```

Use when the core flow is stable but details are extensive.

### 6.3 Execution-heavy

```text
my-skill/
├── SKILL.md
├── scripts/
│   ├── run.sh
│   └── validate.py
├── references/
│   └── troubleshooting.md
└── assets/
    └── template.md
```

Use when deterministic execution matters.

### 6.4 Authoring rules

- `SKILL.md` is the routing and workflow spine.
- Keep variant-heavy details in references.
- Prefer one default execution path; keep alternatives as escape hatches.
- Avoid deep reference chains (`SKILL.md -> file A -> file B -> ...`).
- Keep human-facing repository docs at repo root; avoid extra `README.md` files inside skill folders unless a platform-specific workflow explicitly requires it.

---

## 7. Best practices for future skill authoring

### 7.1 Context discipline

- Treat context as a scarce resource.
- Only include instructions that change behavior.
- Move dense tables/schemas/examples out of `SKILL.md`.

### 7.2 Degree of freedom design

- High freedom: advisory heuristics
- Medium freedom: templates/pseudocode
- Low freedom: exact commands/scripts for fragile tasks

### 7.3 Verification-first workflows

For nontrivial tasks:

1. Plan
2. Validate plan (script/checklist)
3. Execute
4. Verify outputs

### 7.4 Failure and recovery design

Every serious skill should define:

- preconditions
- verification checks
- stop conditions (when to ask user)
- retry/recovery path

### 7.5 Tooling hygiene

- Prefer script execution over re-deriving long logic in-context.
- Make scripts explicit and self-validating.
- Surface actionable errors.

---

## 8. Testing and validation workflow

### 8.1 Baseline + eval loop

1. Run representative tasks without the skill.
2. Capture failure patterns.
3. Implement minimal skill content addressing those failures.
4. Re-run tasks and compare.
5. Refine triggers and instructions.

### 8.2 Required checks

- Trigger correctness (fires when it should)
- Non-trigger correctness (doesn't fire when irrelevant)
- Explicit invocation behavior
- Reference loading behavior
- Cross-model robustness if your team uses multiple models

### 8.3 Tooling

- `skills-ref validate`
- project-specific eval scripts for critical skills

### 8.4 Testing levels (Anthropic deck)

Choose rigor based on impact and blast radius:

1. **Manual testing (Claude.ai / Claude Code)**: fastest iteration loop.
2. **Scripted testing (Claude Code)**: repeatable smoke tests across revisions.
3. **Programmatic testing (API-based)**: systematic suites for higher-volume or production use.

### 8.5 Trigger test harness

Every skill should define:

- **Should trigger** examples (obvious phrasing + paraphrases).
- **Should NOT trigger** examples (adjacent topics and irrelevant prompts).

Use 10-20 sample prompts for trigger evaluation before publishing.

### 8.6 Functional test harness

Define at least one end-to-end scenario per major workflow:

- given input payload
- expected MCP/tool sequence (if relevant)
- expected artifacts/output schema
- expected error handling behavior for a known failure mode

### 8.7 Performance/baseline comparison (aspirational)

Deck-style operational metrics you can track:

- trigger hit rate on relevant prompts
- tool/API failure rate
- workflow completion with minimal user correction
- token/tool-call efficiency versus no-skill baseline

These are guidance metrics, not universal pass/fail thresholds.

### 8.8 Iteration diagnostics

Undertriggering signals:

- skill not loaded for expected prompts
- users repeatedly invoke skill manually

Overtriggering signals:

- skill loads on unrelated tasks
- users disable or avoid the skill

Fix pattern:

- tighten description scope
- add explicit out-of-scope boundaries
- retest with the same trigger/non-trigger prompt suite

---

## 9. Distribution and sharing (Anthropic deck overlay)

### 9.1 Practical distribution model (date-scoped)

From Anthropic's official deck (January 2026), practical distribution flow for Claude users:

1. Package skill folder.
2. Upload in Claude settings or install in Claude Code skill paths.
3. For shared/team scenarios, use organization-level skill deployment features where available.

Deck-specific timeline note:

- Anthropic deck states workspace-wide/admin deployment shipped on December 18, 2025. Treat this as a point-in-time product note and verify current behavior in live docs.

Treat this as operational guidance, not open-standard behavior.

### 9.2 Skills + MCP positioning

For connector maintainers and integration teams:

- MCP gives Claude access to real tools/data.
- Skills encode reliable workflow usage patterns for those tools.

Position skills in docs around **outcomes** ("onboard a customer in one workflow"), not implementation details ("contains YAML + markdown").

### 9.3 API guidance (time-sensitive)

Anthropic deck notes that API skill usage requires a code execution capability in beta (as of January 2026).  
Always verify current state in live API docs/release notes before publishing hard requirements.

---

## 10. Pattern library (Anthropic deck)

These patterns are pragmatic templates for real workflow design.

### 10.1 Sequential workflow orchestration

Use when steps must execute in strict order with dependency handoff between steps.

Key controls:

- explicit step ordering
- dependency outputs passed forward
- validation gate between steps
- rollback/error branch

### 10.2 Multi-MCP coordination

Use when workflow spans multiple services (design -> storage -> planning -> comms).

Key controls:

- phase boundaries
- cross-system identifier passing
- per-phase validation
- centralized failure handling

### 10.3 Iterative refinement loop

Use when quality improves with validate/fix cycles.

Loop:

1. Generate draft
2. Run validation script/check
3. Resolve issues
4. Repeat until threshold

### 10.4 Context-aware tool selection

Use when same user outcome maps to different tools by context (file size/type/collaboration mode).

Key controls:

- decision criteria table
- fallback path
- explain selected path to user

### 10.5 Domain-specific intelligence

Use when domain rules should execute before tool action (compliance, policy, governance).

Key controls:

- pre-action domain checks
- explicit go/no-go branch
- audit trail logging/reporting

---

## 11. Troubleshooting playbook (Anthropic deck)

### 11.1 Skill not loading

Checklist:

- description too vague
- missing trigger phrases users actually say
- scope too broad/too narrow

Fix:

- add concrete triggers
- add explicit out-of-scope statement
- rerun trigger/non-trigger suite

### 11.2 Skill loads too often

Symptoms:

- unrelated auto-activation
- user confusion/disabling behavior

Fix:

- tighten domain/file/task boundaries in description
- add explicit "do not use for ..." boundaries

### 11.3 Instructions ignored

Common causes:

- verbose or buried critical instructions
- ambiguous language
- non-deterministic validation steps

Fix:

- move critical constraints to top
- use concrete checklists
- prefer deterministic validation scripts for critical checks

### 11.4 MCP/tool execution failures

Checklist:

- tool/server connectivity
- authentication/permissions
- tool name correctness/case
- independent direct tool test without skill

### 11.5 Large-context degradation

Symptoms:

- slower responses
- degraded instruction-following quality

Fix:

- shrink `SKILL.md` and move detail to `references/`
- reduce simultaneously enabled overlapping skills (deck heuristic: review when you have roughly 20-50 enabled skills)
- enforce progressive disclosure structure

---

## 12. Security model for skills

Skills are text + scripts, so security risk is largely execution risk.

### 12.1 Main risks

- prompt injection in instructions/references
- malicious or unsafe scripts
- data exfiltration via tool/network actions
- supply-chain risk from third-party skill repos

### 12.2 Controls

- review skill sources before install
- pin versions/commits for shared skills
- sandbox and permission constraints
- explicit allowlists for dangerous operations
- periodic audit of installed skills

---

## 13. Popular reference skills and what to copy

Use these as pattern references, not as blind templates.

### 13.1 Anthropic skills repo (broad adoption)

- Repository: `anthropics/skills`
- Signal: `69k+` GitHub stars (snapshot: 2026-02-13), active usage in Claude ecosystem
- Strong patterns:
  - `skill-creator`: concise architecture + progressive disclosure discipline
  - `pdf`: capability bundling with scripts/references
  - `webapp-testing`: operational decision trees + helper scripts

### 13.2 OpenAI skills repo (Codex-oriented)

- Repository: `openai/skills`
- Signal: `8k+` GitHub stars (snapshot: 2026-02-13), curated/system/experimental tiers, Codex integration
- Strong patterns:
  - `gh-address-comments`: bounded task workflow
  - `playwright`: concrete CLI-first execution loop
  - `security-best-practices`: reference-driven review workflow

### 13.3 Community catalog

- Repository: `VoltAgent/awesome-agent-skills`
- Signal: `6k+` GitHub stars (snapshot: 2026-02-13), broad cross-tool discovery index
- Use: discovery, not authority
- Copy pattern ideas, then re-validate against primary docs before standardizing

---

## 14. Common misconceptions (fact-check)

1. **"Only `name`/`description` exist in frontmatter."**  
Partially true. They are required; optional fields also exist in the current spec (`license`, `compatibility`, `metadata`, `allowed-tools` experimental).

2. **"`name` can be anything if description is good."**  
False. Name constraints are validated (length, charset, hyphen rules, directory match).

3. **"All tools use the same skills path."**  
False. Paths differ by implementation (`.claude/skills`, `.agents/skills`, `.github/skills`, `.gemini/skills`, etc.).

4. **"Claude frontmatter behavior is the universal standard."**  
False. Claude-specific conveniences do not redefine the cross-tool spec.

5. **"Skills are commands."**  
False. Commands are explicit user actions; skills are reusable conditional expertise.

6. **"Subagents replace skills."**  
False. Skills shape behavior/knowledge; subagents isolate execution/context.

7. **"Reserved name words like 'anthropic'/'claude' are standard restrictions."**  
Not in the current public open-standard validator. Treat as tool-specific guidance when documented by a platform.

8. **"Every routing pipeline is pure semantic matching only."**  
Not universally guaranteed across implementations.

---

## 15. Defacto skill authoring standard for this repo

Use this checklist for every new skill.

### 15.1 Before development

- [ ] identify 2-3 concrete use cases
- [ ] choose problem-first or tool-first framing
- [ ] select skill category (document/asset, workflow automation, MCP enhancement)
- [ ] define success criteria and baseline comparison strategy

### 15.2 Required

- [ ] `SKILL.md` exists
- [ ] frontmatter includes explicit `name` and `description`
- [ ] `name` matches directory and validator constraints
- [ ] description includes what/when/not-when

### 15.3 During development

- [ ] keep `SKILL.md` focused, move details to `references/`
- [ ] include deterministic scripts for fragile workflows
- [ ] include verification and recovery steps
- [ ] keep references one level deep
- [ ] include concrete examples and common failure handling

### 15.4 Before upload/release

- [ ] run trigger and non-trigger prompt suite
- [ ] run at least one end-to-end functional test per major workflow
- [ ] verify tool integration independently from skill orchestration
- [ ] run `skills-ref validate` (when using spec tooling)
- [ ] verify no time-sensitive claims without explicit dates/scope

### 15.5 After release

- [ ] monitor undertrigger/overtrigger behavior
- [ ] collect user feedback from real task runs
- [ ] iterate on description and instruction clarity
- [ ] update metadata/versioning when behavior changes

### 15.6 Portability guardrails

- [ ] no reliance on one platform's undocumented fields
- [ ] clearly label platform-specific features
- [ ] keep core workflow readable without proprietary tooling
- [ ] date-scope vendor operational guidance that can change

### 15.7 Anthropic-specific constraints note

Anthropic deck guidance includes stricter operational advice such as:

- exact `SKILL.md` naming convention
- avoiding XML angle brackets in frontmatter/skill content
- reserved naming guidance around certain prefixes

Keep these as **Anthropic-specific hardening advice** unless independently confirmed by open-standard specs.

---

## 16. Source index (primary first)

### Primary sources

- Agent Skills spec repo: https://github.com/agentskills/agentskills
- Agent Skills spec page: https://agentskills.io/specification
- Agent Skills integration guide: https://agentskills.io/integrate-skills
- Agent Skills reference library: https://github.com/agentskills/agentskills/tree/main/skills-ref
- Anthropic skills repo: https://github.com/anthropics/skills
- Claude Code skills docs: https://docs.claude.com/en/docs/claude-code/skills
- Anthropic API skills quickstart: https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills/quickstart
- Anthropic code execution tool docs: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/code-execution-tool
- Codex skills docs: https://developers.openai.com/codex/skills
- Codex config docs (skills paths): https://developers.openai.com/codex/config#skills
- OpenAI skills repo: https://github.com/openai/skills
- GitHub Copilot custom instructions/skills docs: https://docs.github.com/en/copilot/how-tos/context/configure-custom-instructions/add-repository-instructions
- Cursor changelog (skills support): https://cursor.com/changelog
- Cursor skills docs: https://cursor.com/docs/context/skills
- Gemini CLI skills docs: https://google-gemini.github.io/gemini-cli/docs/tools/skills/
- Anthropic official deck (local file): `/Users/davidkim/projects/claude-code-template/claude-eng-team/The-Complete-Guide-to-Building-Skill-for-Claude.pdf`

### Secondary/community references (non-normative)

- Awesome Agent Skills catalog: https://github.com/VoltAgent/awesome-agent-skills
- Builder article on rules/commands/skills framing: https://www.builder.io/blog/agent-skills-rules-commands

---

## 17. Notes on this revision

This revision intentionally:

- integrates Anthropic's official January 2026 deck as a platform-specific implementation playbook,
- keeps open-standard claims anchored to `agentskills.io`,
- date-scopes potentially unstable operational claims (beta requirements, distribution mechanics),
- expands practical guidance with pattern templates, troubleshooting, and release checklists.

This document is optimized to be both portable and operational for day-to-day skill engineering.
