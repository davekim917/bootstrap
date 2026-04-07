---
name: review-swarm
description: >
  Multi-agent code review swarm for any codebase. Spawns required reviewers (adversarial,
  domain-context) plus dynamic reviewers (architecture, concurrency, security, contract,
  data, performance) based on diff and detected domain. Covers TypeScript, Python, React,
  dbt, SQL, Snowflake, Airflow, data pipelines, ML, and full-stack applications. Reviewers
  collaborate via SendMessage before reporting. Use when reviewing code, checking uncommitted
  changes, auditing a branch or PR, or running pre-commit review. Triggers on "review",
  "review changes", "check my changes", "review this PR", "code review", "review my code".
  Do not use for design document reviews (use /team-review) or single-line typo fixes.
---

# /review-swarm — Code Review Swarm

## What This Skill Does

Runs uncommitted changes (or a specified scope) through a team of specialized reviewers that collaborate before reporting. Each reviewer operates as a non-local agent session (TeamCreate + Agent with `team_name`), not a subagent. Adapts reviewer selection to the detected domain and technology stack.

**Output:** Combined review report with findings classified as BUG or SUGGESTION.
**NOT output:** Fixed code. Design reviews. The skill identifies problems — fixes are the developer's job.

## Prerequisites

- Uncommitted changes, a branch, or a PR to review
- If no changes exist (`git diff HEAD` is empty and no scope specified): stop and tell the user

## When to Use

- After making changes, before committing
- Before creating a PR
- When the user says "review", "check my changes", "review this PR"

## When NOT to Use

- Design document reviews → `/team-review`
- Single-line typo fixes → just fix it, no swarm needed

---

## Process

### Step 1: Gather the Diff and Detect Domain

1. Run `git diff HEAD` for all uncommitted changes
2. If the user specifies a scope (file, branch, PR via `gh pr diff`), use that instead
3. Read all changed files in full — reviewers need complete context, not just hunks
4. Read CLAUDE.md (if present) for project conventions and constraints
5. **Detect the domain** from file extensions, imports, frameworks, and project structure:
   - **SWE / Full-stack**: TypeScript, JavaScript, React, Next.js, Node.js, REST APIs, GraphQL
   - **Backend**: Go, Rust, Java, Python services, API routes, middleware, auth
   - **Frontend**: React/Vue/Svelte components, CSS, HTML, web components, Lit
   - **Data Engineering**: Airflow DAGs, Spark jobs, pipeline configs, Kafka consumers/producers
   - **Analytics Engineering**: dbt models (SQL + YAML), Jinja macros, schema tests, sources
   - **Data Science / ML**: Jupyter notebooks, model training, feature engineering, eval scripts
   - **SQL**: Stored procedures, migrations, complex queries, Snowflake UDFs
   - **Python**: Scripts, CLI tools, libraries, FastAPI/Django/Flask apps
   - **Agentic / LLM**: Agent loops, MCP servers, prompt construction, tool schemas

### Step 2: Select Reviewers

**Required (always spawn):**

| Name | Focus |
|------|-------|
| `adversarial-reviewer` | Edge cases, race conditions, security issues, error handling gaps, stress failure modes, input validation |
| `domain-reviewer` | Project conventions (from CLAUDE.md), domain-specific idioms, framework best practices, naming consistency, test coverage gaps |

**Dynamic (select 1-3 based on the diff and domain — cap at 5 total):**

