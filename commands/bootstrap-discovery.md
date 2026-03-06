---
name: bootstrap-discovery
description: "Stage 1: Analyze codebase to discover patterns, conventions, and architecture. Run after Stage 0 (discovery-commands.sh)."
---

# Stage 1: Discovery & Analysis

You are analyzing this codebase to discover patterns, conventions, architecture, and historical issues using traditional analysis tools (grep, file reading, git history).

# Your Mission

Analyze this codebase across the discovery areas below and save findings to `.claude/discovery/analysis.yaml` for use in Stage 2. Stage 2 uses this analysis to generate the project's `CLAUDE.md` and `AGENTS.md` configuration files and project-specific skills.

---

# Prerequisites

Before starting, verify the ground truth data file exists:

```bash
cat .claude/discovery/raw_data.txt
```

**If the file doesn't exist**, stop here and ask the user to run Stage 0 first:
```
The ground truth data file is missing. Please run Stage 0:
  mkdir -p .claude/discovery
  bash "$ENG_TEAM_DIR/discovery-commands.sh" > .claude/discovery/raw_data.txt
Then restart Stage 1.
(Set ENG_TEAM_DIR to the path of your local claude-eng-team/ folder.)
```

**If the file exists but is empty or under 100 bytes**, warn that Stage 0 may have
failed and suggest re-running discovery-commands.sh:
```
raw_data.txt exists but appears empty or truncated (under 100 bytes).
Stage 0 may have failed silently. Please re-run:
  bash "$ENG_TEAM_DIR/discovery-commands.sh" > .claude/discovery/raw_data.txt
Then restart Stage 1.
(Set ENG_TEAM_DIR to the path of your local claude-eng-team/ folder.)
```

**If the file exists and is valid but missing a Domain Classification section**, warn:
```
Stage 0 ran but may have produced incomplete output — Domain Classification section not found in raw_data.txt.
Re-run to ensure domain-adaptive discovery works correctly:
  bash "$ENG_TEAM_DIR/discovery-commands.sh" > .claude/discovery/raw_data.txt
(Set ENG_TEAM_DIR to the path of your local claude-eng-team/ folder.)
```
To detect: `grep -qi "domain classification" .claude/discovery/raw_data.txt || echo "missing"`

**If the file exists and is valid**, proceed immediately through all discovery areas below.

---

## Domain-Adaptive Discovery

Read the Domain Classification, Tech Stack Detection, and Warehouse/Platform Context
sections from raw_data.txt. Use these signals to determine what kind of project this
is and adapt your discovery approach accordingly.

The discovery areas below show generic grep examples that calibrate the expected depth
and format. For each detected domain, derive your own domain-appropriate grep patterns
at the same level of specificity. Do not wait for the prompt to enumerate every
possible pattern — use the detected tools and frameworks from raw_data.txt to construct
targeted searches yourself.

**Supplementing knowledge with research:** Your training data has a cutoff and may lack
current patterns for newer tools (e.g., recent framework versions, new BI platforms,
emerging AI/LLM libraries). When you encounter a tool or framework you are uncertain
about, use available MCP research tools to fill gaps:
- **Context7** (`resolve-library-id` → `query-docs`): Look up current documentation and
  code examples for specific libraries detected in the stack.
- **Exa** (`web_search_exa`, `get_code_context_exa`): Search for current best practices,
  conventions, and common pitfalls for detected tools.

Use research judiciously — only when your existing knowledge is insufficient for a
detected tool. Do not research well-known frameworks (React, Django, dbt) unless the
version detected is significantly newer than your training data.

Record detected domains in analysis.yaml as project_domains (list). A project can
have multiple domains. Domain values are not limited to a fixed list — use whatever
labels accurately describe the project (common values: software, data-analytics, ml-ds,
data-engineering, ai-llm, mobile, financial-analytics, content).

---

# Execution Directives

**No mid-run confirmation needed** — the user has already consented to the discovery scope (the Prerequisites section above is the only mandatory gate). Work through all discovery areas in order and generate `analysis.yaml` without pausing for additional confirmation. If a discovery area yields no results, record an empty array and continue.

**Sample broadly** — exhaustive inventories waste context and add marginal value. Aim for representative evidence, not complete inventories. For each discovery area, run searches, read samples, record findings, and move on.

