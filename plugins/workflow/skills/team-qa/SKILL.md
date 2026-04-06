---
name: team-qa
description: >
  Invoke after /team-build is approved. Runs validation checks on changed files (denoise + parallel
  validators including Codex adversarial cross-model review). Do NOT run QA checks manually — this
  skill has validator isolation, finding classification, and selective re-run logic that only load
  when invoked.
version: 2.0.0
---

# /team-qa — Post-Build Validation Pipeline

## What This Skill Does

Runs the built implementation through a structured validation pipeline. Six checks in two phases:
denoise first (sequential), then style + doc + security + performance + Codex adversarial (parallel).
Each Claude validator is scoped — only changed files + the one relevant skill. The Codex adversarial
pass attacks the git diff with cross-model framing focused on auth/data-loss/race-condition failure modes.

**Key principle:** "Each validator gets ONLY what it needs." Claude validators get changed files +
one project skill. Codex gets the git diff. Less context per validator = fewer false positives.

**Cross-model coverage:** Validators A-D run on Claude. Validator E runs on Codex (OpenAI). The
adversarial cross-model pass catches failure modes Claude validators tend to miss (or rationalize away).

**Output:** QA report classifying all findings (see `references/qa-report-template.md`)
**NOT output:** The fixes themselves — findings go back to the user or loop to a fix pass

## Prerequisites

A completed build — either from `/team-build` or an implementation the user wants to validate.

**If no changed files are identifiable:** Ask the user to specify which files to validate.

## When to Use

- After `/team-build` is approved and before shipping/merging
- When validating any implementation against project standards
- Do NOT auto-trigger — the user types `/team-qa` to invoke

## Selective Re-run (`--only`)

After fixing one finding, you don't need to re-run the entire pipeline. Use `--only` to target a single validator:

```
/team-qa --only denoise      # Phase 1 only
/team-qa --only style        # Validator A only
/team-qa --only docs         # Validator B only
/team-qa --only security     # Validator C only
/team-qa --only perf         # Validator D only
/team-qa --only codex        # Validator E only (Codex adversarial)
```

When `--only` is present: **skip to the named validator directly** (still read the changed files list from Step 1 first). All other validators are skipped for this run.

Use `--only` after fixing a specific MUST-FIX finding to confirm it's resolved without re-running the entire pipeline.

---

## Process

### Step 1: Identify Changed Files

Get the definitive list of files to validate. Check in order:

1. **From `/team-build` plan** — the plan's file ownership map is the authoritative list of what changed
2. **From git** if no plan is available:
   ```bash
   git diff --name-only main...HEAD   # all changes on this branch vs main
   # or
   git diff --name-only HEAD~1        # just the last commit
   ```
3. **From user** if neither is available — ask explicitly

Group changed files by type for targeted routing:
- **API/backend:** routes, controllers, services, middleware
- **Frontend:** components, pages, hooks, styles
- **Data layer:** migrations, schemas, ORM models, raw SQL queries
- **dbt / SQL models:** staging, intermediate, mart, metric models (.sql in models/)
- **Pipelines / DAGs:** Airflow DAGs, Dagster jobs, Prefect flows, orchestration YAML
- **Notebooks:** Jupyter notebooks (.ipynb), analysis scripts
- **ML / feature code:** model training, feature engineering, evaluation scripts
- **Metrics / dashboards:** LookML, metric YAML definitions, dashboard configs
- **Config:** env files, build config, package changes
- **Tests:** new or modified test files
- **Docs:** README, API docs, changelogs
- **LLM integration:** `*_client.py`, `anthropic*.py`, `openai*.py`, prompt template files, `evals/`, `*.eval.py`, evaluation harnesses — route to `llm-engineering`
- **Agentic systems:** agent loop files, `mcp_server.py`, MCP tool definitions, orchestrator/worker patterns, multi-agent config YAML — route to `agentic-systems`
- **Financial models:** GL tables, chart-of-accounts models, reconciliation scripts, period-close queries, regulatory report outputs, billing models
- **Mobile screens/components:** `.tsx` files in `app/`, `screens/`, `components/` with React Native imports
- **Native modules:** `*.podspec`, Android bridge files, native module wrappers
- **Mobile config:** `app.json`, `app.config.js/ts`, `eas.json`

