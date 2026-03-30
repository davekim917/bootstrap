---
name: bootstrap-skills
description: "Stage 3: Generate project-specific skills from discovery analysis."
---

# Stage 3: Skills Generation (Core Skills)

Generate core skills based on `analysis.yaml` recommendations.

**Prerequisites:** Stage 2 complete.

---

# Step 1: Load Skill Developer (Do This First)

Before any other step, load the global `skill-developer` skill. Steps 6 and 7 depend on the Four Failure Modes, Degrees of Freedom, and description quality frameworks it defines.

```bash
cat ~/.claude/skills/skill-developer/SKILL.md 2>/dev/null || echo "skill-developer not installed — use Quality Standards section in this prompt as fallback"
```

**If skill-developer exists:** Keep its guidance in context for all subsequent steps — especially Step 6 (deduplication) and Step 7 (skill generation).

**If skill-developer does not exist:** The Quality Standards section below is the fallback. Proceed without it.

---

# Skill Frontmatter Reference

> If the global `skill-developer` skill was loaded in Step 1, it contains complete frontmatter guidance — use it directly and skip this section.
>
> Otherwise, use the working templates in Step 7 as your reference. The essential frontmatter fields are:
> - `name`: kebab-case, 1-64 chars, must match directory name
> - `description`: WHAT + WHEN + "Do not use for" boundary, under 1024 chars, third person
>
> For the full specification including Claude Code extensions (`context`, `agent`, `hooks`, `model`, `disable-model-invocation`, `allowed-tools`), see [SKILLS-DEVELOPMENT-GUIDE.md](skill-developer/references/SKILLS-DEVELOPMENT-GUIDE.md).

---

# Step 2: Verify Global Behavioral Rules

Before loading project-specific content, confirm that global behavioral rules exist so the project CLAUDE.md is not used to re-inject them.

```bash
if [ -f ~/.claude/CLAUDE.md ] && grep -q "Behavioral Rules" ~/.claude/CLAUDE.md; then
  echo "✓ Global ~/.claude/CLAUDE.md found with Behavioral Rules — project CLAUDE.md does NOT need Workflow, Behavioral Rules, or General Guardrails sections."
else
  echo "⚠ WARNING: ~/.claude/CLAUDE.md is missing or lacks Behavioral Rules."
  echo "  These sections must NOT be regenerated into the project CLAUDE.md."
  echo "  Ask the user to create ~/.claude/CLAUDE.md from the global template before continuing."
  echo "  Reference: /bootstrap-skills Step 2"
fi
```

**If the warning fires:** Pause and surface it to the user. Do not re-inject Workflow, Behavioral Rules, or General Guardrails into the project CLAUDE.md. Those sections are repo-agnostic and belong only in the global file.

**Project CLAUDE.md should contain only:**
- Overview, Tech Stack, Commands, Code Conventions (summary), Critical Guardrails (project-specific), Known Pitfalls, Project Context

---

# Step 3: Load Analysis Data

First, read the discovery analysis:

```bash
cat .claude/discovery/analysis.yaml
```

This file contains all patterns, conventions, and recommendations from Stage 1 discovery. Use it as the source of truth for skill content.

Prioritize execution over deliberation. Choose one approach and start producing output immediately. Do not compare alternatives or plan the entire generation before writing. Do not exhaustively explore before starting; begin with what you know. Write each piece of work once; do not go back to revise or rewrite. If uncertain about a detail, make a reasonable choice and continue. Only course-correct if you encounter a concrete failure.

**Malformed analysis.yaml:** If `analysis.yaml` lacks a `recommendations` section, pause and report the issue rather than generating skills from assumptions.

---

# Step 3b: Resolve Domain Parameters for Review Gates

Read `project_domains` from analysis.yaml to parameterize review-gate skills (7a, 7b, 7c). This replaces hardcoded software-engineering assumptions with domain-appropriate keywords, fallback baselines, and implementation steps.

```bash
echo "=== Project Domains ==="
yq '.project_domains[]' .claude/discovery/analysis.yaml 2>/dev/null || \
python3 -c "import yaml; [print(d) for d in yaml.safe_load(open('.claude/discovery/analysis.yaml')).get('project_domains',[])]" 2>/dev/null || echo "UNKNOWN"
```

For each detected domain, collect the matching rows from the tables below. **Multi-domain projects:** union all matching rows; deduplicate overlapping keywords. **Unknown/novel domains:** use the `(any)` fallback row, then derive additional terms from `analysis.yaml → tech_stack` and `critical_patterns` categories. **Partial matches:** if `project_domains` contains "analytics" instead of "data-analytics", match to the closest table row.

## Security Review Gates — Domain Parameters

