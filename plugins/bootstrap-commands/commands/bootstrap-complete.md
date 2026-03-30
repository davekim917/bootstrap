---
name: bootstrap-complete
description: "Stage 6: Final cleanup and validation of bootstrap output."
---

# Stage 6: Validation & Completion

Final validation, completion report, and cleanup.

**Prerequisites:** Stage 5 complete (audit & reconciliation done).

**Default: proceed immediately.** Execute Steps 1–3 sequentially without pausing for confirmation. Run the validation script in Step 1 and report its output. Generate the completion report in Step 2 after validation passes. Run cleanup in Step 3.

---

# Step 1: Final Validation

**Why:** Automated validation catches configuration errors (invalid JSON, missing frontmatter, parity drift) before the user commits. Catching issues here prevents silent failures during actual use. This validation also serves as a secondary safety net for skills generated during Stage 5's return trip to Stage 3.

Run the validation script before generating the completion report:

```bash
{
# Ensure ENG_TEAM_DIR is set; fall back to a common default
ENG_TEAM_DIR="${ENG_TEAM_DIR:-~/claude-eng-team}"
echo "=== Bootstrap Validation ==="
echo ""

# 1. Check CLAUDE.md
echo "1. CLAUDE.md Check:"
if [ -f "CLAUDE.md" ]; then
    TOKENS=$(wc -w < CLAUDE.md)
    echo "   ✅ CLAUDE.md exists (~$TOKENS words)"
    if [ "$TOKENS" -gt 3500 ]; then
        echo "   ⚠️  CLAUDE.md exceeds 3,500 words ($TOKENS words) — prune longest sections first"
    fi

    # Check for @imports (should not exist)
    if grep -q "@import" CLAUDE.md 2>/dev/null; then
        echo "   ❌ CLAUDE.md contains @imports (should not)"
    else
        echo "   ✅ No @imports found"
    fi
else
    echo "   ❌ CLAUDE.md not found"
fi
echo ""

# 2. Check AGENTS.md (Codex)
echo "2. Codex AGENTS.md Check:"
if [ -f "AGENTS.md" ]; then
    TOKENS=$(wc -w < AGENTS.md)
    echo "   ✅ AGENTS.md exists (~$TOKENS words)"
    if [ "$TOKENS" -gt 3500 ]; then
        echo "   ⚠️  AGENTS.md exceeds 3,500 words ($TOKENS words) — prune longest sections first"
    fi
else
    echo "   ❌ AGENTS.md not found (required for Codex dual-tool setup — run Stage 2 to generate it)"
fi
echo ""

# 3. Optional agents (Claude Code only)
echo "3. Optional Agents Check (Claude Code only):"
echo "   Global agents (~/.claude/agents/):"
ls ~/.claude/agents/*.md 2>/dev/null | wc -l | xargs -I{} echo "   {} global agents found"

echo "   Project agents (.claude/agents/):"
ls .claude/agents/*.md 2>/dev/null | wc -l | xargs -I{} echo "   {} project agents found"
echo ""

# 4. Check skills
echo "4. Skills Check (Claude Code + Codex):"
SKILL_COUNT=$(find .claude/skills -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' \; -print 2>/dev/null | wc -l)
echo "   Skills with SKILL.md: $SKILL_COUNT"
if [ "$SKILL_COUNT" -eq 0 ]; then
    echo "   ❌ No skills generated — Stage 3 may not have completed"
elif [ "$SKILL_COUNT" -lt 4 ]; then
    echo "   ⚠️  Only $SKILL_COUNT skills found — expected at least 4 core skills (review-gates, security-review-gates, performance-review-gates, code-conventions)"
fi

echo ""

# 5. Frontmatter Validation
echo "5. Frontmatter Validation:"
FRONTMATTER_ISSUES=0
for skill_dir in .claude/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
        skill_name=$(basename "$skill_dir")

        # Prefer skills-ref for robust frontmatter validation
        if command -v skills-ref >/dev/null 2>&1; then
            if ! skills-ref validate "${skill_dir}" >/dev/null 2>&1; then
                echo "   ❌ $skill_name: skills-ref validation failed"
                FRONTMATTER_ISSUES=$((FRONTMATTER_ISSUES + 1))
                continue
            fi
        fi

        name_val=$(sed -n '/^name:/{ s/^name: *//; p; q; }' "${skill_dir}SKILL.md")
        # Extract description from YAML frontmatter (supports single-line and block styles)
        desc_val=$(awk '
            BEGIN { in_fm=0; capture=0 }
            $0=="---" {
                if (in_fm==0) { in_fm=1; next }
                if (in_fm==1) { exit }
            }
            in_fm==1 {
                if ($0 ~ /^description:[[:space:]]*/) {
                    capture=1
                    sub(/^description:[[:space:]]*/, "", $0)
                    print $0
                    next
                }
                if (capture==1) {
                    if ($0 ~ /^[A-Za-z0-9_-]+:[[:space:]]*/) exit
                    if ($0 ~ /^[[:space:]]+/) {
                        sub(/^[[:space:]]+/, "", $0)
                        print $0
                        next
                    }
                    exit
                }
            }
        ' "${skill_dir}SKILL.md" | tr '\n' ' ')

        if [ -z "$name_val" ]; then
            echo "   ❌ $skill_name: missing 'name' field"
            FRONTMATTER_ISSUES=$((FRONTMATTER_ISSUES + 1))
        elif [ "$name_val" != "$skill_name" ]; then
            echo "   ⚠️  $skill_name: name '$name_val' doesn't match directory"
            FRONTMATTER_ISSUES=$((FRONTMATTER_ISSUES + 1))
        fi

        if [ -z "$desc_val" ]; then
            echo "   ❌ $skill_name: missing 'description' field"
            FRONTMATTER_ISSUES=$((FRONTMATTER_ISSUES + 1))
        elif [ ${#desc_val} -gt 1024 ]; then
            echo "   ⚠️  $skill_name: description exceeds 1024 chars"
            FRONTMATTER_ISSUES=$((FRONTMATTER_ISSUES + 1))
        fi

        # Check for "Use when" pattern in description
        if [ -n "$desc_val" ] && ! echo "$desc_val" | grep -qi "use when\|when "; then
            echo "   ⚠️  $skill_name: description lacks 'Use when' trigger pattern"
        fi

        # Check for explicit out-of-scope boundary
        if [ -n "$desc_val" ] && ! echo "$desc_val" | grep -qi "do not use for"; then
            echo "   ⚠️  $skill_name: description lacks 'Do not use for' boundary"
        fi

        # Third person check
        if echo "$desc_val" | grep -qiE '\bI \b|\byou \b|\byour \b'; then
            echo "   ⚠️  $skill_name: description uses first/second person (should be third person)"
        fi
    fi
done
if [ "$FRONTMATTER_ISSUES" -eq 0 ]; then
    echo "   ✅ All frontmatter valid"
fi

# Progressive disclosure check
echo ""
echo "6. Progressive Disclosure Check:"
OVERSIZED=0
for skill_dir in .claude/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
        skill_name=$(basename "$skill_dir")
        LINE_COUNT=$(wc -l < "${skill_dir}SKILL.md")
        if [ "$LINE_COUNT" -gt 500 ]; then
            echo "   ⚠️  $skill_name: SKILL.md is $LINE_COUNT lines (>500, consider splitting to references/)"
            OVERSIZED=$((OVERSIZED + 1))
        fi
    fi
done
if [ "$OVERSIZED" -eq 0 ]; then
    echo "   ✅ All SKILL.md files under 500 lines"
fi

# Check for Windows-style paths
BACKSLASH_FILES=$(grep -rl '\\' .claude/skills/*/SKILL.md 2>/dev/null | wc -l)
if [ "$BACKSLASH_FILES" -gt 0 ]; then
    echo "   ⚠️  $BACKSLASH_FILES skill files contain backslash paths (use forward slashes)"
fi

# Codex content parity (not just count)
echo ""
echo "7. Codex Content Parity:"
# Note: This check mirrors Stage 5 Step 2.1a's parity check. If Step 2.1a passed with no drift,
# this should also pass. If it fails here but not in 2.1a, a Stage 5 change introduced drift.
DRIFT_COUNT=0
if [ ! -d ".agents/skills" ]; then
    echo "   ⚠️  .agents/skills not found (only required when Codex repo skills are enabled)"
else
    for skill_dir in .claude/skills/*/; do
        if [ -f "${skill_dir}SKILL.md" ]; then
            skill_name=$(basename "$skill_dir")
            codex_skill=".agents/skills/$skill_name/SKILL.md"
            if [ -f "$codex_skill" ]; then
                # Normalize intentional CLAUDE.md→AGENTS.md substitution before comparing
                if ! diff -q <(sed 's/CLAUDE\.md/AGENTS.md/g' "${skill_dir}SKILL.md") "$codex_skill" > /dev/null 2>&1; then
                    echo "   ⚠️  Content drift: $skill_name (beyond expected CLAUDE.md→AGENTS.md substitution)"
                    DRIFT_COUNT=$((DRIFT_COUNT + 1))
                fi
            else
                echo "   ❌ Missing in .agents/skills: $skill_name"
                DRIFT_COUNT=$((DRIFT_COUNT + 1))
            fi
        fi
    done
    if [ "$DRIFT_COUNT" -eq 0 ]; then
        echo "   ✅ All skills in sync between .claude and .agents"
    fi
fi

# 8. Security Check
echo ""
echo "8. Security Check:"
SCRIPT_COUNT=$(find .claude/skills -name "*.py" -o -name "*.sh" -o -name "*.js" 2>/dev/null | wc -l)
if [ "$SCRIPT_COUNT" -gt 0 ]; then
    echo "   ℹ️  $SCRIPT_COUNT executable scripts found in skills"
    NETWORK_SCRIPTS=$(grep -rl "curl\|wget\|fetch\|requests\.\|http\|urllib" .claude/skills/*/scripts/ 2>/dev/null | wc -l)
    if [ "$NETWORK_SCRIPTS" -gt 0 ]; then
        echo "   ⚠️  $NETWORK_SCRIPTS scripts with potential network access — verify security review completed"
    fi
else
    echo "   ✅ No executable scripts in skills"
fi

# 9. Check for deprecated files
echo ""
echo "9. Deprecated Files Check:"
if [ -f ".claude/hooks.json" ]; then
    echo "   ⚠️  .claude/hooks.json exists (deprecated, should remove)"
else
    echo "   ✅ No deprecated hooks.json"
fi

if [ -f ".claude/skills/skill-rules.json" ]; then
    echo "   ⚠️  .claude/skills/skill-rules.json exists (deprecated — skill activation is now description-based; remove this file)"
else
    echo "   ✅ No deprecated skill-rules.json"
fi

LEFTOVER=$(find .claude/skills -name "_skill-rules-entry.json" 2>/dev/null | wc -l)
if [ "$LEFTOVER" -gt 0 ]; then
    echo "   ⚠️  $LEFTOVER leftover _skill-rules-entry.json files (deprecated — remove these files)"
else
    echo "   ✅ No leftover artifact files"
fi

# 10. Check discovery artifacts
echo ""
echo "10. Discovery Artifacts:"
if [ -f ".claude/discovery/analysis.yaml" ]; then
    if command -v yq >/dev/null 2>&1; then
        if yq . .claude/discovery/analysis.yaml > /dev/null 2>&1; then
            echo "   ✅ analysis.yaml exists and is valid YAML"
        else
            echo "   ❌ analysis.yaml exists but is malformed YAML — re-run Stage 1 to regenerate"
        fi
    elif python3 -c "import yaml; yaml.safe_load(open('.claude/discovery/analysis.yaml'))" 2>/dev/null; then
        echo "   ✅ analysis.yaml exists and is valid YAML (validated via Python)"
    else
        echo "   ⚠️  Neither yq nor python3+PyYAML available — cannot validate analysis.yaml. Install one to enable YAML validation."
    fi
else
    echo "   ⚠️  analysis.yaml not found (Stage 1 may not have run)"
fi

if [ -f ".claude/discovery/raw_data.txt" ]; then
    echo "   ✅ raw_data.txt exists (automated diagnostics)"
fi
echo ""

echo "11. Behavioral Rules Check:"
# Note: Stage 5 Step 2.1f is the authoritative fix location — it runs gap detection with remediation.
# This check catches drift introduced during Stage 5 reconciliation. If gaps appear here that
# weren't in Stage 5's run, a reconciliation change is the cause.
GLOBAL_CLAUDE="$HOME/.claude/CLAUDE.md"
if [ -f "$GLOBAL_CLAUDE" ]; then
    # Extract Behavioral Rules section only (not mentions elsewhere)
    BR_SECTION=$(awk '/^## Behavioral Rules/{found=1} found && /^## [^B]/{exit} found{print}' "$GLOBAL_CLAUDE")
    if [ -z "$BR_SECTION" ]; then
        echo "   ❌ Behavioral Rules section missing from ~/.claude/CLAUDE.md"
    else
        echo "   ✅ Behavioral Rules section found"
        # Check for each required rule within the section
        RULES_MISSING=0
        for rule_pattern in \
            "Grounding\|investigate\|never speculate" \
            "Scope\|over-engineering\|only make changes" \
            "Testing\|do not.*test\|don't.*test" \
            "Reversibility\|hard to reverse\|confirm before" \
            "Long tasks\|decompose\|paralleliz" \
            "Action.*default\|implement.*rather\|infer the most" \
            "Parallel.*tool\|multiple tool\|independent tool calls" \
            "Subagent\|agent team\|work directly and sequentially" \
            "Cleanup\|temporary files\|clean up" \
            "Secrets\|credentials\|never commit"
        do
            if ! echo "$BR_SECTION" | grep -qi "$rule_pattern"; then
                echo "   ⚠️  Possible gap in Behavioral Rules: $rule_pattern"
                RULES_MISSING=$((RULES_MISSING + 1))
            fi
        done
        if [ "$RULES_MISSING" -eq 0 ]; then
            echo "   ✅ All 10 behavioral rules (9 from guide + Secrets) pattern-matched in section"
        fi
    fi
fi
# Negative check: project files must NOT contain repo-agnostic sections
echo "   Negative check (project files):"
for section in "## Behavioral Rules" "## General Guardrails"; do
    if grep -q "$section" CLAUDE.md 2>/dev/null; then
        echo "   ❌ Project CLAUDE.md contains '$section' — belongs in ~/.claude/CLAUDE.md only. Remove it."
    fi
    if grep -q "$section" AGENTS.md 2>/dev/null; then
        echo "   ❌ Project AGENTS.md contains '$section' — belongs in global file only. Remove it."
    fi
done
echo "   Negative check complete."
echo ""

} | tee /tmp/_bootstrap_val.txt

echo ""
echo "=== Summary ==="
echo "Checks passed: $(grep -c '✅' /tmp/_bootstrap_val.txt 2>/dev/null || echo 0)"
echo "Warnings:      $(grep -c '⚠️' /tmp/_bootstrap_val.txt 2>/dev/null || echo 0)"
echo "Errors:        $(grep -c '❌' /tmp/_bootstrap_val.txt 2>/dev/null || echo 0)"
echo ""
echo "=== Validation Complete ==="
```