This grouping determines which validators are relevant. A pure frontend change skips DB performance checks. A pure config change skips most validators.

### Step 2: Load Project Skills

Identify which project-level QA skills exist. Check:
```bash
ls .claude/skills/
```

Look for:
- `code-conventions` — project style and convention rules (load this into Validator A)
- `review-gates` — general quality gates
- `security-review-gates` — project-specific security rules
- `performance-review-gates` — project-specific performance rules

Note which exist and which are missing. For missing skills, fall back to the baseline checklists
in this skill's `references/` directory.

### Project Scope Routing

1. Read `.claude/project-scope.md` if it exists.
   - If not found: run the 6-file discovery scan inline (see `/team-brief` Step 1b).
     Write scope file for future use.
2. Load all skills in `relevant_global_skills`.
3. If `relevant_global_skills` is empty: calibrate validators using `quality_gates`
   and `security_surface` fields from scope file (not free-form description alone).
   Each validator receives the relevant fields as its domain context.

### Multi-Domain File-Type Resolution

When multiple domain skills are loaded (e.g., software-engineering + data-science):
- The scope file determines which skills to load (the candidate set).
- The file-type routing table (Validator Routing by File Type, below) determines which
  loaded skill applies to each specific file.
- A `.py` API handler file: software-engineering checks apply; data-science checks do not.
- A `.ipynb` notebook: data-science checks apply; software-engineering checks do not.
- Skills not in the loaded set never apply, even if a file-type pattern matches.

Doc Freshness (B) applies universally — check for stale model descriptions (dbt `schema.yml`),
missing docstrings, outdated metric definitions, missing source freshness metadata.

Denoise applies to all file types with domain-specific additions (see denoise checklist).

### Phase 1: Denoise (Sequential — Run First)

**Run before all other validators.** Checking style or security on noisy code wastes effort.

Read every changed file directly. Apply `references/denoise-checklist.md`. Flag:

- **Unused imports** — imported but never referenced in the file
- **Dead code** — functions, variables, or exports declared but never called within scope
- **Debug artifacts** — `console.log`, `print`, `debugger`, `breakpoint()`, `binding.pry`, etc.
- **Hardcoded test values** — magic strings/numbers that look like test data (`"test@example.com"`, `userId: 123`, `password: "password"`)
- **Commented-out code blocks** — large blocks of commented code (not doc comments)
- **TODO/FIXME without owner** — `// TODO` with no name or ticket reference
- **Temp files** — `.tmp`, `scratch.*`, `test2.ts`, anything that looks like iteration debris
- **Hardcoded dates/limits in SQL** — `WHERE date >= '2024-01-01'`, `LIMIT 10` left in production queries
- **Notebook debris** — uncleared cell outputs, hardcoded file paths (`/Users/.../data/`), scratch cells
- **Pipeline test values** — dev connection strings, test schedule intervals, disabled tasks
- **Hardcoded fiscal year cutoffs in financial SQL** — `WHERE fiscal_year = 2024` or similar absolute fiscal year references in GL models, reconciliation scripts, or period-close queries

Present findings as a list with file:line. For each:
- **Auto-safe removals** (unused imports, debug logs, temp files): propose removing immediately
- **Judgment calls** (dead code, commented blocks): show the code, ask user to confirm removal

Wait for user to approve/deny each item before proceeding to Phase 2.

**Gate:** Denoise must complete before Phase 2 starts. A clean codebase produces cleaner validator output.

### Phase 2: Parallel Validators

Launch all applicable validators simultaneously (A, B, C, D, E — five validators in parallel).
Skip validators with no relevant changed files (e.g., skip performance DB checks if no data-layer
files changed). Skip Validator E (Codex) only if Codex is unavailable or the diff has no code changes.

