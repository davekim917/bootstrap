---
name: bootstrap-audit
description: "Stage 5: Audit and reconcile generated config and skills for consistency."
---

# Stage 5: Audit & Reconciliation

Reconcile ALL existing skills against the new `analysis.yaml`. This stage ensures skills stay current with codebase evolution.

**Prerequisites:** Stage 2 complete (CLAUDE.md and AGENTS.md must exist), Stage 3 complete, and Stage 4 complete (core and domain skills generated).

**When to Run:**
- **First Bootstrap:** Full validation of newly generated skills
- **Re-bootstrap:** Full reconciliation of existing skills vs new analysis

---

# Step 1: Load Analysis Data

First, read the discovery analysis:

```bash
cat .claude/discovery/analysis.yaml
```

This file contains all patterns, conventions, and recommendations from Stage 1 discovery. Use it as the source of truth for reconciliation.

**Default: proceed immediately and autonomously** through all audit steps, with these five mandatory stops:
1. Before executing any action on EVERYTHING_BAGEL findings (e.g., moving to CLAUDE.md, deleting the skill) — producing the classification and recommendation does not require a stop
2. Before deleting any DUPLICATE or SUBSET skills (Step 2.1e)
3. Before modifying `~/.claude/CLAUDE.md` behavioral rules (Step 2.1f) — this is a global file affecting all projects
4. After presenting the reconciliation report — before executing changes (Step 2.5/2.6)
5. Before making major content changes to EVOLVED skills (Step 2.3)

At all other points, continue without pausing for user input.

**First bootstrap note:** Stage 5 always runs after Stage 3 and Stage 4 have generated skills. The full 2.1a–2.1g audit applies to those newly generated skills — do not skip it. Step 2.1f (behavioral rules freshness) and Step 2.1g (references folder convention) always run. If Step 2.1's inventory finds zero skills, Stage 3 did not run successfully — stop and run Stage 3 and Stage 4 before continuing.

**Execution mode:** Prioritize execution over deliberation. For each skill, evaluate checks and record findings quickly — flag borderline cases with a recommendation and move on. Choose one interpretation for ambiguous cases and continue; only course-correct if you encounter a concrete contradiction. Write each audit finding once; do not revise or expand entries. Do not pause between skills unless a mandatory stop is reached.

---

# Step 2: Comprehensive Skill Audit & Reconciliation

Re-bootstrap means patterns may have changed. Audit all existing skills against the new `analysis.yaml` before assuming any skill is still current.

---

## 2.1: Full Skill Inventory

**Catalog all existing skills:**

```bash
echo "=== Existing Skills Inventory ==="
for skill_dir in .claude/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
        skill_name=$(basename "$skill_dir")
        echo "- $skill_name"
        # Extract description from YAML frontmatter
        sed -n '/^description:/p' "${skill_dir}SKILL.md" | head -1
    fi
done
```

---

## 2.1a: Codex Skills Parity & Drift Check (Dual-Tool)

This bootstrap places Codex skills under `.agents/skills/` (documented contract). Verify parity to prevent drift. If your environment uses `.codex/skills/` as a compatibility mirror, validate that mirror separately.

> **Note:** This parity check is also run in Stage 6 Check 7 as a post-reconciliation safety net. If 2.1a passes here but Stage 6 Check 7 fails, a Stage 5 reconciliation change introduced drift — re-sync the affected skill.

```bash
echo "=== Codex Skills Parity Check ==="

if [ ! -d ".agents/skills" ]; then
  echo "⚠️  Missing: .agents/skills (only required when Codex repo skills are enabled)"
else
  CLAUDE_SKILLS=$(find .claude/skills -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' \; -print 2>/dev/null | xargs -I{} basename {} | sort)
  CODEX_SKILLS=$(find .agents/skills -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' \; -print 2>/dev/null | xargs -I{} basename {} | sort)

  echo "Claude skills count: $(echo "$CLAUDE_SKILLS" | grep -c '^[^ ]' || true)"
  echo "Codex skills count:  $(echo "$CODEX_SKILLS" | grep -c '^[^ ]' || true)"
  echo ""

  echo "Missing in .agents/skills:"
  comm -23 <(echo "$CLAUDE_SKILLS") <(echo "$CODEX_SKILLS") || true
  echo ""

  echo "Extra in .agents/skills:"
  comm -13 <(echo "$CLAUDE_SKILLS") <(echo "$CODEX_SKILLS") || true
  echo ""

  echo "Checking per-skill metadata drift (name/description) and behavior drift..."
  for skill_dir in .claude/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
      skill_name=$(basename "$skill_dir")
      codex_skill=".agents/skills/${skill_name}/SKILL.md"

      if [ ! -f "$codex_skill" ]; then
        continue
      fi

      claude_name=$(sed -n '/^name:/p' "${skill_dir}SKILL.md" | head -1)
      codex_name=$(sed -n '/^name:/p' "$codex_skill" | head -1)
      claude_desc=$(sed -n '/^description:/p' "${skill_dir}SKILL.md" | head -1)
      codex_desc=$(sed -n '/^description:/p' "$codex_skill" | head -1)

      if [ "$claude_name" != "$codex_name" ] || [ "$claude_desc" != "$codex_desc" ]; then
        echo "⚠️  Metadata drift: ${skill_name}"
        echo "  .claude: ${claude_name} | ${claude_desc}"
        echo "  .agents: ${codex_name} | ${codex_desc}"
      fi

      # Compare after normalizing intentional CLAUDE.md→AGENTS.md substitution
      if ! diff -q <(sed 's/CLAUDE\.md/AGENTS.md/g' "${skill_dir}SKILL.md") "$codex_skill" > /dev/null 2>&1; then
          echo "⚠️  Content drift: ${skill_name} — .claude and .agents SKILL.md differ (beyond expected CLAUDE.md→AGENTS.md substitution)"
      fi

      # Check for Claude Code-specific fields in Codex copy
      if grep -qE '^(context|agent|hooks|model):' "$codex_skill"; then
          echo "ℹ️  ${skill_name}: Codex copy contains Claude Code extension fields (will be ignored by Codex)"
      fi
    fi
  done
fi
```