| Domain | Description Keywords | Fallback Baseline | Implementation Guide Steps |
|--------|---------------------|-------------------|---------------------------|
| software | auth logic, permissions, request parsing, environment variables, secret management, API security | OWASP Top 10 baseline (marked "baseline — not project-specific") | Confirm authorization at the correct layer; verify "deny by default" where applicable. Validate external inputs using project-standard tooling; ensure errors don't leak sensitive details. |
| data-analytics | PII-containing data models, column masking, row-level security, warehouse credentials, hardcoded schema names | PII exposure in unmasked models; hardcoded credentials in SQL (marked "baseline — not project-specific") | Confirm PII columns are masked or excluded in downstream models; verify row-level security where applicable. Check that warehouse credentials use env vars or secrets, not hardcoded values. |
| data-engineering | pipeline credentials, secrets manager usage, DAG connection security, access controls on sensitive pipelines | Credentials in DAG configs; no secrets manager; unprotected sensitive pipelines (marked "baseline — not project-specific") | Confirm credentials use the secrets backend (not DAG config or env literals); verify access controls on pipelines touching sensitive data. Check that sensitive data in transit/at rest uses appropriate encryption. |
| ml-ds | PII in notebook outputs, sensitive training data columns, hardcoded API keys, model serving authentication | PII in notebook outputs or model artifacts; API keys in code; unauthenticated model endpoints (marked "baseline — not project-specific") | Confirm training data excludes or masks PII; verify model serving endpoints require authentication. Check that API keys and credentials are not in notebooks, scripts, or committed outputs. |
| ai-llm | API key exposure, prompt injection, system prompt leakage, input sanitization, output filtering | Prompt injection vectors; API key in source; system prompt leakage (marked "baseline — not project-specific") | Confirm API keys use env vars or secrets manager; verify user inputs are sanitized before inclusion in prompts. Check that system prompts are not exposed in responses; validate output filtering for sensitive content. |
| financial-analytics | PII in compensation data, audit trail enforcement, GL access controls, regulatory compliance (SOX/GAAP) | PII in financial reports; missing audit trails; unrestricted GL access (marked "baseline — not project-specific") | Confirm compensation/PII data models enforce access controls; verify audit trail logging is present on sensitive operations. Check that regulatory-sensitive models have appropriate access restrictions. |
| mobile | secure storage, certificate pinning, biometric auth, keychain/keystore usage, deep link validation | Sensitive data in plaintext storage; missing certificate pinning; insecure deep link handling (marked "baseline — not project-specific") | Confirm sensitive data uses secure storage (Keychain/Keystore); verify certificate pinning for API calls. Check that deep links validate parameters and biometric auth guards sensitive operations. |
| (any) | environment variables, secret management, access controls, credentials | TBD — derive from project tech stack (marked "baseline — not project-specific") | Confirm credentials are not hardcoded; verify access controls on sensitive operations. Flag for `security-reviewer` agent if changes affect authentication or authorization. |

## Performance Review Gates — Domain Parameters

| Domain | Description Keywords | Fallback Baseline | Implementation Guide Steps |
|--------|---------------------|-------------------|---------------------------|
| software | database queries, list endpoints, background jobs, rendering paths, caching logic, connection pooling | N+1 queries; missing pagination; unbounded result sets (marked "baseline — not project-specific") | Look for N+1 patterns, missing pagination, unbounded scans. Confirm loops/joins are bounded; payload sizes reasonable. |
| data-analytics | model materialization, SQL query complexity, full table scans, incremental strategy, partition pruning, clustering keys | Full table scans on large models; missing incremental materialization; no partition pruning (marked "baseline — not project-specific") | Check materialization strategy (incremental vs table vs view) is appropriate for model size; verify partition/cluster keys on large tables. Look for SELECT *, deeply nested CTEs, and cross-joins that could explode row counts. |
| data-engineering | DAG task granularity, full vs incremental refresh, partition strategy, extraction bounds, idempotency | Full refreshes where incremental is viable; monolithic DAGs; unbounded extractions (marked "baseline — not project-specific") | Confirm extractions are bounded (date ranges, partitions); verify incremental loads where data volume warrants it. Check that DAG tasks are appropriately granular and operations are idempotent. |
| ml-ds | training data loading, memory management, batch processing, experiment tracking, feature computation | Loading entire datasets into memory; no chunking/batching; non-reproducible experiments (marked "baseline — not project-specific") | Confirm data loading uses batching/chunking for large datasets; verify memory-intensive operations have limits. Check that feature engineering doesn't introduce data leakage and experiments are reproducible. |
| ai-llm | token cost tracking, model tier selection, context window management, retry/backoff, agent loop bounds | Unbounded agent loops; no token tracking; wrong model tier for task complexity (marked "baseline — not project-specific") | Confirm agent/chain loops have explicit iteration limits; verify model tier selection matches task complexity. Check that context windows are managed (summarization/truncation) and retry logic has backoff. |
| financial-analytics | GL history query ranges, pre-aggregation, multi-year refreshes, reporting query complexity | Full refreshes on multi-year GL data; unfiltered date ranges; no pre-aggregation (marked "baseline — not project-specific") | Confirm GL queries filter by date range (not full history scans); verify pre-aggregation for reporting models. Check that multi-year data uses incremental refresh strategy. |
| mobile | list rendering, image loading, bundle size, network requests, offline caching | Unbounded list rendering; oversized bundles; redundant network requests (marked "baseline — not project-specific") | Confirm lists use virtualization for large datasets; verify images are lazy-loaded and appropriately sized. Check that bundle size is monitored and network requests are batched where possible. |
| (any) | large-scale data processing, batch processing, caching logic | TBD — derive from project tech stack (marked "baseline — not project-specific") | Confirm data operations are bounded; verify caching strategy for repeated operations. Flag for `performance-analyzer` agent if changes touch hot paths. |

## General Review-Gates — Domain Parameters (for 7a Step 4 flagging)

| Domain | Security Flagging Keywords | Performance Flagging Keywords |
|--------|---------------------------|------------------------------|
| software | auth, security, permissions, secrets | database queries, hot paths, caching |
| data-analytics | PII, masking, warehouse credentials | materialization, large models, full scans |
| data-engineering | credentials, pipeline access, encryption | refresh strategy, extraction bounds, DAG structure |
| ml-ds | PII in data, API keys, model auth | memory usage, data loading, feature pipelines |
| ai-llm | API keys, prompt injection, input sanitization | token costs, agent loops, context windows |
| financial-analytics | audit trails, GL access, compensation data | GL query ranges, pre-aggregation, reporting |
| mobile | secure storage, certificates, deep links | list rendering, bundle size, network calls |
| (any) | credentials, access controls | resource usage, data processing bounds |

## Resolution Procedure

1. Read `project_domains` array from analysis.yaml.
2. For each domain value, find the matching row in all three tables. If no exact match, use `(any)`.
3. Union the Description Keywords, Fallback Baselines, and Implementation Guide Steps across all matched domains. Deduplicate keywords.
4. Store the resolved parameters for use in sections 7a, 7b, and 7c:
   - `SECURITY_DESCRIPTION_KEYWORDS`, `SECURITY_FALLBACK_BASELINE`, `SECURITY_IMPL_STEPS`
   - `PERF_DESCRIPTION_KEYWORDS`, `PERF_FALLBACK_BASELINE`, `PERF_IMPL_STEPS`
   - `GENERAL_SECURITY_FLAGS`, `GENERAL_PERF_FLAGS`