| Name | Select When | Focus |
|------|-------------|-------|
| `arch-reviewer` | New files, structural changes, config changes, deps added, 4+ files changed | Separation of concerns, dependency direction, state management, abstraction boundaries |
| `concurrency-reviewer` | Async flows, shared state, DB transactions, queue/stream processing, parallel execution | Race conditions, deadlocks, transaction isolation, async gaps, ordering guarantees |
| `security-reviewer` | Auth flows, credential handling, user input, env vars, tokens, API keys, SQL queries | Injection (SQL, XSS, command), credential leakage, permission escalation, input sanitization |
| `contract-reviewer` | API changes, schema changes, serialization, IPC, webhooks, shared types | Backwards compatibility, type safety at boundaries, missing fields, breaking changes |
| `data-reviewer` | dbt models, SQL transforms, pipeline logic, metric definitions, data joins, Jinja macros, warehouse SQL, Airflow/orchestration, feature engineering, notebook code | Data correctness (grain, nulls, fanout, SCD), dbt idioms (ref/source, incremental logic, materializations, schema tests), SQL dialect and warehouse patterns (clustering, partitioning, warehouse sizing), pipeline orchestration (idempotency, backfill, late arrivals), ML data concerns (leakage, feature consistency, reproducibility) |
| `performance-reviewer` | N+1 queries, large loops, missing indexes, unbounded fetches, rendering hot paths | Query optimization, caching, pagination, lazy loading, bundle size, memory leaks |

Do not spawn reviewers with zero overlap to the changes. Zero dynamic reviewers is valid for trivial changes.

**Selection examples:**
- One-line CSS fix → adversarial + domain only (0 dynamic)
- New API endpoint with auth → + security + contract (2 dynamic)
- dbt model refactor across 6 files → + arch + data (2 dynamic)
- React component with async data fetching → + performance + concurrency (2 dynamic)
- New Airflow DAG with Snowflake queries → + data + performance (2 dynamic)

### Step 3: Create Team and Spawn Reviewers

1. `TeamCreate` with team name `code-review`
2. Spawn all selected reviewers in parallel using the `Agent` tool with `team_name: "code-review"` — **NOT subagents**
3. Each reviewer's prompt must include:
   - The full diff and changed file contents
   - Their focus area and criteria from [review-criteria.md](references/review-criteria.md)
   - The [reviewer prompt template](references/reviewer-prompt-template.md)
   - Names of all other reviewers on the team (for `SendMessage` collaboration)

**Research protocol for reviewers — mandatory before flagging unfamiliar libraries or patterns:**

1. **context7** (for libraries/frameworks) — `mcp__plugin_context7_context7__resolve-library-id` then `mcp__plugin_context7_context7__query-docs` to get current official docs. Training data goes stale; context7 does not. If context7 fails (rate limit, empty result), record the failure in output notes AND proceed immediately to the next step.
2. **deepwiki** (for specific GitHub repos/dependencies) — `mcp__deepwiki__read_wiki_structure` then `mcp__deepwiki__read_wiki_contents` or `mcp__deepwiki__ask_question` for architecture docs. If deepwiki fails (rate limit, timeout), record the failure in output notes AND proceed immediately to the next step.
3. **Exa (mandatory — always run)** — `mcp__exa__web_search_exa` for official docs and known pitfalls
4. **Exa code context** — `mcp__exa__get_code_context_exa` for real usage patterns in public repos
5. **Exa advanced** — `mcp__exa__web_search_advanced_exa` when filtering by recency or domain is needed

**Fallback discipline:** Steps 1-2 are preferred but may fail due to rate limits or missing coverage. Step 3 (Exa) is the mandatory floor — it must always run. Never fall back to training data as a primary source for pattern claims. If all external research fails (context7, deepwiki, and all Exa calls), stop and tell the user rather than spawning reviewers with no research backing. Do not flag something as wrong without verifying against current docs.

**Project docs site:** If CLAUDE.md or project configuration references a documentation site (e.g. a docs URL, llms.txt, or wiki), fetch relevant pages before spawning reviewers. Extract project-specific patterns and conventions, and include them in reviewer prompts alongside CLAUDE.md context.

**Recency matters.** Prefer sources from the last 1-2 years. If a practice appears only in older sources (3+ years), verify it hasn't been superseded. Ecosystems evolve fast; a best practice from a few years ago may be an anti-pattern today.

### Step 4: Reviewer Collaboration

Reviewers communicate via `SendMessage` to:
- Share findings that overlap with another reviewer's domain
- Confirm or challenge each other's findings
- Resolve disagreements or duplicates