## 2.1b: Skill Quality Audit

**Why:** This audit catches the most common skill problems — poor descriptions, failure mode patterns, content anti-patterns, and missing workflow elements. Skills that fail these checks underperform in activation and behavior.

For EACH existing skill, evaluate against these dimensions:

### Description Quality

| Check | Criteria |
|-------|----------|
| **Third person?** | No "I" or "you" — description is injected into system prompt |
| **Under 1024 chars?** | Descriptions exceeding limit may be truncated |
| **WHAT + WHEN?** | Must answer: what does it do AND when to use it |
| **5+ trigger keywords?** | Specific terms users would naturally say |
| **"Use when..." pattern?** | Explicit trigger conditions |
| **"Do not use for..." boundary?** | Explicit out-of-scope conditions to prevent overtriggering |
| **File types/domains?** | Mentions relevant formats, technologies, or domains |
| **Uses user terms?** | Keywords match how users actually phrase requests, not just technical jargon |

For each skill, apply the litmus test: pick 2–3 realistic user prompts from the skill's intended domain and 1–2 from adjacent domains. Would the description cause correct activation for the first group and non-activation for the second?

**For skills that fail 2+ checks, rewrite:**
```yaml
description: >
  [Core capability]. [Secondary capabilities].
  Use when [trigger condition 1], [trigger condition 2],
  or when user mentions "[keyword1]", "[keyword2]", "[keyword3]".
  Do not use for [adjacent out-of-scope tasks].
```

### Four Failure Modes