**Overwrite warning:** If `analysis.yaml` already exists, read it first. The file will be fully replaced — there is no partial merge.
To preserve the previous run, copy it first: `cp .claude/discovery/analysis.yaml .claude/discovery/analysis.yaml.bak`

**Parallelization:** Where discovery areas are independent, parallelize grep searches.

**Cleanup:** Remove any temporary files created during discovery.

**Prioritize execution over deliberation.** Choose one approach and start recording findings immediately. Do not compare alternatives or plan the entire discovery before running searches. Write each discovery area's findings once; do not go back to revise or expand. If uncertain about a pattern, make a reasonable interpretation and continue. Only course-correct if you encounter a concrete contradiction.

**After writing analysis.yaml, verify:**
- Verify analysis.yaml is valid YAML:
  ```bash
  yq . .claude/discovery/analysis.yaml > /dev/null 2>&1 && echo "Valid YAML (via yq)" || \
  python3 -c "import yaml; yaml.safe_load(open('.claude/discovery/analysis.yaml'))" 2>/dev/null && echo "Valid YAML (via python3)" || \
  echo "⚠️  Could not verify — install yq (brew install yq) or PyYAML (pip install pyyaml)"
  ```
- `tech_stack` findings match the baseline in `raw_data.txt`
- Every discovery area section is populated or explicitly contains an empty array
- All file citations reference real paths

---

# Discovery Tools

## 0. Ground Truth Data (Baseline)
The user has already run the discovery script. Read `.claude/discovery/raw_data.txt` for deterministic ground truth about the tech stack, frameworks, and file counts.

**How to use raw_data.txt:**
- Use as baseline evidence for tech stack, frameworks, and file counts
- Cross-reference these findings with your grep/read analysis
- Incorporate verified data into `analysis.yaml` (e.g., framework detection → `tech_stack` section)
- The file is saved for audit purposes; Stage 2 only reads `analysis.yaml`

## 1. Grep (Text Search) - Primary
Use for:
- Finding patterns by exact strings or regex
- Counting files matching patterns
- Locating implementations by keywords
- Quantifying consistency across codebase

## 2. Glob/Read (File Exploration) - Context
Use for:
- Finding files by extension or name pattern
- Reading actual implementations
- Understanding file organization
- Sampling code for pattern analysis

## 3. Git History - Failure Mining
Use for:
- Failure mode discovery
- Pattern evolution over time
- Commit-based evidence for pitfalls

**Strategy:** Read ground truth data first for a baseline, then use grep/read for pattern discovery, and git for failure context.

---

# Discovery Areas

## 1. Tech Stack Discovery

> **Why:** Stage 2A populates Tech Stack section from these findings.

**File-based detection:**
- Read package.json, requirements.txt, pyproject.toml, go.mod, etc.
- Check for config files (.eslintrc, tsconfig.json, etc.)
- Count files by extension for language distribution

**Grep patterns:**
```bash
# Count files by type
find . -name "*.ts" -not -path "*/node_modules/*" | wc -l
find . -name "*.py" -not -path "*/.venv/*" | wc -l

# Find config files
find . -maxdepth 3 -name "*.config.*" -o -name ".*rc" -o -name "tsconfig*"

# Identify frameworks from imports
grep -r "from 'react'" --include="*.tsx" | head -5
grep -r "from django" --include="*.py" | head -5
```

For each detected domain, derive targeted searches from the tools/frameworks listed in
raw_data.txt. Read config files, count domain-specific file types, identify framework
imports. **Save exact versions where found.**

## 2. Architecture Analysis

> **Why:** Stage 2A generates Overview and Code Conventions sections; Stage 2C creates codebase-overview skill.

**Directory structure:**
```bash
# Understand project layout
find . -type d -maxdepth 3 -not -path "*/node_modules/*" -not -path "*/.git/*"

# Identify entry points
find . -name "main.*" -o -name "index.*" -o -name "app.*" | head -20
```

**Pattern detection:**
```bash
# Find API endpoints
grep -r "router\." --include="*.ts" --include="*.py" | head -20
grep -r "@app\.(get|post|put|delete)" --include="*.py" | head -20
grep -r "app\.(get|post|put|delete)" --include="*.ts" | head -20

# Find database operations
grep -r "\.query\|\.execute\|\.find\|\.save" --include="*.ts" --include="*.py" | head -20

# Find auth patterns
grep -r "auth\|jwt\|session\|token" -i --include="*.ts" --include="*.py" | head -20
```

