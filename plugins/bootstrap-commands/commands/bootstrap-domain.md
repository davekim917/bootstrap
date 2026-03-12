---
name: bootstrap-domain
description: "Stage 4: Generate additional domain-specific skills beyond core skills."
---

# Stage 4: Domain Skills Generation

> **Note:** This file is a direct continuation of Stage 3, split for context-length management. Stage 3 generates core skills (review-gates, code-conventions). Stage 4 generates domain and pattern skills (codebase-overview, [pattern]-patterns, [failure-type]-prevention). Together they constitute the full skill generation phase. When running as part of the bootstrap pipeline, always run Stage 3 before Stage 4.

Generate domain-specific and pattern skills based on `analysis.yaml` recommendations.

**Prerequisites:** Stage 3 (Core Skills) complete — review-gates, security-review-gates, performance-review-gates, and code-conventions skills exist.

**Execution mode:** Prioritize execution over deliberation. Choose one approach and start
producing output immediately. Do not compare alternatives or plan the entire generation
before writing. Write each file once; do not go back to revise or rewrite. If uncertain
about a specific field value, write "TBD" and continue. Only course-correct if you
encounter a concrete failure.

Phase 4 verification failures (description quality, Four Failure Modes, mirror correctness) constitute concrete failures and warrant correction — revise only for these, not speculatively.

---

# Step 1: Continuity Check

Before proceeding, restore context from Stage 3. This section is critical if Stage 4 runs in a separate session from Stage 3.

**Guard:** If `analysis.yaml` is missing or lacks a `recommendations` section, stop and report. Do not generate domain skills from assumptions.

```bash
# Verify Stage 3 completed successfully — core skills must exist before generating domain skills
echo "=== Stage 3 Output Check ==="
ls .claude/skills/ 2>/dev/null || echo "⚠️  No skills directory found"
for required in review-gates security-review-gates performance-review-gates code-conventions; do
    [ -f ".claude/skills/${required}/SKILL.md" ] && echo "✅ ${required}" || echo "❌ MISSING: ${required} — run Stage 3 before proceeding"
done

# Reload analysis data (required — domain skill generation reads analysis.yaml directly)
cat .claude/discovery/analysis.yaml

# Reload skill-developer quality framework
cat ~/.claude/skills/skill-developer/SKILL.md 2>/dev/null || echo "skill-developer not installed — use Quality Standards Recap as fallback"

# Restore deduplication decisions from Stage 3
cat .claude/discovery/deduplication-report.txt 2>/dev/null || echo "(no deduplication report found — see recovery path below)"
```

```bash
# Freshness check: warn if deduplication-report.txt is older than analysis.yaml
if [ -f ".claude/discovery/deduplication-report.txt" ] && [ -f ".claude/discovery/analysis.yaml" ]; then
    if [ ".claude/discovery/deduplication-report.txt" -ot ".claude/discovery/analysis.yaml" ]; then
        echo "⚠️  deduplication-report.txt predates analysis.yaml — classifications may be stale."
        echo "   If analysis.yaml was regenerated since Stage 3 ran, re-run Stage 3 Step 6"
        echo "   to refresh classifications before proceeding."
    else
        echo "✅ deduplication-report.txt is current (newer than analysis.yaml)"
    fi
fi
```

**Recovery path if deduplication-report.txt is absent:** Do NOT re-run all of Stage 3 Step 6. Instead, for each skill you are about to generate in Stage 4, run the live check from Stage 3 Step 6a to inventory globals, then apply the deduplication rules from Stage 3 Step 6b to classify the skill. Create `deduplication-report.txt` with the result before the deduplication check in Step 3b. Create with `echo '=== Deduplication Report ===' > .claude/discovery/deduplication-report.txt` for the first skill; use `>>` to append for each subsequent skill.

```
# Format for each entry (must start at line start with keyword, colon, space, skill-name):
CLEAN: [skill-name] — no global overlap
DUPLICATE: [skill-name] — covered by global skill: [name]
COMPLEMENT: [skill-name] — partially overlaps global: [name], scoping to project-specific patterns
LAYERED: [skill-name] — thin checklist, complements global [agent-name] agent
```