| Failure Mode | Detection | If Found |
|-------------|-----------|----------|
| **Encyclopedia** | SKILL.md > 500 lines OR reads like a wiki | Split into `references/` files |
| **Everything Bagel** | Would apply to every task | Move to CLAUDE.md/AGENTS.md (it's a rule, not a skill) |
| **Secret Handshake** | Description is vague or uses jargon users don't say | Rewrite description with real trigger keywords |
| **Fragile Skill** | Hard-codes paths, versions, file counts | Move specifics to referenced files |

**Wait for user confirmation before acting on EVERYTHING_BAGEL recommendations.**

### Content & Structural Anti-Patterns

| Anti-Pattern | Detection | Action |
|-------------|-----------|--------|
| **Explaining common knowledge** | Content describes things Claude already knows | Remove — only add context Claude doesn't have |
| **Hallucinated examples** | Code references files that don't exist in codebase | Replace with real code (`file:line` references) |
| **Too many options** | Multiple approaches without a clear default | Pick ONE recommended approach |
| **Deeply nested references** | SKILL.md → file.md → another-file.md (>1 level) | Flatten to one level of references |
| **No examples** | Rules without concrete examples | Add examples — longer than rules section |
| **Time-sensitive information** | Dates, version-specific content | Replace with "Current method" / "Old patterns" |

### Content Pattern Match

Verify content pattern matches the skill's purpose:
- Review gate skills → Checklist Pattern
- Workflow skills → Step-by-step with Feedback Loop
- Pattern skills → Implementation Guide with I/O Examples
- Reference skills → Layer boundaries with Decision Guide

### Workflow Completeness (workflow skills only)

For workflow-type skills (review-gates, pattern-skills with procedures), verify:

| Question | What to Check |
|----------|--------------|
| **Trigger** | Clear when the agent should load this? |
| **Inputs** | States what info it needs? |
| **Steps** | Procedure clear and complete? |
| **Checks** | Defines how to prove success? |
| **Stop conditions** | When to pause and ask a human? |
| **Recovery** | What happens if a check fails? |

*For reference-only skills, Inputs/Steps/Recovery may not apply.*

**Report format:**
```
=== Skill Quality Audit ===
PASS:            [skill-name] — passes all checks
REWRITE_DESC:    [skill-name] — description fails [N] checks: [list]
ENCYCLOPEDIA:    [skill-name] — SKILL.md is [X] lines, recommend splitting
EVERYTHING_BAGEL:[skill-name] — too generic, recommend moving to CLAUDE.md
SECRET_HANDSHAKE:[skill-name] — description vague, recommend rewrite
FRAGILE:         [skill-name] — hard-coded [paths/versions], recommend extraction
INCOMPLETE:      [skill-name] — missing workflow questions: [list]
```

---

## 2.1c: Degrees of Freedom Validation

**Why:** Skills must match instruction specificity to task fragility. Over-specifying flexible tasks causes agent paralysis; under-specifying fragile tasks causes dangerous errors. (See skill-development/SKILLS-DEVELOPMENT-GUIDE.md for framework details.)

For EACH existing skill, classify and validate:

| Freedom Level | Appropriate For | Detection |
|--------------|----------------|-----------|
| **High** (text guidelines) | Code reviews, architecture decisions, documentation | Multiple valid approaches, context-dependent |
| **Medium** (pseudocode/params) | Report generation, test scaffolding, common patterns | Preferred pattern exists but variation OK |
| **Low** (exact scripts) | Database migrations, deploy scripts, config changes | Fragile operations, consistency-critical |

**Report format:**
```
=== Degrees of Freedom Audit ===
APPROPRIATE: [skill-name] — [level] freedom matches task type ([rationale])
MISMATCH:    [skill-name] — currently [level] but task is [type], recommend [new-level]
```

---

## 2.1d: Security Audit

**Why:** Skills with side effects, executable scripts, or network access need security controls — without explicit restrictions, side-effect skills can be invoked autonomously with unintended consequences. (See skill-development/SKILLS-DEVELOPMENT-GUIDE.md, Section 12: Security model for skills)

For EACH existing skill, check:

| Check | What to Look For | Action if Found |
|-------|-----------------|-----------------|
| **Side effects?** | Does the skill deploy, send messages, modify external state? | Must have `disable-model-invocation: true` |
| **Scripts present?** | Any files in `scripts/` directory? | Review for network calls, file system access, credential usage |
| **Network access?** | Scripts calling curl, wget, fetch, requests, http | Flag for manual security review |
| **Tool restrictions?** | Should tools be limited? (read-only skills, review gates) | Add `allowed-tools` to frontmatter |
| **Secrets exposure?** | Hardcoded API keys, tokens, credentials in skill content | Remove immediately |

**Report format:**
```
=== Security Audit ===
CLEAN:      [skill-name] — no security concerns
NEEDS_CTRL: [skill-name] — has side effects, needs disable-model-invocation
NEEDS_RESTRICT: [skill-name] — review gate, should have allowed-tools
REVIEW_REQ: [skill-name] — scripts with network access, manual review needed
CRITICAL:   [skill-name] — potential secrets/credentials found
```

---

## 2.1e: Global Skill/Agent Overlap Check (Deduplication Audit)

**Why:** Project skills must not duplicate global skills or attempt to replicate global agent functionality. This check catches overlap that was missed during generation or introduced by manual edits.

**Incremental approach:** Stage 3 already made deduplication decisions and saved them to `.claude/discovery/deduplication-report.txt`. Skills classified DUPLICATE, SUBSET, COMPLEMENT, or LAYERED in that report retain their classification — those decisions involved meaningful analysis and do not need re-evaluation. However, **CLEAN-classified skills must be re-evaluated** against the current global inventory: new global skills may have been installed since the last bootstrap, turning a previously-clean project skill into a duplicate. Skills not in the report at all (e.g., manually created) also get a full check.

**Required format for deduplication-report.txt** (Stage 6 and this section parse it with `grep "^LAYERED: skill-name"`):
```
DUPLICATE: skill-name — covered by global skill: global-name
SUBSET: skill-name — covered by global superset: global-name
COMPLEMENT: skill-name — partially overlaps global: global-name, scoping to project-specific patterns
CLEAN: skill-name — no global overlap
LAYERED: skill-name — thin checklist, complements global agent-name agent
```
Each classification keyword must be at line start, followed by `: `, followed immediately by the skill name. Do not indent lines or add prefixes before the classification keyword.

```bash
echo "=== Deduplication Baseline (from Stage 3) ==="
if [ -f ".claude/discovery/deduplication-report.txt" ]; then
    cat .claude/discovery/deduplication-report.txt
    echo "(DUPLICATE/SUBSET/COMPLEMENT/LAYERED retained — CLEAN skills will be re-evaluated against current globals)"
else
    echo "(no deduplication report found — running full overlap check)"
fi
echo ""
```

**Re-evaluation of CLEAN skills:** Extract skill names with `CLEAN:` classification from the dedup report. Include these alongside any unclassified skills in the per-skill overlap check below. If a previously-CLEAN skill now overlaps a global skill, reclassify it (update the line in `deduplication-report.txt`) and include it in the overlap audit report. Reclassified skills receive the same user confirmation gate as any new DUPLICATE or SUBSET finding.

```bash
echo "=== Global Skill Overlap Check ==="

# Get global skills
GLOBAL_SKILLS=""
for skill_dir in ~/.claude/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
        skill_name=$(basename "$skill_dir")
        desc=$(sed -n '/^description:/{ s/^description: *//; p; q; }' "${skill_dir}SKILL.md")
        GLOBAL_SKILLS="${GLOBAL_SKILLS}${skill_name}: ${desc}\n"
    fi
done

echo "Global skills found:"
echo -e "$GLOBAL_SKILLS"

echo ""
echo "Project skills to check:"
for skill_dir in .claude/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
        skill_name=$(basename "$skill_dir")
        desc=$(sed -n '/^description:/{ s/^description: *//; p; q; }' "${skill_dir}SKILL.md")
        echo "  - ${skill_name}: ${desc}"
    fi
done

echo ""
echo "=== Global Agents ==="
for f in ~/.claude/agents/*.md; do
    [ -f "$f" ] && echo "  - $(basename "$f" .md)"
done

echo ""
echo "=== Codex Global Skills (if available) ==="
if [ -z "$CODEX_HOME" ]; then
    echo "  (CODEX_HOME not set — checking ~/.codex/skills/ only)"
fi
for skill_dir in ${CODEX_HOME:+"$CODEX_HOME"/skills/*/} ~/.codex/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
        skill_name=$(basename "$skill_dir")
        desc=$(sed -n '/^description:/{ s/^description: *//; p; q; }' "${skill_dir}SKILL.md")
        echo "  - ${skill_name}: ${desc}"
    fi
done
```

**For each project skill, check against globals:**

| Overlap Type | Condition | Action |
|-------------|-----------|--------|
| **DUPLICATE** | Project skill name/domain matches a global skill | **DELETE** project skill — global already covers it |
| **SUBSET** | Project skill covers a narrower topic within a global skill's domain | **DELETE** unless it adds project-specific patterns not in the global |
| **COMPLEMENT** | Project skill adds project-specific details to a global skill's domain | **KEEP** but add reference: "For general guidance, see the global `[name]` skill" |
| **LAYERED** | Review gate skill overlaps with a global agent | **KEEP** as thin checklist — layered review pattern (self-check → agent review) |

**Report format:**
```
=== Overlap Audit ===
DUPLICATE: [project-skill] ↔ global [global-skill] → Recommend: DELETE
SUBSET:    [project-skill] ⊂ global [global-skill] → Recommend: DELETE (no project-specific content)
COMPLEMENT:[project-skill] + global [global-skill] → Recommend: KEEP (adds project-specific patterns)
LAYERED:   [review-gate] + global [agent-name] → Recommend: KEEP (thin checklist complements agent)
CLEAN:     [project-skill] — no global overlap
```

**Wait for user confirmation before deleting any project skills flagged as DUPLICATE or SUBSET.**

---

## 2.1f: Behavioral Rules Freshness Check (Global ~/.claude/CLAUDE.md)

**Why:** Behavioral rules live in the global `~/.claude/CLAUDE.md` (not in project files). This check verifies the global file is current. It runs once per re-bootstrap, not per-skill.

Note: Stage 6 Check #11 re-runs behavioral rules detection as a post-reconciliation safety net (pattern-matching only, no remediation). If gaps found in Step 2.1f are fixed here, Stage 6 Check #11 should pass clean. If 2.1f passes but 2E #11 fails, a Stage 5 reconciliation change introduced new gaps.

```bash
ENG_TEAM_DIR="${ENG_TEAM_DIR:-~/claude-eng-team}"
# Guard: 2.1f requires the global ~/.claude/CLAUDE.md to exist
GLOBAL_CLAUDE="$HOME/.claude/CLAUDE.md"
if [ ! -f "$GLOBAL_CLAUDE" ]; then
    echo "  ❌ ~/.claude/CLAUDE.md not found — behavioral rules must live in the global file."
    echo "  STOP: Create ~/.claude/CLAUDE.md with Behavioral Rules before continuing."
    # Do not proceed with the checks below until the global file exists.
fi
```

**Negative check — project files must NOT contain repo-agnostic sections:**

```bash
for section in "## Behavioral Rules" "## General Guardrails"; do
    if grep -q "$section" CLAUDE.md 2>/dev/null; then
        echo "  ❌ Project CLAUDE.md contains '$section' — this section belongs in ~/.claude/CLAUDE.md, not in project files."
        echo "     Remove it from CLAUDE.md (Stage 2 re-bootstrap will regenerate without it)."
    fi
    if grep -q "$section" AGENTS.md 2>/dev/null; then
        echo "  ❌ Project AGENTS.md contains '$section' — remove it (belongs in global file only)."
    fi
done
echo "  Negative check complete."
```

**Manual check:** Visually compare the `## Behavioral Rules` section in `~/.claude/CLAUDE.md` against Part 3 of `$ENG_TEAM_DIR/prompting-guide/claude-prompting-guide.md`. Verify all 10 rules are present: Grounding, Scope, Testing, Reversibility, Long tasks, Action default, Parallel Tool Use, Subagents vs teams, Cleanup, Secrets.

Look for these common condensation gaps:
- Scope rule condensed to a single sentence (should include sub-bullets: documentation, defensive coding, abstractions)
- Testing rule missing "do not hard-code values" and "flag to user" clauses
- Long tasks rule replaced with a checkpoint rule (different intent)
- Subagents vs teams rule missing the third option: "work directly and sequentially for simple tasks"
- Grounding rule missing "never make claims about code you haven't examined"
- Reversibility rule missing specific actions list (force pushing, hard reset, amending published commits)
- Action default rule missing "infer the most useful likely action" nuance
- Cleanup rule missing entirely
- Secrets rule missing entirely

**Run gap-detection now** — do not wait for Stage 6 to catch these:

```bash
GLOBAL_CLAUDE="$HOME/.claude/CLAUDE.md"
if [ -f "$GLOBAL_CLAUDE" ] && grep -q "## Behavioral Rules" "$GLOBAL_CLAUDE"; then
    BR_SECTION=$(awk '/^## Behavioral Rules/{found=1} found && /^## /{if (!/^## Behavioral Rules/) exit} found' "$GLOBAL_CLAUDE")
    echo "Gap detection (~/.claude/CLAUDE.md Behavioral Rules):"
    echo "$BR_SECTION" | grep -qi "hard-code values"                            || echo "  ⚠️  GAP: Testing rule missing 'do not hard-code values' clause"
    echo "$BR_SECTION" | grep -qi "flag.*to.*user\|flag it to"                 || echo "  ⚠️  GAP: Testing rule missing 'flag to user' clause"
    echo "$BR_SECTION" | grep -qi "work directly and sequentially"              || echo "  ⚠️  GAP: Subagents rule missing third option (work directly and sequentially)"
    echo "$BR_SECTION" | grep -qi "never make claims"                           || echo "  ⚠️  GAP: Grounding rule missing 'never make claims about code you haven't examined'"
    echo "$BR_SECTION" | grep -qi "force pushing\|hard reset"                   || echo "  ⚠️  GAP: Reversibility rule missing destructive actions list"
    echo "$BR_SECTION" | grep -qi "infer the most useful"                       || echo "  ⚠️  GAP: Action default rule missing 'infer the most useful likely action' nuance"
    echo "$BR_SECTION" | grep -qi "don't add docstrings\|defensive coding\|don't create helpers\|don't design for hypothetical" \
                                                                                || echo "  ⚠️  GAP: Scope rule missing sub-rules (documentation, defensive coding, abstractions)"
    echo "$BR_SECTION" | grep -qi "secrets\|credentials"                        || echo "  ⚠️  GAP: Secrets rule missing"
    echo "$BR_SECTION" | grep -qi "parallel.*tool\|multiple tool\|independent tool calls" || echo "  ⚠️  GAP: Parallel Tool Use rule missing"
    echo "Gap detection complete."
fi
```

If any gaps are found, follow the "If outdated" instructions below. Stage 6 check #11 runs the same detection as a final safety net.

**If outdated: MANDATORY STOP.** This is a global file that affects all projects. Before modifying `~/.claude/CLAUDE.md`, present the detected gaps to the user and get explicit approval. Show:
1. Which rules are missing or condensed
2. The proposed changes (full text from `$ENG_TEAM_DIR/prompting-guide/claude-prompting-guide.md` Part 3)
3. Wait for user confirmation before writing

After approval: Read `$ENG_TEAM_DIR/prompting-guide/claude-prompting-guide.md` Part 3 and copy all behavioral rules verbatim into the `## Behavioral Rules` section of `~/.claude/CLAUDE.md`. Do not summarize or condense — copy the full text of each rule. Then re-mirror to `~/.agents/AGENTS.md` and `~/.codex/AGENTS.md`.

**Report format:**
```
=== Behavioral Rules Freshness ===
CURRENT:  All behavioral rules verified in ~/.claude/CLAUDE.md — full text matches prompting guide
OUTDATED: [List which rules are missing or condensed]
NEGATIVE: Project CLAUDE.md/AGENTS.md contain no repo-agnostic sections ✅
```

---

## 2.1g: References Folder Convention Check

**Why:** Skill subdirectories for deep-dive content must use `references/`, not `resources/`. The correct convention is established in this bootstrap; this check migrates any legacy `resources/` folders in the repo being bootstrapped.

**Scope:** Only project-level `.claude/skills/` and `.agents/skills/` are checked. Global skills at `~/.claude/skills/` and `~/.agents/skills/` are out of scope — fix those manually if needed.

```bash
echo "=== References Folder Convention Check ==="
echo "Convention: skill subdirectory for deep-dive content must be 'references/', not 'resources/'"
echo ""

RENAMED=0

for skill_dir in .claude/skills/*/; do
    if [ -d "${skill_dir}resources" ]; then
        echo "⚠️  Found 'resources/' in ${skill_dir} — renaming to 'references/'"
        mv "${skill_dir}resources" "${skill_dir}references"
        if [ -f "${skill_dir}SKILL.md" ]; then
            perl -pi -e 's|(?<![A-Za-z0-9_.-])resources/|references/|g' "${skill_dir}SKILL.md"
            echo "   Updated SKILL.md links"
        fi
        RENAMED=$((RENAMED + 1))
    fi
done

for skill_dir in .agents/skills/*/; do
    if [ -d "${skill_dir}resources" ]; then
        echo "⚠️  Found 'resources/' in ${skill_dir} — renaming to 'references/'"
        mv "${skill_dir}resources" "${skill_dir}references"
        if [ -f "${skill_dir}SKILL.md" ]; then
            perl -pi -e 's|(?<![A-Za-z0-9_.-])resources/|references/|g' "${skill_dir}SKILL.md"
            echo "   Updated SKILL.md links"
        fi
        RENAMED=$((RENAMED + 1))
    fi
done

if [ "$RENAMED" -eq 0 ]; then
    echo "✅ All skill subdirectories follow 'references/' convention — no renames needed"
else
    echo ""
    echo "✅ Renamed $RENAMED location(s) to 'references/' (mirrored skills appear twice — once in .claude/, once in .agents/)"
fi
```

**Report format:**
```
=== References Folder Convention ===
CLEAN:   No 'resources/' folders found — convention correct
RENAMED: [skill-name] (.claude and/or .agents) — 'resources/' → 'references/', SKILL.md links updated
```

---

## 2.2: Reconcile Against New Analysis

**Why:** Skills generated from an earlier analysis may no longer reflect the codebase. Reconciliation ensures every skill still maps to a real pattern — outdated skills erode trust and add noise to activation decisions.

**If `skill-rules.json` does not exist, skip trigger-related checks in Steps 2.2 and 2.3.**

**For EACH existing skill, compare against `analysis.yaml`:**

| Skill Status | Condition | Action |
|--------------|-----------|--------|
| **CURRENT** | Pattern still in analysis.yaml with similar consistency | Keep, update triggers if keywords changed |
| **EVOLVED** | Pattern in analysis.yaml but consistency/approach changed | Update SKILL.md content to match new patterns |
| **STALE** | Pattern no longer found in analysis.yaml | Mark as deprecated OR delete if no longer relevant |
| **UNREGISTERED** | Critical skill (review gate, safety) exists but not in `.claude/skills/skill-rules.json` AND not classified LAYERED in the deduplication report | Add trigger configuration (critical skills only) |

**Reconciliation checklist for each skill:**

```markdown
Skill: [skill-name]

1. **Is this pattern still in analysis.yaml?**
   - YES → Continue to step 2
   - NO → Mark as STALE (see action below)

2. **Has the pattern consistency changed significantly?**
   - Was: [X]% → Now: [Y]%
   - If dropped >20%: Pattern may be deprecated, review
   - If increased: Pattern is more established, strengthen triggers

3. **Have canonical examples changed?**
   - Old example: [file:line]
   - New example from analysis: [file:line]
   - If different: Update SKILL.md examples

4. **Have new failure modes been discovered?**
   - New failures in analysis.yaml related to this skill?
   - Add to "Common Pitfalls" section

5. **Are triggers still accurate?**
   - Do keywords match current terminology in codebase?
   - Do file patterns match current directory structure?
   - Update `.claude/skills/skill-rules.json` if needed

6. **Are critical rules extracted to CLAUDE.md?**
   - Check if skill contains "must never miss" rules
   - Verify those rules appear in CLAUDE.md "Critical Guardrails"

7. **Are code examples still valid? (Anti-hallucination)**
   - Verify code examples still reference existing files (code may have changed since skill was written)
   - Check that `file:line` references point to real locations
   - Replace any hallucinated examples with real code from the codebase
```

---

## 2.3: Handle Each Skill Category

### CURRENT Skills (Pattern still valid)
- Verify trigger keywords match current analysis terminology
- Update consistency percentages in SKILL.md
- Add any new failure modes discovered

**Action:** Minor updates only
```bash
# Update consistency percentage in SKILL.md header
# Add any new pitfalls from analysis.yaml
# Verify triggers in skill-rules.json match current codebase terms
```

---

### EVOLVED Skills (Pattern changed significantly)

**Signs of evolution:**
- Consistency changed by >15%
- New canonical examples in analysis.yaml
- Different implementation approach detected
- New failure modes discovered

**Action:** Content update required
- **Minor changes** (proceed autonomously): update consistency percentages, add new failure modes, fix stale file:line references, update trigger keywords
- **Major changes** (stop and confirm first): rewrite the Implementation Guide, change the Philosophy section, or replace all canonical examples

**Quantitative fallback:** When uncertain whether a change is major or minor, use this heuristic — if the net change to SKILL.md would exceed 20% of the file's current line count, treat it as major and stop for confirmation before applying.

For major changes:
- **Rewrite** the Implementation Guide section with new examples
- Update the Philosophy section if architectural approach changed
- Update canonical examples to match analysis.yaml
- Review and update triggers

```markdown
# Checklist for EVOLVED skills:
- [ ] Philosophy section reflects current approach
- [ ] Implementation Guide uses new canonical examples
- [ ] All code examples updated to current patterns
- [ ] New failure modes added to Pitfalls section
- [ ] Verification checklist updated
- [ ] Triggers updated in skill-rules.json
- [ ] Re-sync mirror: `cp .claude/skills/[skill-name]/SKILL.md .agents/skills/[skill-name]/SKILL.md && perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' .agents/skills/[skill-name]/SKILL.md` and verify with `grep -r "CLAUDE.md" .agents/skills/[skill-name]/ || echo "clean"`
```

---

### STALE Skills (Pattern no longer exists)

**Signs of staleness:**
- Pattern not found in new analysis.yaml
- Related files no longer exist
- Technology/approach deprecated

**Decision required:**
```markdown
Skill [name] appears stale - pattern not found in new analysis.

Options:
A) DELETE - Pattern is obsolete, remove skill entirely
   → rm -rf .claude/skills/[skill-name]
   → Remove entry from skill-rules.json