For each detected domain, run architecture-appropriate pattern searches (e.g., data
lineage for analytics, DAG structure for pipelines, agent/chain classes for AI/LLM,
navigation stacks for mobile). Use the same depth as the generic patterns above.

**Analysis:**
- Map data flow (software: across components; data: lineage from sources to outputs)
- Identify layers (software: frontend/backend; dbt: staging/intermediate/marts; ML: data/features/training/serving)
- Understand boundaries (software: services; pipelines: DAG structure; ML: model boundaries)

**Read actual code to verify grep findings.**

## 3. Code Convention Discovery

> **Why:** Stage 2C generates the code-conventions skill directly from these patterns.

**Pattern detection:**
```bash
# Find test files
find . -name "*.test.*" -o -name "*.spec.*" -o -name "test_*" | head -20

# Find error handling patterns
grep -r "try\|catch\|except\|throw\|raise" --include="*.ts" --include="*.py" | head -30

# Find logging patterns
grep -r "console\.\|logger\.\|logging\." --include="*.ts" --include="*.py" | head -20

# Find validation code
grep -r "validate\|schema\|zod\|yup\|pydantic" --include="*.ts" --include="*.py" | head -20
```

**Look for:**
- Naming conventions (files, functions, variables)
- Import ordering patterns
- Export styles (named vs default)
- Error handling approaches
- Logging patterns

**Sample 3-5 files from each pattern category to verify consistency.**

## 4. Workflow Analysis

> **Why:** Stage 2A generates Workflow and Commands sections from these findings.

**Discover:**
- Git workflow (feature branches, trunk-based, gitflow)
- CI/CD configuration (.github/workflows, .gitlab-ci.yml, etc.)
- Deployment process
- Code review patterns (CODEOWNERS, PR templates)
- Environment configuration (.env.example, config files)
- **Runnable commands:** Extract from `package.json` scripts, `Makefile` targets, `pyproject.toml [tool.scripts]`, or similar build files. Map to the `commands` section as: `build`, `test`, `lint`, `dev`.

```bash
# Check git workflow
git branch -a | head -20
git log --oneline --graph | head -30

# Find CI/CD
find . -name "*.yml" -path "*/.github/*" -o -name ".gitlab-ci.yml" -o -name "Jenkinsfile"

# Find environment configs
find . -name ".env*" -o -name "config*.json" -o -name "settings*.py" | head -10
```

For detected domains, search Makefile/README/scripts for domain-specific commands (e.g.,
`dbt run`, `airflow`, `expo start`, evaluation scripts).

## 5. Testing Strategy

> **Why:** Stage 2C incorporates test patterns into review-gates and code-conventions skills.

**Identify:**
```bash
# Find test patterns
grep -r "describe\|it\(\|test\(\|def test_" --include="*.ts" --include="*.py" --include="*.js" | head -30

# Find mocking patterns
grep -r "mock\|jest\|patch\|fixture" -i --include="*.ts" --include="*.py" | head -20

# Test file organization
find . -type d -name "__tests__" -o -name "tests" -o -name "test"
```

- Unit test patterns
- Integration test patterns
- Test file organization
- Mocking strategies
- Test data management

For detected domains, search for domain-appropriate test patterns (e.g., dbt schema
tests, ML evaluation metrics, DAG validation, reconciliation checks, LLM mocking).

## 6. Patterns

> **Why:** Stage 2C generates pattern-specific skills from service patterns.

**Find:**
```bash
# Service/module structure
find . -name "*service*" -o -name "*repository*" -o -name "*controller*" | head -20

# Dependency injection
grep -r "inject\|@Injectable\|Container\|provider" --include="*.ts" --include="*.py" | head -20

# Configuration management
grep -r "config\|settings\|env\." --include="*.ts" --include="*.py" | head -20

# Background jobs
grep -r "queue\|worker\|job\|cron\|celery\|bull" -i --include="*.ts" --include="*.py" | head -20

# Caching
grep -r "cache\|redis\|memcache" -i --include="*.ts" --include="*.py" | head -20
```

For detected domains, search for domain-specific patterns (e.g., materialization
strategies, experiment tracking, scheduling, agent/chain architecture, navigation
structure, financial computation patterns).

## 7. Domain Understanding

> **Why:** Stage 2A populates Project Context section; Stage 2C may generate domain skills.

**Infer from code:**
- What does this application do?
- Core domain models
- Business logic patterns
- Critical paths and workflows