```bash
# Check existing Critical Guardrails to avoid duplicating them
grep -A 30 "## Critical Guardrails" CLAUDE.md | head -35
```

---

# Quality Standards (Self-Contained)

Apply these quality standards to every domain skill generated here.

- **The Skill Test:** Does this content shape how the agent approaches a class of work? If not, it belongs in memory or CLAUDE.md.
- **Description:** WHAT + WHEN + out-of-scope boundary, 5+ trigger keywords, third person, under 1024 chars, uses user terms (not just technical jargon).
- **Evaluations first:** Define trigger/non-trigger suite before writing each skill (Stage 3 Step 4).
- **Guardrail extraction:** After each skill, extract critical rules to CLAUDE.md/AGENTS.md `Critical Guardrails`.
- **Anti-hallucination:** Every claim traces to `analysis.yaml`. Missing data = "TBD" or skip section. Include `file:line` citations for code examples; include commit hashes for failure modes.

## Four Failure Modes

| Failure Mode | Symptom | Prevention |
|---|---|---|
| Encyclopedia | SKILL.md > 500 lines or reads like a wiki | Split into references/ files |
| Everything Bagel | Would apply to every task | Move to CLAUDE.md instead |
| Secret Handshake | Description is vague, skill never triggers | Rewrite description with 5+ trigger keywords |
| Fragile Skill | Hard-codes paths/versions that will change | Generalize with patterns, not literals |

Also test for runtime failures before each skill:
- **Trigger Miss:** Define 2-3 trigger prompts — skill should fire for all of them
- **False Trigger:** Define 1-2 non-trigger prompts — skill should NOT fire
- **Bad Output:** Review generated guidance against actual project patterns
- **Stale Content:** Cross-check all claims against analysis.yaml

## Deduplication Decision

Before generating each skill, check against the deduplication report from Stage 3 (DUPLICATE / SUBSET / COMPLEMENT / LAYERED / CLEAN classifications). If `deduplication-report.txt` is missing, re-run the live check from Stage 3 Step 6a:
```bash
cat .claude/discovery/deduplication-report.txt 2>/dev/null || {
  echo "(deduplication-report.txt missing — running live global skills check)"
  for skill_dir in ~/.claude/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
      skill_name=$(basename "$skill_dir")
      desc=$(sed -n '/^description:/{s/^description: *[>|]//;s/^description: *//;p;:loop;n;/^[a-z]/q;/^---/q;s/^  *//;p;b loop}' "${skill_dir}SKILL.md" | tr '\n' ' ' | sed 's/  */ /g;s/^ *//;s/ *$//')
      echo "- ${skill_name}: ${desc}"
    fi
  done
}
```
When the fallback runs, use the descriptions to assess coverage overlap for deduplication decisions. Read `~/.claude/skills/{name}/SKILL.md` for any skill where the description alone is insufficient to judge overlap.

- If a global skill covers >80% of the same patterns → do NOT generate
- If a global skill covers 50-80% → generate only the delta (project-specific parts)
- If a global skill covers <50% → generate a full project-specific skill

## Skill Quality Checklist

- [ ] Description clearly states WHEN the skill triggers
- [ ] Description states what the skill DOES (not just what it covers)
- [ ] Includes at least one concrete example from the project
- [ ] References specific files/patterns from analysis.yaml
- [ ] Does not duplicate an existing global or project skill

---

# Step 2: codebase-overview (OPTIONAL — Architecture + Tech Stack)

**Evaluate first:** `codebase-overview` is primarily reference material (directory structure, tech stack facts). It describes what exists rather than shaping behavior. Consider whether this content is better served by:
- **CLAUDE.md/AGENTS.md** — the brief architecture summary is already there (Directory Structure, Tech Stack sections)
- **Memory** (`.claude/memory/` or similar) — for extended architecture details that don't change behavior

**Only create this skill if** the project has 3+ architectural layers, a monorepo with multiple apps, microservices, or the agent frequently needs layer-boundary guidance. For simpler projects, the CLAUDE.md overview + memory is sufficient.