B) DEPRECATE - Keep but mark as legacy (add "DEPRECATED" to description)
   → Update SKILL.md description: "DEPRECATED: [reason]. [migration path]"
   → Lower trigger priority or remove auto-triggers

C) KEEP - Pattern still relevant but wasn't detected (manual override)
   → Document why it's still needed despite not appearing in analysis
   → May indicate analysis coverage gap

Recommendation: [A/B/C] because [reasoning]
```

After filling in the recommendation, record it in the reconciliation report (Step 2.5) and **wait for user approval before executing** any deletion or deprecation. Do not act autonomously on STALE skills.

---

### UNREGISTERED Critical Skills (Critical skill missing from skill-rules.json)

**Note:** Most skills use description-based LLM activation and do NOT need entries in `skill-rules.json`. Only **critical skills** (review gates, safety gates) should have deterministic hook triggers.

**Check:** For each skill NOT in `skill-rules.json`, determine if it's critical:
- Review gate skills (`review-gates`, `security-review-gates`, `performance-review-gates`) → should have deterministic triggers **unless classified `LAYERED` in `.claude/discovery/deduplication-report.txt`** (meaning a global review agent covers the same domain; description-based activation is sufficient for the thin-checklist role in that case). Check the deduplication report before adding a trigger entry.
- Safety/compliance skills → **SHOULD** have triggers
- All other skills → **SKIP** — description-based activation is sufficient

**Action (for critical skills only):** Add trigger configuration

1. Read SKILL.md to understand purpose:
   ```bash
   cat .claude/skills/[skill-name]/SKILL.md | head -20
   ```

2. Create trigger configuration:
   ```json
   "[skill-name]": {
     "type": "domain",
     "enforcement": "suggest",
     "priority": "high",
     "description": "[From SKILL.md description field]",
     "promptTriggers": {
       "keywords": ["[relevant keywords from skill content]"],
       "intentPatterns": ["[patterns based on skill purpose]"]
     },
     "fileTriggers": {
       "pathPatterns": ["[file patterns skill applies to]"]
     }
   }
   ```

3. Add to skill-rules.json:
   ```bash
   # Edit .claude/skills/skill-rules.json
   # Add the entry, ensure valid JSON syntax
   jq . .claude/skills/skill-rules.json  # Validate
   ```

**For non-critical skills not activating reliably:** Improve description quality first (see Step 2.1b). Only escalate to hook-based triggers if description optimization fails.

---

## 2.4: Identify Missing Skills

**Check analysis.yaml recommendations against existing skills:**

```bash
echo "=== Missing Skills Check ==="