---

# Step 4: Evaluation-Driven Development (Required per-skill — define trigger/non-trigger suite before writing each skill)

Define 2-3 trigger and 1-2 non-trigger prompts before each skill. Do not begin writing a skill until its trigger/non-trigger suite is defined. Skills built without evaluations frequently document imagined patterns rather than real ones.

For each skill you're about to generate:

1. **Define trigger suite (3-5 prompts total):**
   - 2-3 prompts that SHOULD trigger
   - 1-2 prompts that SHOULD NOT trigger
2. **Define expected behavior** — what the model should do when the skill activates
3. **Establish baseline** — what the model does WITHOUT the skill (often: misses patterns, uses wrong conventions)

**Example:**
```
Skill: code-conventions
SHOULD trigger: "Add a new API endpoint for user preferences", "Refactor this function to match project style"
SHOULD NOT trigger: "Write a generic Python sort function", "Explain how REST APIs work"
Expected: Claude references project-specific conventions
Baseline: Claude uses generic conventions that may not match this project
```

If `analysis.yaml` includes an `evaluation_scenarios` section (from a previous bootstrap, if re-bootstrapping), use those as a starting point and expand as needed.

After generating each skill, verify the content would pass these scenarios. Optionally save trigger/non-trigger prompts alongside skills for future re-evaluation and re-bootstrap audits.

### Advanced Evaluation (optional)

For complex or high-stakes skills, extend the basic trigger/non-trigger suite with these techniques:

- **End-to-end workflow tests:** Define at least one per major workflow — input payload, expected tool/MCP sequence, expected output artifact/schema, and expected failure handling for one known error mode.
- **Cross-model testing:** Skills that work for Opus may need more detail for Haiku. If the project uses multiple models, test critical skills across Haiku/Sonnet/Opus.
- **Claude A/B iterative development:** One Claude instance creates the skill, another tests it against the evaluation scenarios. Iterate until scenarios pass.

---

# Step 5: Dual-Tool Output (Claude Code + Codex)

This workflow generates skills for both runtimes:
- `.claude/skills/<skill-name>/SKILL.md` (Claude Code)
- `.agents/skills/<skill-name>/SKILL.md` (Codex documented repo contract)

**Rule:** Skill behavior should be equivalent across runtimes. Keep core `SKILL.md` guidance in sync, but allow runtime-specific metadata/overlays where required.

Ensure the Codex skills directory exists:

```bash
mkdir -p .agents/skills
# Only create .codex/skills if your environment still requires it:
# mkdir -p .codex/skills
```

## Skill Invocation Differences

| Tool | Activation Method |
|------|-------------------|
| **Claude Code** | Description-based activation — the skill's `description` field in SKILL.md frontmatter determines when the model activates it |
| **Codex** | Selected by model via description matching, or explicitly invoked with `$skill-name` syntax (e.g., `$code-conventions`, `$review-gates`) |

**Codex users**: To explicitly invoke a skill, use the `$skill-name` syntax in prompts:
```
$code-conventions
$review-gates
$security-review-gates
```

This is particularly useful when the model doesn't auto-select the skill you need.

---

# Step 6: Global Skills Deduplication Guard

Before generating any project skill, check what global skills and agents already exist — project skills must not duplicate global coverage. This is what Step 6 is for.

## 6a: Read Global Inventory from analysis.yaml + Live Cross-Check

First, read what Stage 1 recorded:

```bash
echo "=== Global Skills (from analysis.yaml) ==="
yq '.recommendations.global_skills_available.skills[] | "- " + .name + ": " + .description' .claude/discovery/analysis.yaml 2>/dev/null || \
python3 -c "import yaml; [print(f'- {s[\"name\"]}: {s[\"description\"]}') for s in yaml.safe_load(open('.claude/discovery/analysis.yaml')).get('recommendations',{}).get('global_skills_available',{}).get('skills',[])]" 2>/dev/null || echo "(no global skills recorded)"

echo ""
echo "=== Global Agents (from analysis.yaml) ==="
yq '.recommendations.global_agents_available.agents[] | "- " + .name + ": " + .description' .claude/discovery/analysis.yaml 2>/dev/null || \
python3 -c "import yaml; [print(f'- {s[\"name\"]}: {s[\"description\"]}') for s in yaml.safe_load(open('.claude/discovery/analysis.yaml')).get('recommendations',{}).get('global_agents_available',{}).get('agents',[])]" 2>/dev/null || echo "(no global agents recorded)"

echo ""
echo "=== Codex Global Skills (from analysis.yaml, if present) ==="
yq '.recommendations.global_codex_skills_available.skills[] | "- " + .name + ": " + .description' .claude/discovery/analysis.yaml 2>/dev/null || \
python3 -c "import yaml; [print(f'- {s[\"name\"]}: {s[\"description\"]}') for s in yaml.safe_load(open('.claude/discovery/analysis.yaml')).get('recommendations',{}).get('global_codex_skills_available',{}).get('skills',[])]" 2>/dev/null || echo "(no Codex global skills recorded)"
```

**Run this block unconditionally** — do not skip even if analysis.yaml appears complete. `analysis.yaml` may have an incomplete or corrupted inventory (e.g., project-local skills accidentally listed as global, or global skills missing). The live check is the ground truth:

```bash
echo ""
echo "=== Live Global Skills Cross-Check (REQUIRED — do not skip) ==="
echo "(Compare against analysis.yaml above — differences indicate Stage 1 inventory errors)"
LIVE_SKILL_COUNT=0
for skill_dir in ~/.claude/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
        echo "- $(basename "$skill_dir")"
        LIVE_SKILL_COUNT=$((LIVE_SKILL_COUNT + 1))
    fi
done
[ "$LIVE_SKILL_COUNT" -eq 0 ] && echo "(no global skills found on filesystem)"

echo ""
echo "=== Live Global Agents Cross-Check ==="
for f in ~/.claude/agents/*.md; do
    [ -f "$f" ] && echo "- $(basename "$f" .md)"
done

echo ""
echo "=== Live Codex Global Skills Cross-Check (if available) ==="
for skill_dir in "$CODEX_HOME"/skills/*/ ~/.codex/skills/*/; do
    [ -f "${skill_dir}SKILL.md" ] && echo "- $(basename "$skill_dir")"
done
```

**Reconciliation (required):** Compare the analysis.yaml inventory against the live cross-check output. Build a reconciled working inventory before proceeding to Step 6b. This is a working-inventory correction for the current deduplication pass — do not edit analysis.yaml itself:

| Discrepancy | Action |
|-------------|--------|
| Skill in analysis.yaml but NOT on filesystem | **Remove** from working inventory — it doesn't exist as a global skill (may be a project-local skill that was incorrectly recorded by Stage 1) |
| Skill on filesystem but NOT in analysis.yaml | **Add** to working inventory — Stage 1 missed it. Read the skill's description from `~/.claude/skills/{name}/SKILL.md` to get the `covers` field |
| Skill in both but with different description | **Use filesystem version** — it's more current than the Stage 1 snapshot |

**Use the reconciled working inventory (not the raw analysis.yaml) for all deduplication decisions in Step 6b.**

## 6b: Deduplication Rules

> **Note:** Use the reconciled inventory from Step 6a — not analysis.yaml directly — for all decisions below.

For EACH skill you are about to generate, apply these rules:

| Situation | Action |
|-----------|--------|
| A global skill covers the **same domain** (e.g., global `next-best-practices` vs project `nextjs-patterns`) | **DUPLICATE** — do not generate the project skill |
| A global skill covers a **superset** (e.g., global `software-engineering` covers React/Node/APIs) | **SUBSET** — do not generate the generic project skill; only generate if the project skill adds project-specific patterns not in the global |
| A global skill **partially overlaps** (e.g., global `vercel-react-best-practices` vs project `component-patterns`) | **COMPLEMENT** — generate the project skill but scope it to project-specific patterns only, and add a note: "For general React best practices, see the global `vercel-react-best-practices` skill" |
| A global **agent** covers the same review domain (e.g., `security-reviewer` agent vs `security-review-gates` skill) | **LAYERED** — keep the skill as a thin checklist that complements the agent using the layered review pattern (see below) |
| No global overlap | **CLEAN** — generate normally |

**Coverage threshold guidance:**
- **>80% overlap** → DUPLICATE/SUBSET — do not generate the project skill
- **50–80% overlap** → COMPLEMENT — generate the delta only (project-specific patterns not in the global skill)
- **<50% overlap** → CLEAN — generate fully

**Log deduplication decisions** — output to stdout AND save to `.claude/discovery/deduplication-report.txt` (Stage 4, Stage 5, and Stage 6 reference this file for automated checks):

**Format is machine-parseable** — each line must start with the classification keyword, followed by a colon and space, followed immediately by the skill name. Stage 5 and Stage 6 use `grep "^LAYERED: $skill_name"` to detect LAYERED classifications. Do not put any prefix before the skill name on LAYERED lines.

**Write discipline:** Initialize with `>` (overwrite): the first write clears any prior run's entries. Use the format block as the complete file header. If called multiple times in the same session (e.g., for each skill), append subsequent lines only.

```bash
echo "=== Deduplication Report ===" > .claude/discovery/deduplication-report.txt
# Then for each subsequent entry:
echo "CLEAN: [skill-name] — no global overlap" >> .claude/discovery/deduplication-report.txt
```

```
=== Deduplication Report ===
DUPLICATE: [skill-name] — covered by global skill: [global-skill-name]
SUBSET: [skill-name] — covered by global superset: [global-skill-name]
COMPLEMENT: [skill-name] — partially overlaps global: [global-skill-name], scoping to project-specific patterns
CLEAN: [skill-name] — no global overlap
LAYERED: [skill-name] — thin checklist, complements global [agent-name] agent
```

**Example LAYERED classifications** (only when the corresponding global agent exists — if no global agent covers the domain, classify as CLEAN instead):
```
LAYERED: review-gates — thin checklist, complements global code-review-specialist agent
LAYERED: security-review-gates — thin checklist, complements global security-reviewer agent
LAYERED: performance-review-gates — thin checklist, complements global performance-analyzer agent
```

## 6c: Layered Review Pattern (Review Gates + Global Agents)

Review gate skills serve **four distinct consumers** — keep all four in mind when generating them:

| Consumer | How It Uses Review Gates |
|----------|--------------------------|
| **`/qa` Validators C and D** | Load `security-review-gates` and `performance-review-gates` as project-specific context for post-build validation |
| **`/plan` Step 1** | Loads `review-gates` to understand quality standards for task decomposition |
| **Trivial work path** | Self-check before committing for non-workflow fixes |
| **Codex via `$review-gates`** | Same as trivial path, for Codex sessions |

Two distinct flow paths:

```
implement (trivial fix) → review-gates self-check → done
implement (full workflow) → /build → /qa (loads security/performance-review-gates as context) → ship
```

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **Self-check (trivial)** | `review-gates` skill (inline) | Lightweight checklist for non-workflow work |
| **Pipeline context** | `security-review-gates`, `performance-review-gates` | Project-specific context loaded by `/qa` Validators C and D |
| **Plan input** | `review-gates` | Quality standards reference for `/plan` task decomposition |
| **Peer review** | Global agents (`security-reviewer`, etc.) | Independent deep analysis with dedicated tools; invoked by `/qa` or standalone |