**Convergence rule:** 2 rounds of messaging max (send findings → respond → finalize). If disagreement persists after 2 rounds, include both perspectives — the lead adjudicates.

Only after collaboration should each reviewer send final findings to the team lead.

<!-- GATE: reviewer-collaboration — All reviewers have sent final findings to lead -->

### Step 5: Produce Final Combined Review

Collect all findings and produce a single report:

**Deduplication:** Same finding from multiple reviewers = stronger signal; merge and note sources. Near-duplicates = merge with a note.

**Fact-checking:** For each finding, verify against the actual code. If a reviewer claims "this pattern is wrong" — read the code and confirm. Drop findings contradicted by the codebase.

**Classification:**
- **BUG** — must fix: incorrect behavior, data corruption risk, credential leak, race condition
- **SUGGESTION** — nice to have: style, minor improvement, defense in depth

**Output format per finding:**
```
[BUG/SUGGESTION] file:line — Issue description
  Flagged by: reviewer-name(s)
  Fix: what to do instead
```

If no issues found, say so — do not invent problems.

Present the report:
```
---
**Review complete.**

BUG: [N] findings
SUGGESTION: [N] findings

[list each finding using the format above]
---
```

<!-- GATE: review-complete — Report presented to user -->

### Step 6: Cleanup

1. Shut down all reviewers: `SendMessage` with `type: "shutdown_request"` to each
2. `TeamDelete` to remove team and task list

---

## Timeout Handling

If a reviewer has not sent findings within 3 minutes of the last collaboration message, send it a `SendMessage` asking for its final findings. If still no response after 1 additional minute, exclude that reviewer from the report and note: "Reviewer [name] timed out — findings excluded."

Do not retry or respawn timed-out reviewers.

---

## Anti-Patterns (Do Not Do These)

- **Spawning subagents instead of team agents.** The whole point is non-local sessions with `SendMessage` collaboration. Use `Agent` with `team_name`, not plain `Agent`.
- **Spawning all reviewers every time.** Dynamic selection exists for a reason. A one-line fix does not need architecture review.
- **Inventing findings.** A clean diff is a valid outcome. "No issues found" is a correct review result.
- **Skipping fact-checking.** A finding that contradicts the actual codebase wastes the user's time. Verify before including.
- **Letting reviewers self-report without collaboration.** The collaboration step catches duplicates, false positives, and blind spots. Skip it and quality drops.
- **Inflating BUG count.** If everything is a BUG, nothing is. Reserve BUG for genuine correctness issues.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "The change is small, no review needed" | Small changes cause big bugs. A one-line SQL join change can silently fan out millions of rows. |
| "I already know this code well" | Familiarity breeds blind spots. The adversarial reviewer exists precisely to catch what you'd miss. |
| "The reviewers agree, so it must be fine" | Agreement after collaboration is signal. Agreement without collaboration is groupthink — did they actually cross-check? |
| "No findings, must be a tool issue" | Clean diffs happen. Don't re-run hoping for findings. A correct "no issues" is better than invented problems. |
| "Too many reviewers will slow things down" | All reviewers run in parallel. Cost is tokens, not time. Select based on relevance, not speed. |
| "I'll just use the adversarial reviewer alone" | Single-lens review misses domain-specific issues. The domain reviewer catches framework/convention bugs that adversarial review doesn't know to look for. |

---

## Context Discipline

**Read:** `git diff HEAD`, changed files in full, CLAUDE.md (for reviewer context)
**Research:** context7 + deepwiki (preferred), Exa (mandatory), WebSearch (fallback). Project docs site if referenced in CLAUDE.md.
**Write:** Nothing — review produces a report in the conversation, not on disk
**Do NOT read:** Unchanged files (unless needed to fact-check a specific finding)
**Do NOT do:** Fall back to training data when research tools fail — Exa is the mandatory floor

---

## Resource Files

- **[review-criteria.md](references/review-criteria.md)** — Domain-specific review criteria, organized by reviewer role
- **[reviewer-prompt-template.md](references/reviewer-prompt-template.md)** — Prompt template for spawning reviewers, including collaboration and output format instructions