# List recommended skills from analysis.yaml
echo "Analysis recommends these skills:"
yq '.recommendations.skills | (.core[]?, .pattern_skills[]?, .domain_skills[]?)' .claude/discovery/analysis.yaml 2>/dev/null || \
python3 -c "
import yaml
try:
    d = yaml.safe_load(open('.claude/discovery/analysis.yaml'))
    r = d.get('recommendations', {}).get('skills', {})
    for k in ['core', 'pattern_skills', 'domain_skills']:
        for s in (r.get(k) or []):
            print(s)
except Exception as e:
    print(f'Error parsing analysis.yaml: {e}')
" 2>/dev/null || echo "(check analysis.yaml manually)"

echo ""
echo "Existing skills:"
ls -d .claude/skills/*/ 2>/dev/null | xargs -I{} basename {}

echo ""
echo "Compare above lists to identify missing skills"
```

**For each recommended skill that doesn't exist:**
- **Core skills** (review-gates, security-review-gates, performance-review-gates, code-conventions): return to Stage 3 (`/bootstrap-skills`) and generate it
- **Domain/pattern skills** (codebase-overview, [pattern]-patterns, [failure-type]-prevention): return to Stage 4 (`/bootstrap-domain`) and generate it
- Use `init_skill.py` to create the structure. If `init_skill.py` is not available, create skills manually following the appropriate template.
- Populate content from analysis.yaml
- Add trigger to `skill-rules.json` only if the missing skill is critical (review gates/safety) and NOT classified LAYERED
- **After returning from Stage 3 or Stage 4:** Apply Steps 2.1b–2.1e to each newly generated skill before proceeding to Step 2.5. The first-bootstrap note in Step 1 does not exempt this return trip — all newly generated skills must pass the full audit.

  **Return path:** After generating missing skills in Stage 3 or Stage 4, re-enter Stage 5 at Step 2.1a. Apply 2.1a through 2.1g to each newly generated skill. Append the new audit findings (PASS/REWRITE_DESC/etc.) to the existing audit results from the original pass. Proceed to Step 2.5 only after all newly generated skills have completed the full audit sub-steps.

  ⚠️  One return trip only: if Step 2.4 still shows missing skills after returning from Stage 3 or Stage 4, document the remaining gaps in the reconciliation report and proceed to Step 2.5 rather than making another return trip. Do not loop.

---

## 2.5: Generate Reconciliation Report

**Before making changes, present summary:**

```
=== Skill Reconciliation Report ===

CURRENT (no changes needed): [count]
  - [skill-name]: triggers verified ✓

EVOLVED MINOR (autonomous — no confirmation needed): [count]
  - [skill-name]: updated consistency % and 2 stale file:line refs
EVOLVED MAJOR (requires confirmation before executing): [count]
  - [skill-name]: implementation guide rewrite — new canonical pattern replaces old

STALE (decision required): [count]
  - [skill-name]: pattern not found in analysis
    → Recommendation: [DELETE/DEPRECATE/KEEP] because [reason]

UNREGISTERED CRITICAL (adding triggers): [count]
  - [skill-name]: critical skill, adding to skill-rules.json

MISSING (need to generate in Stage 3): [count]
  - [skill-name]: recommended by analysis, not yet created

---

Summary:
- Skills to update: [count]
- Skills to potentially remove: [count]  
- Critical skills to add triggers: [count]
- Skills to create: [count]

Proceed with reconciliation? (Review above before continuing)
```

**Wait for user confirmation before:**
- Deleting any skills
- Making major content changes to EVOLVED skills

---

## 2.6: Execute Reconciliation

After user approval, make changes for each skill category:

- **CURRENT:** Verify triggers still match current codebase terminology. Update `skill-rules.json` keywords if they've drifted.
- **EVOLVED:** Edit `SKILL.md` to reflect updated patterns, new failure modes, or changed canonical examples. Update `skill-rules.json` triggers if needed. For significant content changes, confirm with user before applying.
- **EVOLVED (mirror update):** After editing `.claude/skills/[name]/SKILL.md`, re-sync `.agents/skills/[name]/SKILL.md` by running `cp .claude/skills/[name]/SKILL.md .agents/skills/[name]/SKILL.md && perl -pi -e 's/CLAUDE\.md/AGENTS.md/g' .agents/skills/[name]/SKILL.md` and verify clean.
- **STALE (DELETE approved):** Remove the skill directory from all locations, delete its entry from `skill-rules.json`, and clean up side effects:
  ```bash
  trash .claude/skills/[name]
  rm -rf .agents/skills/[name]
  rm -rf .codex/skills/[name] 2>/dev/null || true  # optional compatibility mirror

  # Remove skill's guardrail lines from CLAUDE.md and AGENTS.md
  perl -pi -e '/^#\s+\Q[name]\E:/ && next' CLAUDE.md AGENTS.md

  # Remove skill's entry from skill-rules.json (if present)
  if [ -f ".claude/skills/skill-rules.json" ] && command -v jq >/dev/null 2>&1; then
      jq 'del(.skills["[name]"])' .claude/skills/skill-rules.json > /tmp/_sr_clean.json && \
      mv /tmp/_sr_clean.json .claude/skills/skill-rules.json
      # Validate JSON syntax after removal
      jq . .claude/skills/skill-rules.json > /dev/null 2>&1 || echo "ERROR: skill-rules.json is invalid JSON after removing [name]"
  fi
  ```
- **UNREGISTERED critical:** Add a trigger entry to `.claude/skills/skill-rules.json` following the format in Stage 3 (see review-gates example).

---

# Stage 5 Complete

All audit steps (2.1a–2.1g, 2.2–2.6) executed. Proceed to Stage 6 — run `/bootstrap-complete`.
