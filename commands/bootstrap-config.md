---
name: bootstrap-config
description: "Stage 2A: Generate CLAUDE.md and AGENTS.md from Stage 1 discovery analysis."
---

# Stage 2A: Core Configuration

Generate the foundational configuration files: `CLAUDE.md` and `AGENTS.md`.

**Prerequisites:** Stage 1 discovery complete, `.claude/discovery/analysis.yaml` exists.

**Execution mode:** Prioritize execution over deliberation. Choose one approach and start
producing output immediately. Do not compare alternatives or plan the entire generation
before writing. Write each file once; do not go back to revise or rewrite. (For re-bootstrap, Step 3 uses a read-classify-confirm-write cycle — this write-once rule applies to fresh generation only.) If uncertain
about a specific field value, write "TBD" and continue. Only course-correct if you
encounter a concrete failure.

---

# Pre-Generation: Mental Model & Quality Gates

## The Mental Model

Content lives at three levels based on how critical it is to always have in context:

- **CLAUDE.md / AGENTS.md = Always-On Guardrails**
  - Critical rules that must NEVER be missed (if a skill trigger fails, these still catch it)
  - Concise conventions, key constraints, known failure modes
  - Identical content in both files (project-specific content only; workflow, behavioral rules, and general guardrails live in the global `~/.claude/CLAUDE.md`)
  - Budget: concise — enough for guardrails, not a knowledge dump (see Generation Rules for limit)

- **Skills = Behavioral Guidance (How to Approach a Class of Work)**
  - Shape how the agent thinks about and executes a type of task
  - Like `frontend-design` (aesthetic guidelines) or `dbt-core-patterns` (modeling approach)
  - NOT limited to step-by-step procedures — principles, guidelines, and mindset count
  - Invoked via tooling (Claude Code hooks) or model selection (Codex) via description
  - Critical guardrails from skills should be DUPLICATED in CLAUDE.md/AGENTS.md

- **Agents = Task Performers (Doers)**
  - Perform specific tasks (Review, Build, Analyze)
  - Explicitly invoked (optional; Claude Code supports this, Codex may not)
  - Load skills for domain knowledge

- **Memory = Factual Reference**
  - Architecture details, historical context, session-to-session learnings
  - Provides context but doesn't shape behavior
  - `.claude/memory/` or similar

## Quality Gate: Where Does This Content Belong?

| Test | Destination |
|------|-------------|
| Must NEVER be missed, even if no skill triggers? | **CLAUDE.md/AGENTS.md** (and also in the relevant skill) |
| Shapes how the agent approaches a class of work? | **Skill** (with critical rules duplicated in CLAUDE.md/AGENTS.md) |
| Performs a specific task with dedicated tools? | **Agent** (global agents in `~/.claude/agents/` only — project-level agents should be converted to skills; see note below) |
| Factual reference that provides context? | **Memory** (not a skill, not CLAUDE.md) |

**Do not create project-level skills that duplicate global skills.** Check `~/.claude/skills/` and `~/.claude/agents/` first — project skills should only cover project-specific behavioral guidance not found in globals.

**Most projects need ZERO project-level agents.** If `analysis.yaml` recommends domain agents, convert them to skills instead. Agents require explicit invocation and add coordination overhead; skills provide equivalent domain knowledge through progressive disclosure without added complexity. Note: this applies to project-level agents only. Global agents in ~/.claude/agents/ remain a core part of the architecture.

**Monorepo note:** For monorepos, Claude Code auto-discovers skills from nested `.claude/skills/` directories. Sub-packages may need their own skill directories.

---

# Your Mission (Stage 2A)

Generate core configuration files:
1. `CLAUDE.md` - **Always-on guardrails + overview** for Claude Code (see Generation Rules for size and format constraints)
2. `AGENTS.md` - **Always-on guardrails + overview** for Codex (mirrors CLAUDE.md content)

Both files are **self-contained** — duplicate AUTO-GENERATED content so each tool has access to the same information. See Generation Rules for format constraints.

**Anti-hallucination constraint:**
If a specific piece of data is missing from `analysis.yaml`, DO NOT INVENT IT. Write "TBD" or "Not Defined" or skip that section. Better to be incomplete than to fabricate information.

---

# Step 1: Read Discovery Analysis

```bash
if [ ! -f .claude/discovery/analysis.yaml ]; then
    echo "ERROR: .claude/discovery/analysis.yaml not found. Run Stage 1 first."
    exit 1
fi
cat .claude/discovery/analysis.yaml
```