---

#### Validator A: Style Audit

**Context:** Changed files + `code-conventions` project skill (or equivalent)

Spawn via Task tool (`model: "sonnet"`):

```
You are performing a style audit on recently changed files.

Load the project conventions skill: .claude/skills/code-conventions/SKILL.md
(If it doesn't exist, apply general conventions for the project's primary language)

Changed files to audit: [list from Step 1]

IMPORTANT — Pre-existing vs. introduced classification:
For files that were MODIFIED (not newly created), run `git diff main...HEAD -- <file>` to get
the diff (replace `main` with the project's actual base branch if different, e.g., `staging`).
Only classify a finding as INTRODUCED if the violating code appears in the diff's added lines
(lines starting with +). If the violation exists in unchanged lines, classify it as PRE-EXISTING.
Report both categories separately.
For newly created files, classify all violations as INTRODUCED.
If git is unavailable in this context, classify all findings from MODIFIED files as PRE-EXISTING
(conservative fallback — do not penalize for issues that may predate this change) and note that diff was unavailable.

Check each file against the loaded conventions/domain skill for:
- Naming conventions (variables, functions, models, columns, metrics — per loaded skill)
- Import / dependency ordering (imports, ref/source calls, macro usage)
- File and model structure conventions
- Function, method, and model signature patterns
- Documentation style (doc comments, model descriptions, column descriptions, metric definitions)
- Error handling and data validation patterns
- Any project-specific or domain-specific rules in the loaded skill

For each violation: file:line | convention violated | what's there | what it should be | INTRODUCED or PRE-EXISTING
For each pass: do not list — only report violations.
End with a count: [N] violations found ([M] introduced, [P] pre-existing).
```

---

#### Validator B: Doc Freshness

**Context:** Changed files only (no project skill needed — this is structural)

Run inline (Claude reads files directly):

1. For each changed file, identify:
   - Exported functions, classes, or types with changed signatures
   - Changed API endpoints (new routes, modified params/responses)
   - Changed configuration options or environment variables
   - Changed CLI commands or public interfaces

2. For each identified change, check:
   - Is there a corresponding doc comment / JSDoc / docstring on the changed symbol?
   - Is there a README section that references this? Is it current?
   - Is there a CHANGELOG entry (if the project uses one)?
   - Is there API documentation (OpenAPI, Swagger, etc.) that needs updating?

3. Report stale docs with: what changed | where the stale doc lives | what needs updating

---

#### Validator C: Security Review

**Context:** Changed files + security-review-gates project skill (if it exists)

**Decision:** Use the `security-reviewer` agent for all auth-touching, user-data, or API changes.
For pure config or styling changes, run the baseline checklist inline.

For security-relevant files, spawn via Task tool:
```
Task(
  subagent_type: "security-reviewer",
  prompt: "Review these changed files for security issues: [list].
           Load project security skill if it exists: .claude/skills/security-review-gates/SKILL.md
           Focus on: auth checks, input validation, secrets exposure, injection risks, access control,
           PII in query results and cell outputs, credentials in config/notebooks/DAGs,
           data access controls (row-level security, column masking).
           If no project security skill exists, use the baseline checklist including the Data Domain section.
           Report findings with file:line, severity (Critical/High/Medium/Low), and fix recommendation."
)
```

For non-security-relevant files (pure styling, pure docs):
- Apply the OWASP baseline from `references/security-checks.md` inline
- This takes 2 minutes and catches obvious issues without invoking the full agent

---

#### Validator D: Performance Review

**Context:** Changed files + performance-review-gates project skill (if it exists)

**Decision:** Use the `performance-analyzer` agent for data-layer, API, or component changes.
For pure styling or doc changes, skip this validator.