**Rules for review gate skills:**
- Keep them **thin** — a checklist, not a deep analysis
- Focus on **project-specific patterns** from `analysis.yaml` — generic checks ("run tests, check lint") already live in CLAUDE.md Behavioral Rules and don't belong here
- They must **explicitly defer** to agents for depth: _"For deep analysis, invoke the `[agent-name]` agent"_
- They must NOT try to replicate agent-level analysis

---

# Step 7: Generate Skills (Behavioral Guidance for Classes of Work)

```bash
if [ ! -f ".claude/discovery/deduplication-report.txt" ]; then
    echo "❌ ERROR: .claude/discovery/deduplication-report.txt not found."
    echo "   Re-run Step 6 to generate the deduplication report before generating any skills."
    exit 1
fi
```

Recall skill-developer frameworks from Step 1 (Four Failure Modes, Degrees of Freedom, description template). If skill-developer output is no longer in context (e.g., very long session), reload it now: `cat ~/.claude/skills/skill-developer/SKILL.md 2>/dev/null`

**What makes something a skill:** A skill shapes how the agent approaches a class of work — like `frontend-design` shapes UI aesthetics, or `dbt-core-patterns` shapes how you write dbt models. Skills are NOT limited to step-by-step procedures. Principles, guidelines, domain mindset, and aesthetic direction all count.

**What does NOT belong in a skill:**
- Factual reference that doesn't shape behavior (architecture diagrams, entity counts) → **Memory**
- Critical rules that must never be missed → **CLAUDE.md/AGENTS.md** (duplicate the concise rule there; full context stays in the skill)
- Content that duplicates a global skill → **DUPLICATE** (see deduplication report from Step 6)

**Quality Gate:** Verify each skill shapes agent behavior for a specific class of work, not just documents what exists.
**Guardrail Gate:** For each skill, extract critical "must never miss" rules and add them to the `<!-- SKILL-DERIVED: Skill Guardrails -->` block in CLAUDE.md/AGENTS.md. If the block does not yet exist, create it directly after the `<!-- AUTO-GENERATED: Critical Guardrails -->` closing tag (`<!-- END AUTO-GENERATED -->`). Each entry: one concise line with the rule. Add a `# [skill-name]:` comment prefix so the source is traceable.

Example:
```
<!-- SKILL-DERIVED: Skill Guardrails -->
# review-gates: Run standard test/lint commands before declaring any fix complete
# api-patterns: Always use /api/v1/{resource} pattern — never hardcode table names
<!-- END SKILL-DERIVED -->
```

**AGENTS.md parity:** After writing guardrail lines to CLAUDE.md, apply the same lines to AGENTS.md:
1. If AGENTS.md does not have a `<!-- SKILL-DERIVED: Skill Guardrails -->` block, create one in the same relative position as in CLAUDE.md (after the `<!-- END AUTO-GENERATED -->` tag for Critical Guardrails).
2. Copy the exact same guardrail lines — no CLAUDE.md→AGENTS.md substitution needed (guardrail lines reference skill names, not config file names).
3. Verify: the SKILL-DERIVED blocks in both files should be identical.

**Deduplication Gate:** Before generating each skill, check the deduplication report from Step 6. Skip DUPLICATE skills covered by globals, scope COMPLEMENT skills to project-specific patterns only.

## Procedure for Each Skill

**Sub-step 0 — Evaluation suite (required before any file creation):**
Before calling init_skill.py, define the trigger/non-trigger suite per Step 4:
- 2–3 prompts that SHOULD trigger this skill
- 1–2 prompts that SHOULD NOT trigger it
Do not proceed to sub-step 1 until the suite is defined. The suite will be inserted in sub-step 1b, immediately after the file is created.

1. **Create the skill skeleton (Claude Code path):**
   ```bash
   python3 ~/.claude/skills/skill-developer/scripts/init_skill.py [skill-name] --path .claude/skills
   ```
   *(This creates the directory structure and template SKILL.md)*

**Sub-step 1b — Insert evaluation suite (immediately after file creation):**
Add the trigger/non-trigger suite defined in sub-step 0 as an HTML comment block in `.claude/skills/[skill-name]/SKILL.md`, immediately after the closing `---` of the YAML frontmatter, before the first `#` heading:
```markdown
<!-- EVALUATION SUITE
TRIGGERS:
- "[prompt 1 that SHOULD trigger]"
- "[prompt 2 that SHOULD trigger]"
NON-TRIGGERS:
- "[prompt that SHOULD NOT trigger]"
-->
```

2. **Populate Content:**
   Overwrite the generated `.claude/skills/[skill-name]/SKILL.md` with the specific content derived from analysis.

3. **Ensure Description Quality (all skills):**
   Skills activate purely through description-based matching — the `description` field in SKILL.md frontmatter is the only activation mechanism. A well-written description is critical.

   **For all skills, verify the description:**
   - Follows the WHAT + WHEN + "Do not use for" template
   - Contains 5+ real trigger keywords that users would naturally type
   - Uses "Use when..." phrasing to specify activation context
   - Sets clear boundaries with "Do not use for..." to prevent false activations

   **For critical skills** (review-gates, security-review-gates, performance-review-gates): pay extra attention to keyword coverage. If trigger/non-trigger evaluations (Step 4) show the skill is not activating reliably, expand the description with additional domain-specific keywords rather than shortening it.

4. **Delete Artifacts:**
   Remove any temporary files (e.g., `README.md`) from the new skill directory.

5. **Mirror for Codex:**
   Create the skill under `.agents/skills/` with equivalent behavior (and any needed `references/`, `assets/`, `scripts/` subfolders).

   ```bash
   rm -rf .agents/skills/[skill-name]
   cp -R .claude/skills/[skill-name] .agents/skills/[skill-name]

   # Replace CLAUDE.md references with AGENTS.md in the agents copy
   perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' .agents/skills/[skill-name]/SKILL.md
   # Also substitute in any references/ subdirectory files
   find .agents/skills/[skill-name]/references/ -name "*.md" -exec perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' {} \; 2>/dev/null || true
   # Verify no CLAUDE.md references remain anywhere in the skill
   grep -r "CLAUDE.md" .agents/skills/[skill-name]/ || echo "clean"

   # Optional legacy compatibility mirror (only if your environment relies on .codex/skills/):
   rm -rf .codex/skills/[skill-name]
   cp -R .claude/skills/[skill-name] .codex/skills/[skill-name]
   ```