**Required fields:** `tech_stack`, `architecture`, `code_conventions`, `commands`, `critical_patterns`, `historical_failures`, `domain_understanding`, `project_domains`. If `analysis.yaml` does not exist, stop and tell the user to run Stage 1. If a required field is absent, write TBD and note it in the completion summary.

**Default: proceed immediately *through the checks in Steps 2–3*.** Only pause at the explicit confirmation gates defined in Steps 2 and 3. After reading `analysis.yaml`, generate both files without pausing for confirmation. If `analysis.yaml` is missing a required field, write "TBD" and continue — do not stop to ask. Confirmation gates: the global CLAUDE.md warning (Step 2) and the re-bootstrap scenario unmarked content review (Step 3). At all other points, proceed without pausing.

---

# Step 2: Verify Global Behavioral Rules

Before generating project-specific content, verify that the global `~/.claude/CLAUDE.md` provides behavioral rules, workflow, and general guardrails. These sections are repo-agnostic and must NOT be generated into project files.

```bash
if [ -f "$HOME/.claude/CLAUDE.md" ] && grep -q "## Behavioral Rules" "$HOME/.claude/CLAUDE.md"; then
    echo "✅ Global ~/.claude/CLAUDE.md found with Behavioral Rules — project files will omit repo-agnostic sections."
else
    echo "⚠️  WARNING: ~/.claude/CLAUDE.md not found or missing Behavioral Rules section."
    echo "   Behavioral rules, workflow, and general guardrails belong in the global file."
    echo "   Create ~/.claude/CLAUDE.md with these sections before proceeding."
    echo "   Do NOT inject Workflow, Behavioral Rules, or General Guardrails into project CLAUDE.md."
fi
```

**If the warning fires: stop.** Do not proceed to Steps 3–6 until the user confirms `~/.claude/CLAUDE.md` exists with a `## Behavioral Rules` section. Proceeding without this file will generate configuration that is missing all behavioral guardrails — a silently defective output. Once the user confirms the file exists, continue.

---

# Step 3: Check for Existing Configuration (Re-bootstrap)

analysis.yaml is already loaded from Step 1 — use it directly when classifying existing sections as OUTDATED, REDUNDANT, or CUSTOM.

Before generating, check if configuration already exists:

```bash
ls CLAUDE.md AGENTS.md .claude/skills/*/SKILL.md 2>/dev/null
```

**If CLAUDE.md or AGENTS.md exist (re-bootstrap scenario):**

Handle all sections based on markers:

1. **`<!-- AUTO-GENERATED: ... -->` sections:** Regenerate from analysis.yaml (replace entirely — do not carry forward entries from the previous version). Every Critical Guardrail and Known Pitfall must trace to a current entry in analysis.yaml. If a pattern or failure no longer appears in analysis.yaml, its corresponding line must not appear in the regenerated output.
2. **`<!-- USER SECTION: ... -->` sections:** Preserve user content (do not overwrite)
3. **`<!-- SKILL-DERIVED: ... -->` sections:** Preserve unchanged — authored by Stage 2C; Stage 2C will refresh them when it runs
4. **Unmarked sections:** Analyze and propose changes (see below)

**Handling Unmarked/Legacy Content:**

Pre-existing files without markers likely contain outdated information. For each unmarked section:

1. **Analyze** - Compare against analysis.yaml and template
2. **Classify** as one of:
   - **OUTDATED:** Content contradicts analysis.yaml or describes patterns no longer present
   - **REDUNDANT:** Content duplicates what will be in AUTO-GENERATED sections or skills
   - **CUSTOM:** Genuinely user-specific content worth preserving
   - **UNKNOWN:** Cannot determine relevance
3. **Propose action** with reasoning:
   ```
   UNMARKED CONTENT REVIEW:

   Section: "[section name or first line]"
   Classification: OUTDATED
   Reasoning: This describes X pattern, but analysis.yaml shows Y is now used (83% consistency)
   Proposed action: REMOVE

   Section: "[section name]"
   Classification: CUSTOM
   Reasoning: Team-specific workflow not derivable from codebase analysis
   Proposed action: PRESERVE (convert to USER SECTION)

   Proceed with these changes? [Y/n/edit]
   ```
4. **Wait for user confirmation** before applying changes

**Process (applies to both CLAUDE.md and AGENTS.md):**

1. Back up existing files:
   ```bash
   [ -f CLAUDE.md ] && cp CLAUDE.md CLAUDE.md.bak
   [ -f AGENTS.md ] && cp AGENTS.md AGENTS.md.bak
   [ -f .claude/hooks.json ] && cp .claude/hooks.json .claude/hooks.json.bak
   ```