**If creating, content for** `.claude/skills/codebase-overview/SKILL.md` **and** `.agents/skills/codebase-overview/SKILL.md`:

```markdown
---
name: codebase-overview
description: >
  Architecture navigation guide for understanding layer boundaries, dependency direction, and code placement decisions.
  Use when deciding where new code belongs, understanding service boundaries, resolving import direction questions,
  or onboarding to the codebase. Load for architectural decision-making.
  Do not use for implementation style guidance (see code-conventions skill) or review gates.
---

# Codebase Overview

> Load this skill when you need to decide where new code belongs or how layers interact.

## Architecture Principles

**Why this architecture:** [2-3 sentences on architectural choices]

**Key principles that shape decisions:**
- [Principle 1 — e.g., "Staging models never contain business logic"]
- [Principle 2 — e.g., "Backend functions own workflow state, dbt models own analytics"]

## Layer Boundaries (Decision Guide)

When adding new code, use this to decide where it goes:

| If you're building... | It goes in... | Because... |
|---|---|---|
| [e.g., "Data cleaning/dedup"] | [e.g., "staging/"] | [e.g., "Staging owns source transformation"] |
| [e.g., "Business logic"] | [e.g., "marts/"] | [e.g., "Marts own analytics-ready output"] |
| [e.g., "Workflow automation"] | [e.g., "backend_functions/"] | [e.g., "SPs own state changes"] |

## Common Pitfalls

### Pitfall 1: [Name]
[Architecture-level pitfall — e.g., "putting business logic in staging models"]

## Verification

- [ ] New code follows layer boundaries above
- [ ] Dependencies point in correct direction
- [ ] No circular dependencies introduced

## References

For extended architecture details beyond what fits in this SKILL.md:
- [references/layer-details.md](references/layer-details.md) - Detailed layer descriptions and boundaries
- [references/dependency-map.md](references/dependency-map.md) - Full dependency direction rules

*Create references/ files if SKILL.md approaches 200+ lines.*
```

After creating the `.agents/skills/codebase-overview/` files, apply the substitution:

<!-- Mirror per Stage 3 Step 7 Procedure (step 5) — same command for every skill -->
```bash
# Replace CLAUDE.md references with AGENTS.md in the agents copy
perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' .agents/skills/codebase-overview/SKILL.md
find .agents/skills/codebase-overview/references/ -name "*.md" -exec perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' {} \; 2>/dev/null || true
grep -r "CLAUDE.md" .agents/skills/codebase-overview/ || echo "clean"
```

---

# Step 3: Domain and Pattern Skills (Iterate over all recommended skills)

> **Note:** `code-conventions` (Stage 3 Step 7d) is generated in Stage 3. This stage continues at Step 2 (optional) and Step 3+.

## Step 3a: Extract the skill list

```bash
echo "=== Skills to generate in Stage 4 ==="
PATTERN_SKILLS=$(yq '.recommendations.skills.pattern_skills[]' .claude/discovery/analysis.yaml 2>/dev/null) || \
PATTERN_SKILLS=$(python3 -c "import yaml; d=yaml.safe_load(open('.claude/discovery/analysis.yaml')); print('\n'.join(d.get('recommendations',{}).get('skills',{}).get('pattern_skills',[])))" 2>/dev/null)

DOMAIN_SKILLS=$(yq '.recommendations.skills.domain_skills[]' .claude/discovery/analysis.yaml 2>/dev/null) || \
DOMAIN_SKILLS=$(python3 -c "import yaml; d=yaml.safe_load(open('.claude/discovery/analysis.yaml')); print('\n'.join(d.get('recommendations',{}).get('skills',{}).get('domain_skills',[])))" 2>/dev/null)

echo "Pattern skills: ${PATTERN_SKILLS:-<none>}"
echo "Domain skills: ${DOMAIN_SKILLS:-<none>}"
```

