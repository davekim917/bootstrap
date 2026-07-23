---
name: review-swarm
description: >
  Multi-agent code review swarm for any codebase. Spawns required reviewers (adversarial,
  domain-context) plus dynamic reviewers (architecture, concurrency, security, contract,
  data, performance) based on diff and detected domain. Covers TypeScript, Python, React,
  dbt, SQL, Snowflake, Airflow, data pipelines, ML, and full-stack applications. Reviewers
  collaborate directly before reporting. Use when reviewing code, checking uncommitted
  changes, auditing a branch or PR, or running pre-commit review. Triggers on "review",
  "review changes", "check my changes", "review this PR", "code review", "review my code".
  Do not use for design document reviews (use /team-review) or single-line typo fixes.
---

# /review-swarm — Code Review Swarm

## What This Skill Does

Runs uncommitted changes (or a specified scope) through a native Claude agent team whose
specialized reviewers collaborate before reporting. Each reviewer is an independent teammate,
not a fire-and-return subagent. Adapts reviewer selection to the detected domain and technology
stack.

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

**Dynamic (select 1-3 based on the diff and domain — hard cap at 4 total reviewers, 5 only in exceptional cases):**

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

### Step 3: Spawn Agent-Team Reviewers

Claude agent teams are session-scoped. There is no explicit team-creation step and no named
per-skill team: the first teammate spawn forms the session's team automatically. Explicitly ask
for **agent-team teammates**, because Claude may otherwise choose ordinary subagents.

1. Spawn all selected reviewers in parallel as native teammates with the predictable names from
   Step 2 — **not fire-and-return subagents**. Reuse the current session team if one already exists.
2. Each reviewer's prompt must include:
   - The full diff and changed file contents
   - Their focus area and criteria from [review-criteria.md](references/review-criteria.md)
   - The [reviewer prompt template](references/reviewer-prompt-template.md)
   - Names of all other reviewers on the team (for `SendMessage` collaboration)

**Research protocol for reviewers — mandatory before flagging unfamiliar libraries or patterns:**

1. Read project-local documentation and the dependency's current official docs.
2. Use any connected documentation capability available in the runtime.
3. Use native web search/open against primary sources: official docs, specifications, release
   notes, and maintainer repositories.
4. Use maintained public-repository examples only to corroborate the primary sources.

**Fallback discipline:** Do not require a specific MCP provider. Research is claim-scoped: plain
logic, control-flow, and project-contract findings can be proven from the diff and repository;
claims about unfamiliar library behavior or current best practice require a live source. If no live
source is reachable for such a claim, omit or mark that claim unverified rather than failing the
entire review or falling back to training data.

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

Send a shutdown request to every reviewer teammate. Wait for each reviewer to acknowledge or
otherwise stop before continuing. Claude cleans up the session-scoped team automatically when the
session exits; there is no separate team deletion step.

---

## Lead Authority and Deadline Enforcement

You are the lead. You own the timeline. Reviewers work for you, not the other way around.

**Do not wait indefinitely for any reviewer.** After spawning reviewers, track which have sent final findings to you. If a reviewer has not reported back within a reasonable window after others have finished:

1. Send it ONE `SendMessage` demanding final findings immediately
2. If it still does not respond after your next turn, **declare it timed out and move on** — compile the report from the reviewers who delivered
3. Note in the report: "Reviewer [name] timed out — findings excluded"

**Do not:**
- Send repeated "still waiting" status messages — act instead
- Hold the entire report hostage for one straggler
- Retry or respawn timed-out reviewers

**The report must ship.** A report from 3 out of 4 reviewers is valuable. A report from 0 out of 4 because you waited forever is worthless.

---

## Anti-Patterns (Do Not Do These)

- **Spawning subagents instead of agent-team teammates.** The whole point is independent sessions
  with direct teammate messaging and a shared task list. Explicitly request native teammates.
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
**Research:** Project/vendor docs plus whatever live documentation, web, and repository capabilities the runtime exposes.
**Write:** Nothing — review produces a report in the conversation, not on disk
**Do NOT read:** Unchanged files (unless needed to fact-check a specific finding)
**Do NOT do:** Fall back to training data for current library or best-practice claims

---

## Resource Files

- **[review-criteria.md](references/review-criteria.md)** — Domain-specific review criteria, organized by reviewer role
- **[reviewer-prompt-template.md](references/reviewer-prompt-template.md)** — Prompt template for spawning reviewers, including collaboration and output format instructions