2. Read existing file, identify marked vs unmarked sections
3. For AUTO-GENERATED: regenerate from template + analysis.yaml
4. For USER SECTION: preserve as-is
5. For UNMARKED: analyze, propose changes, get user confirmation
6. Generate final file with proper markers on all sections

**If no existing CLAUDE.md:**
Generate fresh from template.

---

# Step 4: Clean Up Deprecated Files (Re-bootstrap Only — Claude Code paths)

**Gate:** Only run if analysis.yaml was confirmed valid in Step 1.

Previous bootstrap versions created files that are no longer used. Remove them (these are `.claude/` files only; no equivalent cleanup is needed for `.agents/`):

```bash
# Remove deprecated hooks.json (triggers are now in skill-rules.json)
if [ -f ".claude/hooks.json" ]; then
    echo "Removing deprecated .claude/hooks.json (triggers now in skill-rules.json)"
    trash .claude/hooks.json
fi

# Remove any _skill-rules-entry.json files left behind by previous bootstrap cycles.
# Only safe at the START of a fresh bootstrap — skip if Stage 2C has already started
# (Stage 2C Step 7 sub-step 4 "Delete Artifacts" is the authoritative cleanup for mid-cycle runs).
# Guard: skip if any SKILL.md already exists (means Stage 2C has started or completed).
if find .claude/skills -name "SKILL.md" -mindepth 2 -maxdepth 2 2>/dev/null | grep -q .; then
    echo "Skipping _skill-rules-entry.json cleanup — Stage 2C appears to have started (SKILL.md files found). Stage 2C Step 7 sub-step 4 will clean up these files."
else
    for f in .claude/skills/*/_skill-rules-entry.json; do [ -f "$f" ] && trash "$f"; done 2>/dev/null
    echo "Cleaned up leftover _skill-rules-entry.json files (pre-Stage 2C state confirmed)."
fi

# Remove skill README.md files (these are temporary artifacts from init_skill.py)
for f in .claude/skills/*/README.md; do [ -f "$f" ] && trash "$f"; done 2>/dev/null
```

**Note:** `skill-rules.json` is an optional Claude Code extension for deterministic skill activation via hooks. It is generated in Stage 2C for critical skills (review gates, safety). Most skills use description-based activation and do not need entries here.

**Why:** Old files will confuse users and cause inconsistencies. All workflow content is now in CLAUDE.md.

---

# Generation Rules (apply to both CLAUDE.md and AGENTS.md)

**Omit the following — they do not belong in always-on files:**
- No "Available Skills" or "Key Skills" table — CLAUDE.md and AGENTS.md are loaded on every task regardless of topic; listing skills that auto-trigger wastes context budget on tasks where those skills are irrelevant, and the list goes stale
- No "Available Agents" or "Project Agents" section — agents are task-specific constructs; their domain knowledge belongs in skills, not in an always-on file that is loaded unconditionally
- No verbose code examples — examples consume disproportionate tokens in an always-on file; the concise rule goes here, the full example goes in the skill where it is loaded on demand
- No "Workflow Hints" or skill routing hints — skills activate via descriptions (primary) and `skill-rules.json` hooks (critical skills); embedding routing in always-on files duplicates these mechanisms, goes stale, and creates race conditions when skills are provisioned after CLAUDE.md
- No Workflow, Behavioral Rules, or General Guardrails sections — these are repo-agnostic and live in the global `~/.claude/CLAUDE.md`. Project files contain only project-specific content.

**AUTO-GENERATED markers are required on all auto-generated sections:**
- Use `<!-- AUTO-GENERATED: Section Name -->` and `<!-- END AUTO-GENERATED -->` for all content derived from `analysis.yaml` or codebase analysis
- Use `<!-- USER SECTION: Section Name -->` and `<!-- END USER SECTION -->` only to preserve sections that already exist in a re-bootstrap file — do not create new USER SECTION blocks in fresh files
- Use `<!-- SKILL-DERIVED: Section Name -->` and `<!-- END SKILL-DERIVED -->` for content authored by Stage 2C and Stage 2C+. On re-bootstrap, Stage 2A MUST preserve SKILL-DERIVED blocks unchanged. Stage 2C will overwrite them with fresh guardrails from the current skills after it runs.
- Sections without markers in re-bootstrap files will be analyzed and proposed for classification (see Step 3)

---

# Step 5: Generate CLAUDE.md (Always-On Guardrails)