For performance-relevant files, spawn via Task tool:
```
Task(
  subagent_type: "performance-analyzer",
  prompt: "Review these changed files for performance issues: [list].
           Load project performance skill if it exists: .claude/skills/performance-review-gates/SKILL.md
           Focus on: N+1 queries, missing indexes on queried fields, unbounded queries, cache
           invalidation gaps, unnecessary re-renders, synchronous blocking in async paths,
           full table scans in joins, non-incremental materializations on large tables,
           query cost (warehouse compute), unnecessary recomputation in pipelines/DAGs,
           memory-intensive operations in notebooks without chunking.
           Report findings with file:line, impact (High/Medium/Low), and fix recommendation."
)
```

---

#### Validator E: Codex Adversarial Review (Cross-Model)

**Context:** Git diff (the actual code changes — not files in isolation)

**Purpose:** Cross-model adversarial pass on the implementation. Codex (OpenAI) attacks the diff
with framing focused on the failure modes Claude tends to miss or rationalize: auth/permission
boundaries, data loss, race conditions, rollback safety, idempotency gaps, schema drift,
observability gaps. This is the only validator that runs on a non-Claude model.

**Pre-flight check:** Verify Codex is available. If `command -v codex` fails or the
`codex:adversarial-review` slash command is not loaded, **skip this validator** with a warning:

> ⚠ Codex CLI unavailable — Validator E (cross-model adversarial) skipped. Cross-model coverage reduced.

Continue with Validators A-D. Do not block QA on Codex unavailability.

**Invocation:** Use the Skill tool to invoke `/codex:adversarial-review` with `--wait` so it runs
synchronously and returns the structured findings:

```
Skill({
  skill: "codex:adversarial-review",
  args: "--wait --base main"
})
```

Replace `main` with the project's actual base branch (check via `git symbolic-ref refs/remotes/origin/HEAD`
or fall back to `main` / `master` / `develop` based on what exists).

The Codex adversarial command runs through its companion runtime, which handles the diff
extraction, prompt construction, and structured JSON output. The skill returns Codex's output
verbatim — a JSON document with findings, each containing:
- `file` — the affected file path
- `line_start`, `line_end` — line range of the issue
- `confidence` — score from 0 to 1
- `recommendation` — concrete fix
- A summary verdict: `approve` or `needs-attention`

**Mapping Codex findings to team-qa classification:**

| Codex finding | team-qa class |
|---|---|
| High confidence (≥0.7) + auth/data loss/race condition/rollback safety | MUST-FIX |
| High confidence + observability gap, schema drift, idempotency violation | MUST-FIX |
| Medium confidence (0.4-0.7) on material risk | SHOULD-FIX |
| Low confidence (<0.4) or speculative | ADVISORY |
| Codex returns `approve` with no findings | No findings — note in report |

**Anti-pattern:** Do NOT re-prompt Codex with custom instructions or run `codex exec` directly.
The `/codex:adversarial-review` skill has a tuned adversarial prompt template that you cannot
replicate manually. Use the Skill tool.

**If Codex returns errors or times out:** Log "Codex adversarial review failed — Validator E
skipped this run" in the report and continue. Do not retry mid-run.

---

### Step 3: Collect and Classify All Findings

Wait for all Phase 2 validators to complete. Compile findings into one unified list.

Classify each finding:

| Class | Definition | Blocking? |
|-------|-----------|-----------|
| **MUST-FIX** | Security vulnerability, broken functionality, or critical convention violation | Yes |
| **SHOULD-FIX** | Quality issue, performance risk, or stale docs on public API | Review |
| **ADVISORY** | Minor style issue, preference, or low-impact suggestion | No |