**Failure handling:**
- **0 errors:** PASS — proceed to Step 2.
- **Errors > 0:** STOP — report failures to the user. Do not generate the completion report until errors are resolved.
- **Warnings only:** Proceed but include warnings in the completion report.

---

# Step 2: Report Completion

**Why:** The completion report gives the user a single summary of everything generated, with concrete next steps and verification prompts to confirm the setup works.

Read `CLAUDE.md`, `.claude/skills/*/SKILL.md`, and `.claude/discovery/analysis.yaml` to populate the report with actual values. Do not estimate or infer counts — use `ls .claude/skills/ | wc -l` and similar commands to get real numbers. Verify every bracketed placeholder (e.g., `[X]`, `[N]`, `[From analysis]`) is filled with actual values before presenting the report.

Before generating the report, run these commands to populate each placeholder:
```bash
# [X] tokens
echo "$(wc -w < CLAUDE.md) words"
# [N] skills
ls .claude/skills/ | wc -l
# [From analysis] Tech Stack
yq '.tech_stack.primary_language + " " + .tech_stack.language_version + " + " + .tech_stack.framework' .claude/discovery/analysis.yaml 2>/dev/null || \
python3 -c "import yaml; d=yaml.safe_load(open('.claude/discovery/analysis.yaml')); ts=d.get('tech_stack',{}); print(ts.get('primary_language','TBD') + ' ' + ts.get('language_version','') + ' + ' + ts.get('framework','TBD'))" 2>/dev/null || echo "TBD"
# [From analysis] Architecture
yq '.architecture.pattern' .claude/discovery/analysis.yaml 2>/dev/null || \
python3 -c "import yaml; d=yaml.safe_load(open('.claude/discovery/analysis.yaml')); print(d.get('architecture',{}).get('pattern','TBD'))" 2>/dev/null || echo "TBD"
# [Domain-specific pattern query] and [Domain-specific implementation test]:
# Generate from project_domains in analysis.yaml using the examples in the First Session Checklist below
yq '.project_domains[]' .claude/discovery/analysis.yaml 2>/dev/null || \
python3 -c "import yaml; d=yaml.safe_load(open('.claude/discovery/analysis.yaml')); [print(p) for p in d.get('project_domains',[])]" 2>/dev/null || echo "TBD"
# Note: if both yq and python3+PyYAML are unavailable, fill [From analysis] placeholders manually.
```