**CLAUDE.md-specific constraints:**
- Keep under 5k tokens — CLAUDE.md is auto-read on every task; every token here is spent before the actual task begins, regardless of what that task is
- No @imports — they load eagerly at session start and consume context budget whether or not the imported content is relevant to the current task
- Include critical guardrails from `analysis.yaml` directly — these are the safety net when skills don't trigger

Create `CLAUDE.md`:

```markdown
# Project Instructions (Claude Code)

> Generated: [date] from codebase analysis
> Skills in `.claude/skills/` contain detailed implementation guides.

<!-- AUTO-GENERATED: Overview -->
## Overview

This repository uses a **skills-first** workflow.

**Sources of Truth:**
- `.claude/skills/`: detailed implementation guides (progressive disclosure)
[Only include the next line if `.context/` exists in the project:]
- `.context/steering/` for global docs, `.context/specs/<feature>/` for feature docs
<!-- END AUTO-GENERATED -->

<!-- AUTO-GENERATED: Tech Stack -->
## Tech Stack

**Primary:** [Language] [version] + [Framework] [version]
[For multi-domain projects with distinct tech stacks per domain, e.g. TypeScript web + Python ML, use: **Primary:** TypeScript [version] (web/frontend) + Python [version] (ML/data)]
**Data Layer:** [DB/Warehouse + access method — ORM, dbt, direct SQL, etc.]
**Testing:** [Framework]
**Key Libraries:** [Top 3-5 most important]
<!-- END AUTO-GENERATED -->

<!-- AUTO-GENERATED: Commands -->
## Commands

```bash
[From analysis.yaml — whatever commands the project uses]
```
<!-- END AUTO-GENERATED -->

<!-- AUTO-GENERATED: Code Conventions -->
## Code Conventions

**Naming:** [e.g., PascalCase for React, snake_case for Python, stg_/int_/fct_/dim_ for dbt]
**Dependencies:** [Brief summary - e.g., "React → Third-party → Local, use @/ alias"]
**References:** [Key rules, e.g., "Always use {{ ref() }}"]

**For details:** Load relevant skill
<!-- END AUTO-GENERATED -->

<!-- AUTO-GENERATED: Critical Guardrails -->
## Critical Guardrails

These rules apply even when no skill triggers. They are duplicated here from skills so they are always in context.

[Extract from analysis.yaml `critical_patterns` — one concise line per rule. Examples:]
- [e.g., "Incremental models MUST specify `unique_key` — omitting causes duplicates"]
- [e.g., "Always use `{{ ref() }}` for dbt models and `{{ source() }}` for raw tables — never hardcode table names"]
- [e.g., "Stored procedures MUST use BEGIN TRANSACTION / COMMIT / ROLLBACK — no unprotected multi-statement operations"]
- [e.g., "Changes to distributor models MUST be mirrored to chain models (_chains suffix)"]

**For full context and examples, load the relevant skill.**
<!-- END AUTO-GENERATED -->

<!-- SKILL-DERIVED: Skill Guardrails -->
<!-- Populated by Stage 2C after skills are generated. Leave empty on first bootstrap. -->
<!-- END SKILL-DERIVED -->

<!-- AUTO-GENERATED: Known Pitfalls -->
## Known Pitfalls

Historical failures from this codebase. Avoid repeating these.

[Extract from analysis.yaml `historical_failures` — one line per failure with commit ref. Examples:]
- [e.g., "`cc52206`: Post-hooks needed for platform status updates after dbt build — don't rely solely on workflow SPs"]
- [e.g., "`6c63c42`: No environment-specific schema prefixes in SP bodies — use deployment scripts instead"]

**For root cause details, load the relevant skill.**
<!-- END AUTO-GENERATED -->

<!-- AUTO-GENERATED: Project Context -->
## Project Context

**What This App Does:** [Brief description from analysis.yaml or TBD]

**Domain Clusters:** [List key domain areas from analysis.yaml, e.g., "Retail Analytics: 80 files, Revenue Recognition: 35 files"]
<!-- END AUTO-GENERATED -->
```

**Validation:**
- Run `wc -w CLAUDE.md` — aim for under 3,500 words (~5k tokens); if over, prune the longest sections first
- Verify NO @import statements exist
- Critical guardrails section populated from analysis.yaml (not empty/TBD)
- No raw file paths used as references (no src/, lib/, .ts, .py extensions). References should name the skill: 'load the api-patterns skill' or 'see .claude/skills/api-patterns/'.
- Verify NO Workflow, Behavioral Rules, or General Guardrails sections exist — these belong in `~/.claude/CLAUDE.md`

---

# Step 6: Generate AGENTS.md (Mirrors CLAUDE.md)