```bash
# Find domain models
find . -name "*model*" -o -name "*entity*" -o -name "*schema*" | head -20

# Infer business domain from code
grep -r "class\|def\|function\|interface" --include="*.ts" --include="*.py" \
  --include="*.js" | grep -i "user\|order\|product\|task\|invoice\|payment\|event" | head -30

# Read README for purpose description
[ -f README.md ] && head -50 README.md || echo "(no README)"
[ -f docs/README.md ] && head -30 docs/README.md || true

# Find main entry points and read them
find . -name "main.*" -o -name "index.*" -o -name "app.*" | \
  grep -v node_modules | grep -v ".git" | head -5

# Read key files to understand purpose
# (Use Read tool on README, main entry points, and model files)
```

## 8. Security Discovery

> **Why:** Stage 2C generates security-review-gates skill from these findings.

**Grep patterns:**
```bash
# Find hardcoded secrets/credentials patterns
grep -r "password\|secret\|api_key\|apikey\|token" -i --include="*.ts" --include="*.py" --include="*.js" --include="*.env*" | head -20

# Find network access patterns
grep -r "fetch\|axios\|http\|request\|curl" -i --include="*.ts" --include="*.py" | head -20

# Find permission boundaries
grep -r "role\|permission\|authorize\|rbac\|acl" -i --include="*.ts" --include="*.py" | head -20
```

For detected domains, search for domain-specific security concerns (e.g., warehouse
credentials, PII in SQL, API key management, prompt injection, DAG connection
security, mobile secure storage).

**Document:**
- Authentication mechanisms used
- Secret management approach
- Network access patterns (external APIs, services)
- Permission boundaries and access control
- Security-sensitive code areas

## 9. Consistent Terminology Detection

> **Why:** Stage 2C uses preferred terms consistently across all generated skills.

**Detect inconsistent terminology:**
```bash
# Example: Check if "endpoint" vs "route" vs "handler" vs "path" are used inconsistently
grep -r "endpoint\|route\|handler\|path" --include="*.ts" --include="*.py" | head -30
```

For each detected domain, identify the domain's key vocabulary and check for
inconsistent usage across the codebase.

**Document:**
- Identify cases where the same concept uses different terms
- Record the preferred term for each concept
- Note files/areas where inconsistent terms appear
- Add preferred terminology to `analysis.yaml` for use in skill generation

## 10. Known Historical Failures

> **Why:** Stage 2A populates Known Pitfalls section; Stage 2C adds pitfalls to relevant skills.

**Git history mining:**
```bash
git log --all --oneline -i --extended-regexp --grep="fix|bug|hotfix|revert" | head -50
git log --all --oneline -i --extended-regexp --grep="N+1|performance|security" | head -30
```

**For each significant fix:**
1. Get commit details: `git show <commit-hash>`
2. Search for similar patterns in current code:
   ```bash
   grep -r "<pattern from fix>" --include="*.ts" --include="*.py"
   ```
3. Assess if the issue might exist elsewhere

For detected domains, extend the grep file types and commit keywords appropriately
(e.g., add `--include="*.sql"` for analytics, search for domain-specific failure terms
like "overfit", "backfill", "crash", "reconcil" based on the stack).

**Document each failure with:**
- Commit hash
- What went wrong
- Root cause
- Files affected
- Similar pattern check results
- Risk assessment (high|medium|low)
- How to prevent
- Recommended skill (skill-name this failure should be documented in, or `new` if a dedicated prevention skill is needed)
- review_gate_variant: general|security|performance (only when recommended_skill is a review-gate type — omit otherwise)

## 11. Global Skills & Agents Inventory (Deduplication)

> **Why:** Stage 2C uses these lists to skip project skills that would duplicate global coverage. Global skills/agents already provide domain expertise -- do not recommend project-level skills that duplicate what globals already cover. Inventory them here so Stage 2C can skip redundant generation.

**Inventory global skills:**
```bash
echo "=== Global Skills Inventory ==="
for skill_dir in ~/.claude/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
        skill_name=$(basename "$skill_dir")
        # Extract full multi-line description from YAML frontmatter
        # (description may span multiple lines with > or indentation)
        desc=$(sed -n '/^description:/{s/^description: *[>|]//;s/^description: *//;p;:loop;n;/^[a-z]/q;/^---/q;s/^  *//;p;b loop}' "${skill_dir}SKILL.md" | tr '\n' ' ' | sed 's/  */ /g;s/^ *//;s/ *$//')
        echo "- ${skill_name}: ${desc}"
        echo "  [path: ${skill_dir}SKILL.md]"
    fi
done
```

