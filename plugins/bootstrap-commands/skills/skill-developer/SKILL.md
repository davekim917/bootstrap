---
name: skill-developer
description: Create and manage Claude Code skills with description-based activation. Use when creating new skills, writing skill descriptions, understanding trigger patterns, debugging skill activation, or implementing progressive disclosure. Covers skill structure, YAML frontmatter, description writing (WHAT/WHEN/NOT patterns), structural patterns (workflow, task, reference, capabilities), the 500-line rule, and cross-platform portability.
---

# Skill Developer Guide

## Purpose

Comprehensive guide for creating skills in Claude Code. Covers standard skill content quality guidance applicable across platforms.

## Core Principles

**Context window is a public good.** Every token in SKILL.md is loaded on every invocation. Write lean: only add context Claude doesn't already have, skip common knowledge, eliminate redundancy between SKILL.md and reference files.

**Description-first architecture.** The description is the *only* content read before triggering. All "when to use" logic must live in the description. SKILL.md content loads only after triggering — it is not part of activation. Treat description quality as the highest-leverage control.

---

## Skill Types

### 1. Guardrail Skills

**Purpose:** Enforce critical best practices that prevent errors

- Enforcement: block — prevents action until skill is consulted
- Session-aware (don't repeat nag in same session)
- **Use For:** Mistakes that cause runtime errors, data integrity, critical compatibility

**Examples:** `database-verification`, `schema-validation`

### 2. Domain Skills

**Purpose:** Provide comprehensive guidance for specific areas

- Enforcement: suggest — advisory, not enforced
- Topic or domain-specific; comprehensive documentation
- **Use For:** Complex systems requiring deep knowledge, best practices, architectural patterns

**Examples:** `backend-dev-guidelines`, `frontend-dev-guidelines`

### 3. Cross-Cutting Guards

**Purpose:** Guardrails that apply across multiple workflow stages, not bound to a single skill

- Subtype of guardrail, but advisory rather than blocking
- Triggered by behavioral signals (e.g., completion claims) rather than domain context
- **Use For:** Verification discipline, process compliance that spans /team-build, /team-qa, /team-ship, /team-debug, /team-tdd

**Examples:** `verification-before-completion`

---

## Standard Sections for Workflow Skills

### Hard Gate Convention

Workflow skills with approval gates use HTML comment markers as anchors:

```markdown
<!-- GATE: gate-name — condition that must be true -->
```

Gates are behavioral instructions — Claude follows them when the skill is loaded. They are greppable (`grep -r "<!-- GATE:" ~/.claude/skills/`) and consistent across all workflow skills.

**Examples:** `<!-- GATE: brief-approval — Brief must be explicitly approved before proceeding to /team-design -->`, `<!-- GATE: qa-clearance — All MUST-FIX fixed or waived before /team-ship -->`

### Rationalization Resistance

Workflow and guardrail skills should include a `## Rationalization Resistance` section with a two-column table:

```markdown
## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "[common excuse for skipping this skill's discipline]" | "[why the excuse is wrong]" |
```

Column headers: `| Excuse | Counter |` (matches existing `/team-tdd` and `/team-debug` convention). Reference `/team-tdd` as the canonical example. Include 5-8 rows per skill. Frame domain-agnostically where possible.

---

## Structural Patterns

Choose the pattern that fits the skill's purpose:

| Pattern | Use When | Shape |
|---------|----------|-------|
| **Workflow** | Multi-step procedure, ordering matters | Steps → Validation → Iterate |
| **Task** | Single action with clear inputs/outputs | Context → Procedure → Verify |
| **Reference** | Information lookup, no procedure | Organized facts → Examples |
| **Capabilities** | Background knowledge, guidelines | Principles → Patterns → Anti-patterns |

Most domain skills use **Capabilities**. Review gates use **Task**. Creation guides use **Workflow**.

---

## Skill Creation Process

### Step 0: Gather Concrete Usage Examples

**Do not skip this step.** Before writing any skill content, understand how the skill will actually be used.

Gather 3-5 concrete prompts that should trigger this skill. For each, identify:
1. What procedural knowledge would help Claude succeed?
2. What mistakes commonly occur without guidance?
3. What scripts, references, or assets would be reusable?

**Conclude this step** when you have 3+ examples and understand the reusable resources needed.

### Step 1: Initialize the Skill

```bash
python .claude/skills/skill-developer/scripts/init_skill.py my-new-skill --path .claude/skills
```

Use `--pattern` to select a structural template:

```bash
python init_skill.py my-skill --path .claude/skills --pattern capabilities  # default
python init_skill.py my-skill --path .claude/skills --pattern workflow
python init_skill.py my-skill --path .claude/skills --pattern task
python init_skill.py my-skill --path .claude/skills --pattern reference
```

This creates:
```
.claude/skills/my-new-skill/
├── SKILL.md              # Template with frontmatter (pattern-specific)
├── scripts/              # For executable code
└── references/           # For documentation loaded as needed
```

**No README.md or CHANGELOG.md** — auxiliary files add no activation value and violate the "no auxiliary files" principle.

### Step 2: Write SKILL.md Content

**Choose your structural pattern** (Workflow/Task/Reference/Capabilities — see above).

**Writing style:** Imperative/infinitive form (verb-first), not second person.

- ✅ "To verify the schema, run the validation script"
- ✅ "Extract text using pdfplumber"
- ❌ "You should verify the schema"
- ❌ "If you need to extract text..."

**Content quality rules:**

- **No auxiliary files:** SKILL.md, references/, scripts/, assets/ only. No README.md, CHANGELOG.md.
- **No duplication:** Never repeat content between SKILL.md and reference files. SKILL.md summarizes; references/ expand.
- **Test all scripts:** Every script in scripts/ must be tested by running it. No untested scripts.
- **500-line rule:** If SKILL.md exceeds 500 lines, move detailed content to references/.
- **Conciseness principle:** Only add context Claude doesn't already have. Don't explain common knowledge.

**Linking resource files (one level deep only):**

```markdown
# SKILL.md — link directly from here:
- **Detailed guide**: See [guide.md](references/guide.md)      ✅
- **Examples**: See [examples.md](references/examples.md)       ✅

# references/guide.md — never link to another reference:
For advanced patterns, see [advanced.md](advanced.md)           ❌
```

Claude may only partially read files referenced from other referenced files.

### Step 3: Write the Description

The description is the **primary activation mechanism** — the only content read before triggering. Treat it as your highest-leverage control. Agents from various sources (global, project, plugins) discover skills purely by description matching across all platforms.

**Writing style:** Third person, under 1024 characters.

Every description must contain:
1. **WHAT** — capabilities covered (technologies, domains, file types)
2. **WHEN** — explicit trigger conditions ("Use when...")
3. **NOT** — explicit out-of-scope boundary ("Do not use for...")
4. **Keywords** — 5+ specific terms from actual user workflows

**Template:**
```yaml
description: >
  [Core capability]. [Secondary capabilities].
  Use when [trigger condition 1], [trigger condition 2],
  or when user mentions "[keyword1]", "[keyword2]".
  Do not use for [adjacent out-of-scope tasks].
```

**Good example:**
```yaml
description: >
  Data engineering practice patterns for data pipelines, ETL/ELT,
  orchestration, data quality, and infrastructure. Covers Airflow,
  Dagster, Prefect, Spark, dbt, data lakes, warehouses, streaming,
  Kafka, and batch processing. Use when reviewing or building data
  pipelines, ingestion systems, or data infrastructure.
```

### Step 4: Degrees of Freedom

Match instruction specificity to the task's fragility:

| Freedom Level | When to Use | Examples |
|--------------|------------|---------|
| **High** (text guidelines) | Multiple valid approaches, context-dependent | Code reviews, architecture decisions |
| **Medium** (pseudocode/params) | Preferred pattern exists but variation OK | Report generation, test scaffolding |
| **Low** (exact scripts) | Fragile operations, consistency-critical | Database migrations, deploy scripts |

### Step 5: Four Failure Modes Check

Verify your skill does NOT fall into these patterns before shipping:

| Failure Mode | Symptom | Fix |
|-------------|---------|-----|
| **Encyclopedia** | Too long, reads like a wiki dump | Split into references/, keep SKILL.md focused |
| **Everything Bagel** | Applies to every task | Move to CLAUDE.md — it's a rule, not a skill |
| **Secret Handshake** | Agent never loads it (vague description) | Rewrite description with real trigger keywords |
| **Fragile Skill** | Breaks when repo changes | Avoid hard-coded paths/versions; use references/ |

---

### Step 6: Pressure-Test Compliance (Required for Workflow and Guardrail Skills)

Activation testing (trigger/non-trigger suites) only confirms the skill fires. It does not confirm the skill changes behavior. A skill that loads but doesn't change what the agent does is documentation, not a skill.

**RED phase — run without the skill:**
1. Construct a realistic prompt that the skill is designed to govern.
2. Invoke that prompt in a fresh session WITHOUT loading the skill.
3. Document every way the agent cuts corners, skips steps, rationalizes, or produces the failure mode the skill is meant to prevent.

**GREEN phase — run with the skill:**
4. Invoke the same prompt in a fresh session WITH the skill loaded.
5. Verify the agent follows the skill's discipline. Check each rationalization from step 3 — it must be absent.

**Exit criteria:**
- Every corner-cutting behavior from step 3 is absent in step 5.
- Skill passes both activation test (trigger/non-trigger) AND compliance test (RED-GREEN).

**If the skill passes activation but fails compliance:** The skill describes what to do but doesn't prevent not doing it. Add an explicit `## Rationalization Resistance` row for each observed failure mode and re-test.

---

## Verification Checklist

**Content:**
- [ ] Step 0 completed: 3+ concrete usage examples gathered
- [ ] Structural pattern chosen (Workflow/Task/Reference/Capabilities)
- [ ] SKILL.md under 500 lines
- [ ] Imperative writing style (verb-first)
- [ ] No README.md or CHANGELOG.md in skill directory
- [ ] All scripts tested by running them
- [ ] No duplication between SKILL.md and references/
- [ ] All resource files linked directly from SKILL.md (one level deep)
- [ ] Four Failure Modes check passed (Step 5)

**Description:**
- [ ] Third person, under 1024 characters
- [ ] Contains WHAT + WHEN + NOT (out-of-scope boundary)
- [ ] 5+ specific trigger keywords from real user workflows
- [ ] Uses "Use when..." and "Do not use for..." patterns

---

## Resource Files

### [TRIGGER_TYPES.md](references/TRIGGER_TYPES.md)
Conceptual guide to trigger patterns: keywords, intent patterns, file paths, content patterns — useful for writing effective descriptions.

### [PATTERNS_LIBRARY.md](references/PATTERNS_LIBRARY.md)
Ready-to-use pattern collection: intent patterns, file path patterns, content patterns — organized by use case.

### [ADVANCED.md](references/ADVANCED.md)
Future enhancements: skill versioning, multi-language support.

### [SKILLS-DEVELOPMENT-GUIDE.md](references/SKILLS-DEVELOPMENT-GUIDE.md)
Source-grounded authoring guide covering the agentskills.io open standard, platform-specific behavior (Claude/Codex/Copilot/Cursor/Gemini), description-writing standard, folder structure patterns, testing harnesses (trigger/non-trigger suites, functional tests), troubleshooting playbook, and the §15 de facto authoring checklist (before dev → required → during dev → before release → after release → portability guardrails → Anthropic-specific constraints). **Consult this before writing or substantially updating any skill.**

---

**Skill Status**: RESTRUCTURED — aligns with official skill-creator standard ✅
**Line Count**: < 500 (following 500-line rule) ✅
**Progressive Disclosure**: Resource files for detailed information ✅