Codex reads `AGENTS.md` automatically before doing any work. This file mirrors CLAUDE.md — same guardrails, same conventions, same rules. Apply the Generation Rules defined above (including the size limit).

Create `AGENTS.md`:

```markdown
# Project Instructions (Codex)

> Generated: [date] from codebase analysis
> Skills in `.agents/skills/` contain detailed implementation guides.

<!-- AUTO-GENERATED: Overview -->
## Overview

This repository uses a **skills-first** workflow.

**Sources of Truth:**
- `.agents/skills/`: detailed implementation guides (progressive disclosure)
[Only include the next line if `.context/` exists in the project:]
- `.context/steering/` for global docs, `.context/specs/<feature>/` for feature docs
<!-- END AUTO-GENERATED -->

<!-- AUTO-GENERATED: Tech Stack -->
## Tech Stack

**Primary:** [Language] [version] + [Framework] [version]
[For multi-domain projects with distinct tech stacks per domain, e.g. TypeScript web + Python ML, use: **Primary:** TypeScript [version] (web/frontend) + Python [version] (ML/data)]
**Data Layer:** [DB/Warehouse + access method — ORM, dbt, direct SQL, etc.]
**Testing:** [Framework]
**Key Libraries:** [Top 3-5 most important]
<!-- END AUTO-GENERATED -->

<!-- AUTO-GENERATED: Commands -->
## Commands

```bash
[From analysis.yaml — whatever commands the project uses]
```
<!-- END AUTO-GENERATED -->

<!-- AUTO-GENERATED: Code Conventions -->
## Code Conventions

**Naming:** [e.g., PascalCase for React, snake_case for Python, stg_/int_/fct_/dim_ for dbt]
**Dependencies:** [Brief summary - e.g., "React → Third-party → Local, use @/ alias"]
**References:** [Key rules, e.g., "Always use {{ ref() }}"]

**For details:** See relevant skill in `.agents/skills/`
<!-- END AUTO-GENERATED -->

<!-- AUTO-GENERATED: Critical Guardrails -->
## Critical Guardrails

These rules apply even when no skill triggers. They are duplicated here from skills so they are always in context.

[Same content as CLAUDE.md Critical Guardrails section — keep identical]
<!-- END AUTO-GENERATED -->

<!-- SKILL-DERIVED: Skill Guardrails -->
<!-- Populated by Stage 2C after skills are generated. Leave empty on first bootstrap. -->
<!-- END SKILL-DERIVED -->

<!-- AUTO-GENERATED: Known Pitfalls -->
## Known Pitfalls

Historical failures from this codebase. Avoid repeating these.

[Same content as CLAUDE.md Known Pitfalls section — keep identical]
<!-- END AUTO-GENERATED -->

<!-- AUTO-GENERATED: Project Context -->
## Project Context

**What This App Does:** [Brief description from analysis.yaml or TBD]

**Domain Clusters:** [List key domain areas from analysis.yaml, e.g., "Retail Analytics: 80 files, Revenue Recognition: 35 files"]
<!-- END AUTO-GENERATED -->
```

**Validation:**
- Run `wc -w AGENTS.md` — aim for under 3,500 words (~5k tokens); if over, prune the longest sections first
- Verify structure matches CLAUDE.md (critical guardrails and known pitfalls present)
- All sections properly marked
- Verify NO Workflow, Behavioral Rules, or General Guardrails sections exist — these belong in `~/.claude/CLAUDE.md`

---

# Stage 2A Complete

**Generated:**
- ✅ `CLAUDE.md` (always-on guardrails + overview, per Generation Rules constraints)
- ✅ `AGENTS.md` (mirrors CLAUDE.md — identical project-specific content)
- ✅ Codex skills path standardized to `.agents/skills/` (documented contract; optional `.codex/skills/` mirror only if your environment requires compatibility)

**Deprecated (removed if present):**
- ❌ Project-level agents — domain knowledge belongs in skills, not agents

**Verify Stage 2A complete:**
- [ ] `wc -w CLAUDE.md` → under 3,500 words
- [ ] `wc -w AGENTS.md` → under 3,500 words
- [ ] `diff <(sed 's/AGENTS\.md/CLAUDE.md/g' AGENTS.md) CLAUDE.md` → minimal diffs (path names only)
- [ ] `grep "@import" CLAUDE.md AGENTS.md` → no results
- [ ] `grep "## Behavioral Rules\|## General Guardrails" CLAUDE.md AGENTS.md` → no results

**Next:** Run Stage 2C (Skills Generation).