> **IMPORTANT — Global path only:** The loop above uses `~/.claude/skills/*/` (the user's HOME directory). Do NOT read from `.claude/skills/` (project-local). During a re-bootstrap, project-local `.claude/skills/` may contain skills from a previous run — these are project skills, not global ones, and must not appear in `global_skills_available`.

**Inventory global agents:**
```bash
echo "=== Global Agents Inventory ==="
for agent_file in ~/.claude/agents/*.md; do
    if [ -f "$agent_file" ]; then
        agent_name=$(basename "$agent_file" .md)
        desc=$(sed -n '/^description:/{ s/^description: *//; p; q; }' "$agent_file")
        echo "- ${agent_name}: ${desc}"
    fi
done
```

**Inventory Codex global skills (if available):**
```bash
echo "=== Codex Global Skills Inventory ==="
# Guard: $CODEX_HOME may be unset; use parameter expansion to avoid bad glob
if [ -z "$CODEX_HOME" ]; then
    echo "(CODEX_HOME not set — skipping \$CODEX_HOME/skills; checking ~/.codex/skills/ only)"
fi
for skill_dir in ${CODEX_HOME:+"$CODEX_HOME"/skills/*/} ~/.codex/skills/*/; do
    if [ -f "${skill_dir}SKILL.md" ]; then
        skill_name=$(basename "$skill_dir")
        desc=$(sed -n '/^description:/{s/^description: *[>|]//;s/^description: *//;p;:loop;n;/^[a-z]/q;/^---/q;s/^  *//;p;b loop}' "${skill_dir}SKILL.md" | tr '\n' ' ' | sed 's/  */ /g;s/^ *//;s/ *$//')
        echo "- ${skill_name}: ${desc}"
    fi
done
```

**Record all lists in analysis.yaml** (see output format below). Stage 2C uses these to skip project skills that would duplicate global coverage. For each global skill, derive the `covers` field from the description extracted by the bash loop above — do NOT read individual skill files for this step:

```yaml
  covers:
    - "[primary domain]"
    - "[secondary domains, technologies, or task types covered]"
```

Aim for 3–6 meaningful covers entries per skill. Err toward specificity rather than broad labels. The bash output already contains the full description — use that text to derive covers. Do not open skill files separately.

---

# Analysis Instructions

## Evidence Standards

Report findings with grep counts, file citations (file:line), consistency percentages, and commit hashes for failures. Stage 2 generates project skills directly from this output — uncited or vague evidence produces skills that don't match real code.

## Pattern Classification

For each critical pattern discovered, classify `pattern_type` as one of: `reference`, `workflow`, `review-gate`, `domain-pattern`, `failure-prevention`, `dynamic-context`, `visual-output`, `template`, `io-examples`. Optionally set `review_gate_variant` (only when `pattern_type` is `review-gate`) to one of: `"general"`, `"security"`, `"performance"`. Stage 2C uses these fields to route content to the correct review-gate skills.

Also set `recommended_skill` on the category entry to the skill name that should encode this pattern (e.g., `api-patterns`, `auth-patterns`, `auth-review-gates`).

The same `review_gate_variant` field (general|security|performance) applies to `historical_failures` entries when `recommended_skill` is a review-gate variant — set it there too.

Example:
```
API Endpoint Pattern:
- Found 23 endpoint implementations
- Main pattern (18 files): /api/v1/{resource}
- Variant (5 files): Legacy /api/{resource} pattern
- Grep verification: 18 of 23 files (78%) follow current pattern
- Evidence: src/routes/tasks.ts:12, src/routes/users.ts:8 (canonical examples)
- Variant reason: Pre-v2 API, maintained for backwards compatibility
```

```yaml
# Example analysis.yaml entry after Stage 1:
critical_patterns:
  - category: "API Endpoint Pattern"
    pattern_type: "review-gate"
    review_gate_variant: "general"
    recommended_skill: "review-gates"
    patterns:
      - description: "RESTful /api/v1/{resource} structure"
        consistency: "78%"
        file_count: 23
        canonical_examples:
          - "src/routes/tasks.ts:12"
          - "src/routes/users.ts:8"
        variant_reason: "5 legacy /api/{resource} endpoints maintained for backwards compatibility"
```

---

# Output Format

First, load the schema into context:
```bash
cat ${ENG_TEAM_DIR:-~/claude-eng-team}/analysis-schema.yaml 2>/dev/null || echo "⚠️  Schema file not found at ${ENG_TEAM_DIR:-~/claude-eng-team}/analysis-schema.yaml. Set ENG_TEAM_DIR to your local claude-eng-team/ path and verify the file exists. Required top-level sections: metadata, tech_stack, architecture, code_conventions, critical_patterns, historical_failures, domain_understanding, project_domains, commands, recommendations."
```

Create `.claude/discovery/analysis.yaml` using the schema at `${ENG_TEAM_DIR:-~/claude-eng-team}/analysis-schema.yaml`. If the schema file was not found above, use these required top-level sections as guidance: `metadata`, `tech_stack`, `architecture`, `code_conventions`, `critical_patterns`, `historical_failures`, `domain_understanding`, `project_domains`, `commands`, `recommendations`. Match the structure of the example entries in the discovery areas above.
- Set `discovery_method` to `"traditional"`
- Set `project_domains` to detected domains:
  ```yaml
  project_domains:
    # Detection-driven — set based on what the codebase shows.
    # Common values: software, data-analytics, ml-ds, data-engineering,
    # ai-llm, mobile, financial-analytics. Not limited to this list.
    - "[detected domain]"
  ```
- Omit the `serena_insights` block, `serena_similarity` on patterns, and `serena_similarity_score` on historical failures (fields marked `# [Serena-only]` in analysis-schema.yaml)
- Replace all `[placeholder]` values with your findings

**Deferred fields:** The following fields are populated by later stages — leave them empty or omit from Stage 1 output: `skill_details`, `mechanism_classification`, `priority_patterns`, `priority_failures`, `evaluation_scenarios`.

---

# Execution Summary

After generating analysis.yaml, show:

```
Discovery Complete: [Project Name]

Tech Stack: [Primary language] [version] + [Framework] [version]
Architecture: [Pattern]
Files Analyzed: [Count]
Patterns Found: [Count] (verified with grep)
Historical Issues: [Count] (from git + similar pattern check)

Critical Patterns:
1. [Pattern] - [X]% consistency
2. [Pattern] - [X]% consistency
3. [Pattern] - [X]% consistency

Known Historical Failures:
1. [Failure] - [commit] - Similar code found: [count] files
2. [Failure] - [commit] - Similar code found: [count] files
3. [Failure] - [commit] - Similar code found: [count] files

Discovery Limitations (documented in analysis.yaml):
- Only existing patterns discovered
- Git history = past failures only
- Implicit conventions may be missed

Global Coverage (skip project skills that duplicate these):
- Global agents: [List from ~/.claude/agents/]
- Global skills: [List from ~/.claude/skills/]
- Codex global skills (if present): [List from $CODEX_HOME/skills and ~/.codex/skills]

Recommendations (after deduplication):
- Review Workflows (agents in Claude Code / skills in Codex): [List global agents found]
- Skills to Create: [List - only skills NOT covered by globals]
  - Core: codebase-overview, code-conventions, review-gates
  - Pattern skills: [Based on critical patterns — excluding those covered by global skills]
  - Domain skills: [Business logic, product domains — excluding those covered by global skills]
- Skipped (covered by global skills): [List any recommended skills that were dropped due to global coverage]

Evaluation Scenarios: Deferred to Stage 2C

Analysis saved to: .claude/discovery/analysis.yaml
Inventory age note: The global skills inventory captured above is frozen at discovery time. Stage 2C will use it for deduplication decisions. If global skills change before Stage 2C runs, Stage 2C's Step 6a live-check fallback can update the inventory — but only if the `global_skills_available` section is entirely absent from analysis.yaml. For time-sensitive bootstraps (>1 day between Stage 1 and Stage 2), consider re-running Stage 1 discovery.

Next: Proceed to Stage 2A (Core Configuration) and run bootstrap-stage2a-core-config_prompt.md
```

**Greenfield check:** If more than half of the discovery areas produced empty arrays, append this warning to the summary:

> ⚠️  Sparse discovery — most discovery areas returned no results.
> This is expected for greenfield projects or repos with minimal code/history.
> Bootstrap will produce placeholder content (TBD). Consider:
> - Establishing patterns through initial development first
> - Re-bootstrapping after the codebase has meaningful code and git history