**Classification heuristics:**
- Security finding (any severity) → MUST-FIX
- N+1 query or missing index on a queried field → MUST-FIX
- Stale docs on a changed public API → SHOULD-FIX
- Convention violation (naming, imports, structure, signatures, error handling, doc style), INTRODUCED (in diff's added lines) → SHOULD-FIX
- Convention violation, PRE-EXISTING (in unchanged lines) → ADVISORY
- Stale docs on internal function → ADVISORY
- Style preference (no convention backing) → ADVISORY
- Data leakage (train/test contamination, feature leakage) → MUST-FIX
- Hardcoded credentials in DAG, pipeline config, or notebook → MUST-FIX
- PII in notebook output cells or query results committed to repo → MUST-FIX
- Missing dbt test on primary/foreign key → SHOULD-FIX
- Non-incremental materialization on large table (>1M rows) → SHOULD-FIX
- Missing source freshness check on critical source → SHOULD-FIX
- SQL style preference (no convention backing) → ADVISORY
- Missing model/column description in schema.yml → ADVISORY

### Step 4: STOP — Present QA Report and Gate

Write the complete report using `references/qa-report-template.md`.

Then STOP. Display exactly this gate:

```
---
**QA complete.**

Denoise:        [N fixed, N waived]
Style:          [N violations — N MUST-FIX, N SHOULD-FIX, N ADVISORY (M introduced, P pre-existing)]
Doc freshness:  [N stale items]
Security:       [N findings — N MUST-FIX]
Performance:    [N findings — N MUST-FIX, N SHOULD-FIX]
Codex (cross-model): [N findings — N MUST-FIX, N SHOULD-FIX, N ADVISORY]   [or: skipped — Codex unavailable]

MUST-FIX total: [N]

<!-- GATE: qa-clearance — All MUST-FIX fixed or waived before /team-ship -->
[If MUST-FIX > 0:]
[N] blocking findings must be addressed before shipping.
Fix them and re-run `/team-qa`, or explicitly waive each with a stated reason.

[If MUST-FIX == 0 and SHOULD-FIX > 0:]
No blockers. [N] SHOULD-FIX items for your review — address, accept, or waive each.

[If all clear:]
QA pipeline clear. Ready to ship.
---
```

**Note:** The `(M introduced, P pre-existing)` breakdown appears only on the Style line. Validators C (security-reviewer) and D (performance-analyzer) are specialized subagents that report findings by severity only — they do not classify findings by origin, so origin breakdowns do not appear in their lines.

**Loop:** Fix MUST-FIX items → re-run `/team-qa` on the changed files → until clear.

---

## Validator Routing by File Type

| Changed file type | Denoise | Style | Doc | Security | Performance |
|-------------------|---------|-------|-----|----------|-------------|
| API route / controller | ✓ | ✓ | ✓ | ✓ | ✓ |
| Data layer / queries | ✓ | ✓ | ✓ | ✓ | ✓ |
| Auth / middleware | ✓ | ✓ | ✓ | ✓ | — |
| Frontend component | ✓ | ✓ | ✓ | ✓ (XSS) | ✓ (re-renders) |
| Config / env | ✓ | — | ✓ | ✓ (secrets) | — |
| Tests | ✓ | ✓ | — | — | — |
| Docs / README | — | — | ✓ | — | — |
| Migrations / schema | ✓ | ✓ | ✓ | — | ✓ (indexes) |
| dbt model / SQL transformation | ✓ | ✓ | ✓ | ✓ (PII) | ✓ (query cost) |
| Pipeline / DAG definition | ✓ | ✓ | ✓ | ✓ (credentials) | ✓ (idempotency) |
| Notebook (.ipynb) | ✓ | ✓ | ✓ | ✓ (PII in output) | ✓ (memory) |
| ML / feature code | ✓ | ✓ | ✓ | ✓ (data leakage) | ✓ (compute) |
| Metric / dashboard definition | ✓ | ✓ | ✓ | — | — |
| Schema / quality definition | ✓ | ✓ | ✓ | — | — |
| GL model / financial SQL | ✓ | ✓ | ✓ | ✓ (PII: salary/comp data, access controls) | ✓ (full-table scans on multi-year transaction tables) |
| Reconciliation script | ✓ | ✓ | ✓ | — | ✓ (control total query cost) |
| Regulatory / report output config | ✓ | — | ✓ | ✓ (audit trail, data access) | — |
| LLM client / API wrapper | ✓ | ✓ (llm-engineering) | ✓ | ✓ (API key exposure, prompt injection) | ✓ (token cost, model tier) |
| Prompt template / eval harness | ✓ | ✓ (llm-engineering) | ✓ | ✓ (system prompt leakage, key in eval scripts) | ✓ (token budget, live API in unit tests) |
| Agent loop / orchestrator | ✓ | ✓ (agentic-systems) | ✓ | ✓ (prompt injection via tool results, inter-agent trust) | ✓ (unbounded loops, cost per run) |
| MCP server / tool definition | ✓ | ✓ (agentic-systems) | ✓ | ✓ (auth on tool endpoints, scope creep) | ✓ (tool error handling, retry behavior) |
| Mobile screen / component | ✓ | ✓ (vercel-react-native-skills) | ✓ | ✓ (deep links, API keys in config) | ✓ (list perf, re-renders, animation) |
| Native module bridge | ✓ | ✓ | ✓ | ✓ (permissions, native API misuse) | ✓ |
| Mobile config (app.json, eas.json) | ✓ | — | ✓ | ✓ (secrets, permissions) | — |

**Note:** When `vercel-react-native-skills` is in `relevant_global_skills`, Validator A loads it for mobile screen/component files.

**Validator E (Codex) routing:** Codex operates on the git diff as a whole, not on individual file types. It runs on **every QA invocation** that has any code changes, regardless of file type — its adversarial framing applies broadly (auth, data, race conditions, observability gaps appear everywhere). Skip Validator E only when:
- The diff contains pure docs (`.md`, `README`) and no code at all
- The diff is empty (no changed files)
- Codex CLI is unavailable (pre-flight skip with warning)

---

## Anti-Patterns (Do Not Do These)

- **Don't run validators on the entire codebase.** Only changed files. Full sweeps produce noise that buries real findings.
- **Don't skip denoise.** Style checking noisy code flags things that would disappear after cleanup. Denoise first, validate clean.
- **Don't waive security findings without a stated reason.** "Won't fix" on a security issue is a decision that must be documented.
- **Don't merge advisory findings with MUST-FIX.** Different urgency = different lists. Don't let advisory volume make MUST-FIX items feel optional.
- **Don't loop QA on the same files endlessly.** If a finding keeps re-appearing, escalate to the user — it's a design issue, not a QA issue.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "Checks pass so it's fine" | Checks verify what they check. QA validates what automated checks don't: conventions, security, performance, documentation. |
| "Just style/convention issues" | Consistent conventions reduce cognitive load across the team. Classify and log, don't dismiss. |
| "Ship it, fix later" | "Later" is never. MUST-FIX now; SHOULD-FIX is user's call. |
| "Security/validation check is overkill" | Security is not proportional to your confidence. Run the check. |
| "Performance doesn't matter at this scale" | Patterns established now persist. Check for inefficient queries, missing indexes, unbounded operations, unnecessary recomputation. |

---

## Retro Handoff

When QA clears with no MUST-FIX items remaining, add to the "all clear" gate message:

> After shipping, consider running `/team-retro` to capture learnings from this feature's workflow.

---

## Model Tier

| Role | Tier | Rationale |
|------|------|-----------|
| Lead (current session, orchestrates) | Opus (current session) | Denoise runs inline, finding classification requires judgment, gate decisions need care |
| Validator A: Style Audit | Sonnet | Mechanical: convention matching against a loaded skill |
| Validator C: Security Review | security-reviewer agent | Specialized agent — inherits that agent's model |
| Validator D: Performance Review | performance-analyzer agent | Specialized agent — inherits that agent's model |
| Validator E: Codex Adversarial | Codex (OpenAI) | Cross-model adversarial pass — runs through `/codex:adversarial-review` skill |

**Rationale:** Validators A-D are mechanical Claude checks (convention matching, known-bad-pattern detection). Validator E adds a non-Claude perspective on the same diff to catch failure modes Claude tends to miss. Reserve Opus for denoise (inline), finding classification, and the final gate judgment.