**Edge case handling:**
- `pattern_skills` key missing → fall back to `critical_patterns[].recommended_skill` values; log `FALLBACK`
- `domain_skills` key missing → continue with pattern_skills only; log the gap
- Both empty → log `STAGE-4-SKIP`, proceed directly to Step 4

## Step 3b: Per-skill iteration

For each skill in pattern_skills, then each in domain_skills:

**Phase 1 — Deduplication:**
```bash
grep "^DUPLICATE: [skill-name]\|^SUBSET: [skill-name]" .claude/discovery/deduplication-report.txt 2>/dev/null
```
- DUPLICATE or SUBSET → log `SKIPPED: [skill]`, advance to next skill
- COMPLEMENT → generate delta only; note global skill in description
- LAYERED → generate thin checklist only; defer to named agent explicitly
- CLEAN or absent from report → run live check, append result to deduplication-report.txt, generate fully

**Stage 3-owned skills guard:** Before proceeding to Phase 2, check if this skill is one that Stage 3 generates (not Stage 4). Skip it if so — do not regenerate.

```bash
STAGE_3_SKILLS=("review-gates" "security-review-gates" "performance-review-gates" "code-conventions")
for owned in "${STAGE_3_SKILLS[@]}"; do
    if [ "$skill_name" = "$owned" ]; then
        echo "SKIPPED: $skill_name — owned by Stage 3 (already generated)"
        # advance to next skill
    fi
done
```

If the current skill matches any of the four Stage 3-owned skills, log `SKIPPED` and advance to the next skill. Do not regenerate them here.

**Phase 2 — Evaluation suite (before writing SKILL.md)**

Define the trigger/non-trigger suite per Stage 3 Step 4:
- 2–3 prompts that SHOULD trigger this skill
- 1–2 prompts that SHOULD NOT trigger it

Write as an HTML comment (`<!-- EVALUATION SUITE ... -->`) immediately after the closing `---` of the YAML frontmatter, before the first `#` heading — as the first action after the file is created in Phase 3, before populating content.

**Phase 3 — Generate skill**

Select the template based on skill type:
- **Pattern skills** (from `pattern_skills[]`): use the pattern skill template (Step 3b above).
- **Failure prevention skills** (from analysis.yaml failure modes, Step 4): use the failure prevention template.
- **Domain skills** (from `domain_skills[]`): select template per the Domain Skill Template Selection table below Step 4.

Populate from analysis.yaml evidence. Every code example must have a `file:line` citation. Mirror to `.agents/skills/`. Extract critical guardrails to `<!-- SKILL-DERIVED: Skill Guardrails -->` block in CLAUDE.md/AGENTS.md.

**Phase 4 — Verify and advance**

Before advancing to the next skill, verify:
- [ ] Description passes WHAT + WHEN + "Do not use for" + 5+ keywords
- [ ] Four Failure Modes check: not Encyclopedia, Everything Bagel, Secret Handshake, or Fragile
- [ ] Codex mirror exists and CLAUDE.md→AGENTS.md substitution is clean
- [ ] Trigger/non-trigger evaluation suite defined and written as a comment block at the top of SKILL.md (Phase 2 requirement)

## Step 3c: Post-iteration summary

After all skills are processed, print:

```
=== Stage 4 Step 3 Summary ===
Generated: [list]
Skipped (DUPLICATE/SUBSET): [list]
Partial (COMPLEMENT): [list]
Thin checklist (LAYERED): [list]
```

---

**Template for pattern skills:**

Create `.claude/skills/[pattern-name]-patterns/SKILL.md` **and** `.agents/skills/[pattern-name]-patterns/SKILL.md`:

```markdown
---
name: [pattern-name]-patterns
description: >
  [Pattern category] implementation guide with canonical examples from this codebase.
  Use when implementing [pattern type] code, creating new [pattern instances],
  reviewing [pattern] compliance, or when working with [file patterns].
  Covers [key topic 1], [key topic 2], and common pitfalls.
  Do not use for general code style (see code-conventions skill) or review gates.
---

# [Pattern Name] Patterns

> Load this skill when implementing [pattern type] code.

## Philosophy

**Why this pattern:** [2-3 sentences on why this pattern exists in this codebase]

**Consistency:** [X]% across [count] files

**Key principles:**
- [Principle 1]
- [Principle 2]

## Implementation Guide

### Step 1: [First Step]

[Detailed instructions]

```[language]
// From: [file]:[line]
[Code example from codebase]
```

### Step 2: [Next Step]

[Detailed instructions]

```[language]
[Code example]
```

### Step 3: [Continue for all steps]

## Common Pitfalls

### Pitfall 1: [Name] (Historical: [commit hash])

**What goes wrong:** [Description]
**Impact:** [What happened]
**How to detect:** [Detection method]
**How to avoid:** [Prevention]

```[language]
// ❌ INCORRECT
[Bad code]

// ✅ CORRECT
[Good code]
```

### Pitfall 2: [Name]

[Repeat structure]

## Verification

Before considering complete:
- [ ] [Check 1 specific to this pattern]
- [ ] [Check 2]
- [ ] [Check 3]
- [ ] Matches examples in this skill
- [ ] No pitfalls from above

## References

- [references/examples.md](references/examples.md) - More complete examples
- [references/edge-cases.md](references/edge-cases.md) - Edge case handling

### Examples from Codebase

#### Example 1: [file]:[line]
**What makes this good:**
- [Feature 1]
- [Feature 2]
```

Create `.claude/skills/[pattern-name]-patterns/references/examples.md` **and** `.agents/skills/[pattern-name]-patterns/references/examples.md` with complete code examples (including full file context) and an anti-patterns gallery showing what NOT to do and why. Mirror both files.

After creating the `.agents/skills/[pattern-name]-patterns/` files, apply the substitution:

<!-- Mirror per Stage 3 Step 7 Procedure (step 5) — same command for every skill -->
```bash
# Replace CLAUDE.md references with AGENTS.md in the agents copy
perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' .agents/skills/[pattern-name]-patterns/SKILL.md
find .agents/skills/[pattern-name]-patterns/references/ -name "*.md" -exec perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' {} \; 2>/dev/null || true
grep -r "CLAUDE.md" .agents/skills/[pattern-name]-patterns/ || echo "clean"
```

---

# Step 4: Failure Mode Skills

For each significant failure mode from analysis.yaml, either:
- Add to relevant pattern skill (preferred), OR
- Create dedicated skill if failure spans multiple patterns

**Adding to pattern skill:**
Include in the "Common Pitfalls" section with commit hash reference.

**Dedicated failure skill (if needed):**

Create `.claude/skills/[failure-type]-prevention/SKILL.md` **and** `.agents/skills/[failure-type]-prevention/SKILL.md`:

```markdown
---
name: [failure-type]-prevention
description: >
  [Failure-type] failure prevention guide covering root cause analysis, detection, and prevention strategies.
  Use when modifying [related-code-areas], reviewing changes to [related-systems],
  implementing new [related-patterns], diagnosing [specific-symptom], or preventing [failure-class].
  Do not use for general code review (see review-gates skill).
---

# [Failure Type] Prevention

> This skill documents historical failures and how to prevent them.

## Philosophy

**Why this matters:** [Impact of this failure type]

## Historical Incidents

### Incident 1: [commit hash] ([date])

**File:** [path]
**What happened:** [Description]
**Impact:** [Impact]
**Root cause:** [Why it happened]

**The problematic code:**
```[language]
[Bad code that caused the issue]
```

**The fix:**
```[language]
[Fixed code]
```

### Incident 2: [commit hash]

[Repeat structure]

## Prevention Strategies

### Strategy 1: [Name]
[How to prevent this class of failure]

### Strategy 2: [Name]
[Additional prevention]

## Detection

**How to spot this issue:**
- [Detection method 1]
- [Detection method 2]

**Automated checks:**
```bash
[Command to detect this issue if applicable]
```

## Verification Checklist

Before completing related changes:
- [ ] [Prevention check 1]
- [ ] [Prevention check 2]
- [ ] No patterns from "problematic code" sections above
```

After creating the `.agents/skills/[failure-type]-prevention/` files, apply the substitution:

<!-- Mirror per Stage 3 Step 7 Procedure (step 5) — same command for every skill -->
```bash
# Replace CLAUDE.md references with AGENTS.md in the agents copy
perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' .agents/skills/[failure-type]-prevention/SKILL.md
find .agents/skills/[failure-type]-prevention/references/ -name "*.md" -exec perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' {} \; 2>/dev/null || true
grep -r "CLAUDE.md" .agents/skills/[failure-type]-prevention/ || echo "clean"
```

## Domain Skill Template Selection

Domain skills from `recommendations.skills.domain_skills[]` do not have a dedicated template. Select based on the skill's primary purpose:

| Domain Skill Purpose | Use Template | Example |
|---------------------|-------------|---------|
| Codifies recurring implementation patterns | Pattern skill template (Step 3b) | `api-patterns`, `state-management` |
| Documents historical failures in a domain area | Failure prevention template (Step 4) | `deployment-prevention`, `migration-prevention` |
| Mixed (patterns + failure prevention) | Pattern skill template with an added "Historical Incidents" section from the failure template | `data-pipeline-patterns` |

When in doubt, use the pattern skill template — it is the more general structure.

---

# Guardrail Extraction Reminder

After generating each skill above, extract any rules that would cause bugs/data loss if missed and add them as one-liners to the CLAUDE.md/AGENTS.md `Critical Guardrails` section. This ensures the safety net works even when skill triggers don't fire.

---

# Stage 4 Complete (Domain Skills)

**Generated across Stage 3 and Stage 4:**

From Stage 3 (verify only — do not regenerate here):
- ✅ Review gate skills (`review-gates`, `security-review-gates`, `performance-review-gates`)
- ✅ Code conventions skill (`code-conventions`)

From Stage 4 (generated here):
- ✅ Codebase overview skill (OPTIONAL — only if complex architecture warrants it)
- ✅ Pattern-specific skills (based on analysis recommendations — behavioral guidance, not just reference)
- ✅ Domain skills (business logic, product domains — only if not covered by global skills)
- ✅ Failure prevention skills (if applicable)
- ✅ Evaluation scenarios created for each skill (Step 4 suite defined before generation)
- ✅ Descriptions pass optimization checklist (WHAT + WHEN + out-of-scope boundary, 5+ keywords, third person, <1024 chars)
- ✅ Trigger and non-trigger suites defined for each skill
- ✅ At least one end-to-end functional workflow test defined per major workflow
- ✅ Degrees of freedom appropriate for each skill (high/medium/low based on task fragility)
- ✅ Four Failure Modes check passed (no Encyclopedia, Everything Bagel, Secret Handshake, or Fragile Skill)
- ✅ Invocation control set where needed (`disable-model-invocation`, `user-invocable`, `context: fork`)
- ✅ Claude Code triggers registered in `.claude/skills/skill-rules.json` for any critical domain skills generated here (review-gate triggers were registered in Stage 3; only new safety-critical domain skills added in Stage 4 need entries here)
- ✅ Skills generated under `.agents/skills/` for Codex (optional `.codex/skills/` mirror only for compatibility)
- ✅ CLAUDE.md references replaced with AGENTS.md in .agents/skills/ copies (substitution applied and verified)
- ✅ Critical guardrails from skills extracted to CLAUDE.md/AGENTS.md
- ✅ No project-level `skill-developer` (uses global)
- ✅ No duplication with global skills

**Verify before proceeding:**
```bash
# All generated skills have valid frontmatter
for skill_dir in .claude/skills/*/; do
  echo "=== $(basename "$skill_dir") ==="
  head -5 "${skill_dir}SKILL.md"
done

# Codex mirrors exist for every Claude skill
diff <(ls .claude/skills/ 2>/dev/null | sort) <(ls .agents/skills/ 2>/dev/null | sort) && echo "✅ Codex mirrors in sync" || echo "⚠️  Parity mismatch — re-run mirror step"
```

**Next:** Run Stage 5 (Audit & Reconciliation) to reconcile existing skills with new analysis.