6. **Validate (required when available):**
   ```bash
   if command -v skills-ref >/dev/null 2>&1; then
     skills-ref validate .claude/skills/[skill-name]
   else
     echo "skills-ref not installed; skipping spec validation"
   fi
   ```
   Validates against the official Agent Skills specification.

**If the initializer script does not exist:** Create skill files manually:
0. **Define trigger/non-trigger evaluation suite** (per Step 4): 2–3 prompts that SHOULD trigger this skill and 1–2 that SHOULD NOT. Do not create any skill files until this suite is defined.
1. `mkdir -p .claude/skills/[skill-name]` and create `.claude/skills/[skill-name]/SKILL.md` using the templates below
1b. Immediately insert the evaluation suite as an HTML comment (`<!-- EVALUATION SUITE ... -->`) after the closing `---` of the YAML frontmatter, before the first `#` heading
2. Create subdirectories as needed: `references/`, `assets/`, `scripts/`
3. For all skills, verify the description follows WHAT + WHEN + "Do not use for" with 5+ trigger keywords (see Step 7 sub-step 3 above)
4. Mirror for Codex: `cp -R .claude/skills/[skill-name] .agents/skills/[skill-name]`
5. Apply substitution: `perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' .agents/skills/[skill-name]/SKILL.md && grep -r "CLAUDE.md" .agents/skills/[skill-name]/ || echo "clean"`
6. Validate if available: `skills-ref validate .claude/skills/[skill-name] 2>/dev/null || true`

---

# Quality Standards for Skills (FALLBACK — use skill-developer if available)

> **When to use this section:** Only if skill-developer was not found in Step 1. If it loaded successfully, all quality standards are already in context — skip this section entirely and proceed to Required Skills Content below.

If skill-developer is unavailable, apply these minimum standards per skill:
- **Skill Test:** Does this content shape how the agent approaches a class of work? If not, it belongs in CLAUDE.md or memory, not a skill.
- **Description:** Third person, under 1024 chars, WHAT + WHEN + "Do not use for", 5+ trigger keywords, "Use when..." pattern. Template: `[Capability]. Use when [trigger]. Do not use for [out-of-scope].`
- **Four Failure Modes to avoid:** Encyclopedia (>500 lines → split into `references/`), Everything Bagel (applies to every task → move to CLAUDE.md), Secret Handshake (vague description → rewrite with real user keywords), Fragile Skill (hard-coded paths/versions → generalize)
- **Freedom level:** High (guidelines) for reviews/architecture, Medium (pseudocode) for common patterns, Low (exact scripts) for fragile/consistency-critical operations
- **Content patterns:** Checklists for review gates, I/O examples for pattern skills, step-by-step for workflows
- **Anti-hallucination:** Every claim traces to `analysis.yaml`. Missing data = "TBD", not invention. Include `file:line` for code examples, commit hashes for failure modes.
- **Invocation control:** Side-effect skills → `disable-model-invocation: true`. Background knowledge → `user-invocable: false`.
- **Troubleshooting:** Skill not activating → check description (WHAT+WHEN, 5+ keywords). Activates too often → tighten description, add "does NOT handle...". Context budget exceeded → consolidate overlapping skills.

---

## Required Skills Content

Based on analysis.yaml, generate content for these core skills (to overwrite the templates):

### 7a: review-gates (Portable Review Checklist)

**Generation instructions:** Populate Step 1 and Step 2 from `analysis.yaml`:
- Step 1 content: pull from `critical_patterns[].patterns[]` where `pattern_type == "review-gate"` AND `review_gate_variant == "general"`. For each: add as a project-specific check item. Fallback if none found: `"TBD — populate after first incident"`.
- Step 2 content: pull from `historical_failures[]` where `review_gate_variant == "general"` OR (`recommended_skill` is `"review-gates"` AND root_cause/prevention does NOT mention auth/security/performance). For each: add as a prevention reminder. Fallback: omit section if none found.
- **Do NOT add generic checks** ("run tests", "check lint") — those already live in CLAUDE.md Behavioral Rules. Only add what's project-specific.
- **Verification checklist addition:** "Contains at least one project-specific pattern (not just 'run tests, check lint')"

Create **behaviorally equivalent** files:
- `.claude/skills/review-gates/SKILL.md`
- `.agents/skills/review-gates/SKILL.md`