**Generate final summary:**

```
╔══════════════════════════════════════════════════════════════════╗
║              Bootstrap Configuration Complete!                    ║
╚══════════════════════════════════════════════════════════════════╝

Generated Files:
✅ CLAUDE.md (lean overview, NO @imports - ~[X] tokens)
✅ AGENTS.md (Codex project instructions)
✅ .claude/skills/ ([N] skills with progressive disclosure)
   - review-gates/, security-review-gates/, performance-review-gates/ (quality checklists)
   - code-conventions/ (style guide)
   - codebase-overview/ (architecture + tech stack, if generated)
   - [pattern]-patterns/ (for each critical pattern, if any)
   - [failure-type]-prevention/ (failure prevention skills, if any)
   - [domain-specific skills] (domain skills, if any)
   (run `ls .claude/skills/` for the complete list)
✅ .agents/skills/ ([N] skills; behaviorally aligned with .claude/skills for Codex)
ℹ️  .claude/agents/ (not generated — project agents are discouraged; domain knowledge belongs in skills)

Architecture (skills-first, dual-tool):
┌─────────────────────────────────────────────────────────────┐
│ CLAUDE.md (under 5k tokens) - Always loaded                 │
│ • Tech stack, commands, conventions                          │
│ • Lean pointers (details live in skills)                    │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Skills (progressive disclosure)                              │
│ • Level 1 (Discovery): name + description (~100 tokens/skill) │
│ • Level 2 (Activation): SKILL.md body (<5,000 tokens)         │
│ • Level 3 (Execution): references/, scripts/ (on-demand)      │
│ • Claude Code: .claude/skills                                │
│ • Codex:      .agents/skills                                  │
│ • SKILL.md bodies load only when invoked                    │
│ • references/ load only when explicitly read                │
│ • Contains ALL detailed examples and implementation         │
│ • Structure: flexible — adapt to content type               │
│   (rough guide: philosophy, guide, pitfalls, verification)  │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Review & Validation                                          │
│ • /qa pipeline: loads security/performance-review-gates as  │
│   project context for Validators C and D                     │
│ • /plan: loads review-gates for quality standards            │
│ • Trivial path: review-gates as standalone self-check        │
│ • Global agents: deep analysis (security-reviewer,          │
│   performance-analyzer) — invoked by /qa or standalone      │
└─────────────────────────────────────────────────────────────┘

Token Efficiency:
- Claude Code startup: CLAUDE.md + skill metadata
- Codex startup: AGENTS.md + CLAUDE.md + skill metadata (lean)
- During work: +skill bodies only when needed (progressive disclosure)
- Skill metadata budget: 2% of context window (~16,000 chars is a practical heuristic in most environments)
- Override with SLASH_COMMAND_TOOL_CHAR_BUDGET env var if needed
- NO eager loading of detailed content

Configuration Summary:
- Tech Stack: [From analysis]
- Architecture: [From analysis]
- Skills Generated (aligned in .claude/skills and .agents/skills): [Count]
- Project Agents: N/A (discouraged — domain knowledge belongs in skills)

Validation Summary:
- Checks passed: [paste ✅ count from Step 1 validation output]
- Warnings: [paste ⚠️ count; list warnings here if any]
- Errors: [should be 0 — if not, stop and fix before committing]

══════════════════════════════════════════════════════════════════

Next Steps:

1. Review CLAUDE.md
   - Verify tech stack and patterns are accurate
   - Add project-specific sections as needed

2. Review Skills
   - Check that examples match your codebase
   - Add any missing pitfalls you know about

3. Run Validation
   ${ENG_TEAM_DIR:-~/claude-eng-team}/validate-v2.sh
   if command -v skills-ref >/dev/null 2>&1; then skills-ref validate .claude/skills/<skill-name>; fi

4. Codex (optional): Verify instructions load
   codex --ask-for-approval never "Summarize the current instructions."

5. Commit Configuration
   git add CLAUDE.md AGENTS.md .claude/ .agents/
   git commit -m "Add AI engineering team bootstrap (Claude Code + Codex)"

6. Start Using
   - Claude Code: claude "Help me understand this codebase"
   - Codex:      codex "Help me understand this codebase"

══════════════════════════════════════════════════════════════════

First Session Checklist (Verify Setup Works):

Claude Code:
- Run `claude` and try these prompts to verify everything is working

Codex:
- Run `codex` (from the repo root) and try the same prompts

1. **"Summarize the codebase architecture"** — Expected: matches your known project structure. If wrong: discovery missed key patterns.
2. **[Domain-specific pattern query]** — Generate one item per detected domain from `project_domains`. For N detected domains, this produces N items numbered 2a–2N. For each domain, ask "What patterns should I follow to [domain's primary add-new-thing workflow]?" Examples:
   - software → "...to add an API endpoint?"
   - data-analytics → "...to add a new staging model?"
   - ml-ds → "...to add a new training experiment?"
   - data-engineering → "...to add a new DAG?"
   For domains not listed above, derive an equivalent prompt from the domain's primary workflow as discovered in analysis.yaml.
   *Example for `project_domains: [software, ml-ds]`:*
   *2a. "What patterns should I follow to add an API endpoint?" (software)*
   *2b. "What patterns should I follow to add a new training experiment?" (ml-ds)*
   Expected: loads skills automatically, shows step-by-step. If wrong: check skill description quality (Claude Code) or invoke skill explicitly with `$code-conventions` (Codex).
3. **[Domain-specific implementation test]** — Generate one item per detected domain from `project_domains`. For N detected domains, this produces N items numbered 3a–3N. For each domain, ask the agent to implement a minimal example of the domain's core artifact. Examples:
   - software → "Add a simple health check endpoint at /api/health"
   - data-analytics → "Add a staging model for a new source table"
   - ml-ds → "Set up scaffolding for a new model evaluation script"
   - data-engineering → "Add a new DAG that runs a simple Python task daily"
   For domains not listed above, derive an equivalent small implementation task from the domain's primary artifact type as discovered in analysis.yaml.
   *Example for `project_domains: [data-analytics, data-engineering]`:*
   *3a. "Add a staging model for a new source table" (data-analytics)*
   *3b. "Add a new DAG that runs a simple Python task daily" (data-engineering)*
   Expected: follows patterns from CLAUDE.md (Claude Code) or AGENTS.md (Codex).
4. **Try `/review-gates`** — Expected: skill content loads and displays review checklist. If wrong: check skill description quality.
5. **"What time is it?" (negative test)** — Expected: no skills activate. If wrong: description too generic (Everything Bagel).

**Cross-model testing (recommended for critical skills):** Test across Haiku, Sonnet, and Opus — what works for Opus may need more detail for Haiku.

Troubleshooting:
- If skills don't activate: Check description quality first (WHAT + WHEN + Do-not-use boundary + trigger keywords). Good descriptions are the activation mechanism
- If skills don't load (Codex): Ensure `.agents/skills/*/SKILL.md` exists (and enable skills if your Codex build gates them)
- If workflow not followed: Ensure CLAUDE.md is present; for Codex, ensure `AGENTS.md` exists
- If patterns wrong: Re-run Stage 1 discovery targeting the specific patterns that were incorrect
- If skill activates too often: Make description more specific, or set `disable-model-invocation: true`
- If too many skills exceed context budget: Run `/context` to check excluded skills. Set SLASH_COMMAND_TOOL_CHAR_BUDGET env var. Consolidate overlapping skills.
- If skills break after repo changes: Check for hard-coded paths/versions in SKILL.md. Move specifics to references/ files.
- If responses are slow/bloated: Check SKILL.md line counts (`wc -l .claude/skills/*/SKILL.md`). Move content >500 lines to references/.
- If skill triggers incorrectly: Add "This skill does NOT handle..." to skill body. Make description more specific.

══════════════════════════════════════════════════════════════════

**Re-bootstrap:** When the codebase evolves significantly, see your local `claude-eng-team/COMPLETE-SOP.md` (or `$ENG_TEAM_DIR/COMPLETE-SOP.md`) for the full re-bootstrap sequence.

══════════════════════════════════════════════════════════════════
```

---

# Step 3: Cleanup

Remove the deduplication check file. It was only needed during bootstrap validation (Step 1) and is no longer required.

```bash
rm -f .claude/discovery/deduplication-report.txt
rm -f /tmp/_bootstrap_val.txt
```

---

# Bootstrap Complete

Your AI engineering team is now configured.

- Claude Code: Run `claude` to start working with your AI pair programmer.
- Codex: Run `codex` from the repo root (it will read `AGENTS.md`).