```markdown
---
name: review-gates
description: >
  Project-specific quality review checklist encoding codebase patterns, historical pitfalls, and domain rules
  that generic tools miss. Provides context for /plan task decomposition and serves as a lightweight self-check
  for trivial fixes before committing.
  Use when finishing non-workflow code changes, before committing trivial fixes,
  or when /plan needs quality standards for task decomposition.
  Do not use for deep security or performance analysis — defer to the security-reviewer or performance-analyzer agents.
# Consider adding for read-only enforcement:
# allowed-tools:
#   - Read
#   - Grep
#   - Glob
#   - Bash
# Note: review-gates are auto-invocable (no special frontmatter needed).
# For deploy/release skills, add: disable-model-invocation: true
# For background knowledge skills: user-invocable: false
---

# Review Gates

> Load this skill after implementing trivial fixes before committing, or when /plan needs quality standards.

## Philosophy

Review gates serve three roles: (1) **context for `/plan`** — Step 1 loads this skill to understand quality standards for task decomposition; (2) **self-check for trivial fixes** — a first pass the coding agent runs before committing non-workflow work; (3) **Codex session self-check** via `$review-gates`.

What does NOT belong here: generic checks that CLAUDE.md Behavioral Rules already cover (running tests, checking lint). This skill encodes **project-specific** patterns, historical pitfalls, and domain rules.

For full workflow work (`/brief` → `/design` → `/review` → `/plan` → `/build` → `/qa`): security and performance review-gate skills are loaded automatically by `/qa` Validators C and D — this skill is not the primary quality gate in that path.

**Layered review:** implement (trivial) → self-check (this skill) → agent peer review (if available)

## Implementation Guide

### Step 1: Project-specific quality patterns
[Populate from `analysis.yaml → critical_patterns[].patterns[]` where `pattern_type == "review-gate"` AND `review_gate_variant == "general"`. List each as a concrete check item with file:line canonical example. If none found: "TBD — populate after first incident."]

### Step 2: Historical failure prevention
[Populate from `analysis.yaml → historical_failures[]` where `review_gate_variant == "general"`. For each: one-line reminder referencing commit hash. If none found: omit this section.]

### Step 3: Run the project's standard checks
- Run the project's standard build, test, and lint commands. If you don't know what they are, check CLAUDE.md (look for a Commands or similar section) or ask the user.
- If no commands are documented anywhere: report "TBD" and ask for the project's standard commands.

**Feedback loop:** If any check fails → fix the issue → re-run the check → repeat until passing. Do not skip failed checks.

### Step 4: Flag for deeper review (if applicable)
- If changes touch security-sensitive areas ([GENERAL_SECURITY_FLAGS from Step 3b]): note for `/qa` Validator C or `security-reviewer` agent.
- If changes touch performance-sensitive areas ([GENERAL_PERF_FLAGS from Step 3b]): note for `/qa` Validator D or `performance-analyzer` agent.
- Do NOT attempt deep analysis here — that's the agent's job.

## Common Pitfalls

### Pitfall: Declaring done without running tests
- **What goes wrong:** regressions ship unnoticed
- **How to avoid:** always run the standard test command(s) before completion

## Verification

Before declaring complete:
- [ ] Contains at least one project-specific pattern (not just "run tests, check lint")
- [ ] Build passes (if applicable)
- [ ] Tests pass (unit/integration as applicable)
- [ ] Lint/format passes (if applicable)
- [ ] Changes match documented patterns/skills
- [ ] No new obvious security/perf regressions introduced (per domain parameters from Step 3b)
- [ ] Flagged for agent review if changes touch security/performance areas (per Step 3b flagging keywords)

## References

- `CLAUDE.md` "Commands" section
- Global agents: `code-review-specialist`, `security-reviewer`, `performance-analyzer` (for deep review)
- `/qa` skill — post-build validation pipeline (loads security/performance-review-gates as project context)
```

### 7b: security-review-gates (Security Variant)

Create using the same structure as review-gates (Step 7a). Differences:

- **Frontmatter `name`:** `security-review-gates`
- **Frontmatter `description`:** `Project-specific security review checklist encoding auth patterns, historical security failures, and domain security rules. Serves as context for /qa Validator C (security review) and as a lightweight self-check for trivial security-touching fixes. Use when changes touch [SECURITY_DESCRIPTION_KEYWORDS from Step 3b — union of all matched domain rows]. Do not use for general code review, performance analysis, or comprehensive security audits.`
- **Tagline:** `> Project-specific security checklist. Loaded by /qa Validator C; also a self-check for trivial security-touching fixes. For deep security analysis, invoke the security-reviewer global agent.`
- **Philosophy:** Primary role: project-specific context loaded by `/qa` Validator C during post-build validation. Secondary role: first-pass self-check for trivial fixes before the `security-reviewer` agent — a linter, not an audit.
- **Layered review line:** `implement → security self-check (this skill) OR /qa Validator C (loads this skill) → security-reviewer agent (deep analysis)`

**Data source filters (override review-gates defaults):**
- Step 1 content: pull from `critical_patterns[].patterns[]` where `review_gate_variant == "security"` OR `category` matches "Auth", "Security", "Secrets", "Input Validation", "Permissions", "PII", "Warehouse Access", "Pipeline Security", "Data Leakage", "Prompt Injection". Fallback: `"TBD — populate after first security incident"`.
- Step 2 content: pull from `historical_failures[]` where `review_gate_variant == "security"` OR root_cause/prevention mentions authentication, authorization, secrets, injection, PII exposure, credential leakage, or prompt injection. Fallback: [SECURITY_FALLBACK_BASELINE from Step 3b] (marked "baseline — not project-specific").
- **Do NOT add generic checks** that aren't project-specific — baseline checks from the Step 3b fallback should be marked as such.

**Implementation Guide differences (replace review-gates `### Step 3` and `### Step 4` — use the same heading format):**
- **Step 3:** [SECURITY_IMPL_STEPS from Step 3b — first sentence per matched domain: boundary/access check]
- **Step 4:** [SECURITY_IMPL_STEPS from Step 3b — second sentence per matched domain: input/output check]; flag for `security-reviewer` agent or `/qa` Validator C if changes affect the security surface

- **Common Pitfall:** [From analysis.yaml — project-specific pattern] → [domain-appropriate consequence — e.g., "unintended data access" for software, "PII exposure" for data domains, "prompt injection" for ai-llm] → follow the canonical security pattern for the detected domain(s)
- **Verification checklist:** Contains at least one project-specific security pattern (not just baseline from Step 3b fallback); domain-appropriate security checks enforced (per Step 3b resolved parameters); no secrets in repo/logs; tests pass; flagged for `security-reviewer` agent or `/qa` Validator C if security-sensitive
- **References:** `CLAUDE.md` "Known Pitfalls" (if present); global `security-reviewer` agent; `/qa` skill (Validator C)

### 7c: performance-review-gates (Performance Variant)

Create using the same structure as review-gates (Step 7a). Differences:

- **Frontmatter `name`:** `performance-review-gates`
- **Frontmatter `description`:** `Project-specific performance review checklist encoding data access patterns, historical performance failures, and domain performance rules. Serves as context for /qa Validator D (performance review) and as a lightweight self-check for trivial performance-touching fixes. Use when changes touch [PERF_DESCRIPTION_KEYWORDS from Step 3b — union of all matched domain rows]. Do not use for security review or general code quality checks.`
- **Tagline:** `> Project-specific performance checklist. Loaded by /qa Validator D; also a self-check for trivial performance-touching fixes. For deep performance analysis, invoke the performance-analyzer global agent.`
- **Philosophy:** Primary role: project-specific context loaded by `/qa` Validator D during post-build validation. Secondary role: first-pass self-check for trivial fixes before the `performance-analyzer` agent — a sanity check, not a benchmark.
- **Layered review line:** `implement → performance self-check (this skill) OR /qa Validator D (loads this skill) → performance-analyzer agent (deep analysis)`

**Data source filters (override review-gates defaults):**
- Step 1 content: pull from `critical_patterns[].patterns[]` where `review_gate_variant == "performance"` OR `category` matches "Database", "Performance", "Caching", "Query", "Data Access", "Materialization", "Incremental", "Partition", "DAG", "Memory", "Token Cost", "Agent Loop", "Context Window". Fallback: `"TBD — populate after first performance incident"`.
- Step 2 content: pull from `historical_failures[]` where `review_gate_variant == "performance"` OR root_cause/prevention mentions N+1, pagination, unbounded, caching, query performance, full table scan, materialization, partition pruning, memory exhaustion, or token cost. Fallback: [PERF_FALLBACK_BASELINE from Step 3b] (marked "baseline — not project-specific").
- **Do NOT add generic checks** that aren't project-specific — baseline performance checks should be marked as such.

**Implementation Guide differences (replace review-gates `### Step 3` and `### Step 4` — use the same heading format):**
- **Step 3:** [PERF_IMPL_STEPS from Step 3b — first sentence per matched domain: data access / resource check]
- **Step 4:** [PERF_IMPL_STEPS from Step 3b — second sentence per matched domain: complexity / limits check]; flag for `performance-analyzer` agent or `/qa` Validator D if changes touch performance-sensitive paths

- **Common Pitfall:** [From analysis.yaml — project-specific pattern] → [domain-appropriate consequence — e.g., "latency spikes" for software, "full table scans" for data-analytics, "token budget exhaustion" for ai-llm] → follow the canonical performance pattern for the detected domain(s)
- **Verification checklist:** Contains at least one project-specific performance pattern (not just baseline from Step 3b fallback); domain-appropriate performance checks enforced (per Step 3b resolved parameters); tests pass; flagged for `performance-analyzer` agent or `/qa` Validator D if performance-sensitive
- **References:** Relevant `[pattern]-patterns` skills; global `performance-analyzer` agent; `/qa` skill (Validator D)

---

### 7d: code-conventions

**Note:** The concise naming rules should already be in CLAUDE.md/AGENTS.md `Code Conventions` section. This skill provides the full behavioral guidance with examples for when the agent is actively writing code.

**Data source:** Pull content from these `analysis.yaml` fields:
- `code_conventions.naming.files` → Naming Conventions / Files section
- `code_conventions.naming.functions`, `.variables`, `.classes` → Naming Conventions / Code section
- `code_conventions.imports` → Import ordering examples
- `code_conventions.exports` → Export style examples
- `code_conventions.error_handling` → Error Handling section
- `code_conventions.file_structure` → File Structure section

For each section, supplement `analysis.yaml` findings with a direct codebase grep to find 2–3 concrete examples:
```bash
grep -r "export\|import\|throw\|catch" src/ --include="*.ts" --include="*.py" | head -10
```

If a field is absent from `analysis.yaml`, sample 3 real files from the codebase directly and derive the convention. Write "TBD — derive from codebase" if no consistent pattern found.

Create `.claude/skills/code-conventions/SKILL.md` **and** `.agents/skills/code-conventions/SKILL.md`:

```markdown
---
name: code-conventions
description: >
  Project-specific code style conventions including naming patterns, import ordering, file structure,
  export style, error handling, and formatting standards. Use when writing new code, reviewing style compliance,
  creating new files, refactoring existing code, or ensuring consistency with project patterns.
  Do not use for architecture decisions, review gates, or implementation guides for specific patterns.
---

# Code Conventions

> Load this skill when writing new code or reviewing style. For quick reference, see CLAUDE.md/AGENTS.md Code Conventions section.

## Why These Conventions

[Brief rationale — consistency target, tooling alignment, etc.]

## Naming Conventions

#### Files
- [Pattern from analysis.yaml with examples]

#### Code
- [Pattern from analysis.yaml with examples]

**Examples:**
```[language]
// ✅ CORRECT
[Good example from codebase]

// ❌ INCORRECT
[Anti-pattern]
```

### File Structure

[Standard file layout with examples]

### Error Handling

[Pattern from analysis.yaml with examples]

### Input/Output Example

**Input (non-compliant):**
```[language]
// User writes this
[bad example placeholder]
```

**Expected Output (compliant):**
```[language]
// Skill guides agent to produce this
[good example placeholder]
```

## Common Pitfalls

### Pitfall 1: [Name]
[Style-related pitfall from analysis.yaml if any]

## Verification

- [ ] Naming follows conventions above
- [ ] File structure matches standard layout
- [ ] Error handling follows pattern

## References

For extended examples beyond what fits in this SKILL.md:
- [references/naming-examples.md](references/naming-examples.md) - Full naming convention examples
- [references/style-details.md](references/style-details.md) - Extended style rules and edge cases

*Create references/ files if SKILL.md approaches 200+ lines.*
```

---

# Stage 3 (Core Skills) Complete

**Generated:** review-gates (+ security/performance variants), code-conventions
**Verified:** Descriptions pass checklist · Trigger suites defined · Four Failure Modes check passed · Codex mirrors in sync · Critical guardrails extracted · No global duplication

**Next:** Run Stage 4 (Domain Skills) to generate pattern-specific and domain skills.
