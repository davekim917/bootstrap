---
name: review-swarm
description: >
  Multi-agent code review swarm for any codebase, for Codex and OpenCode runtimes. Spawns required
  reviewers (adversarial, domain-context) plus dynamic reviewers (architecture, concurrency, security,
  contract, data, performance) based on diff and detected domain. Covers TypeScript, Python, React,
  dbt, SQL, Snowflake, Airflow, data pipelines, ML, and full-stack applications. Reviewers run as
  independent worker passes; the lead cross-checks and adjudicates before reporting. Use when reviewing
  code, checking uncommitted changes, auditing a branch or PR, or running pre-commit review. Triggers on
  "review", "review changes", "check my changes", "review this PR", "code review", "review my code".
  Do not use for design document reviews (use /team-review) or single-line typo fixes.
version: 1.9.1
---

# /review-swarm — Code Review Swarm

> Runtime parity note: this is the Codex/OpenCode variant of the Claude `review-swarm`
> skill. The review *substance* — domain detection, reviewer selection, research
> protocol, criteria, classification, anti-patterns — is identical to the Claude
> version. Only the orchestration primitives differ (how reviewers are spawned and
> how findings converge), and those are isolated in **§ Dispatch by Runtime** at the
> end. Read that section once for your runtime, then follow the process below.

## What This Skill Does

Runs uncommitted changes (or a specified scope) through a team of specialized reviewers, then cross-checks and adjudicates their findings before reporting. Each reviewer operates as an **independent worker pass** with its own isolated context — not a single combined review. Adapts reviewer selection to the detected domain and technology stack.

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
4. Read AGENTS.md and/or CLAUDE.md (if present) for project conventions and constraints
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
| `domain-reviewer` | Project conventions (from AGENTS.md/CLAUDE.md), domain-specific idioms, framework best practices, naming consistency, test coverage gaps |

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

### Step 3: Spawn Reviewers

Spawn all selected reviewers **in parallel, as isolated worker passes** — see **§ Dispatch by Runtime** for the exact primitive on your runtime. Each reviewer's prompt must include:

- The full diff and changed file contents
- Their focus area and criteria from [review-criteria.md](references/review-criteria.md)
- The [reviewer prompt template](references/reviewer-prompt-template.md)
- The names of all other reviewers on the swarm (so cross-domain findings can be attributed during adjudication)

**Research protocol for reviewers — mandatory before flagging unfamiliar libraries or patterns:**

1. **context7** (for libraries/frameworks) — `mcp__plugin_context7_context7__resolve-library-id` then `mcp__plugin_context7_context7__query-docs` to get current official docs. Training data goes stale; context7 does not. If context7 fails (rate limit, empty result), record the failure in output notes AND proceed immediately to the next step.
2. **deepwiki** (for specific GitHub repos/dependencies) — `mcp__deepwiki__read_wiki_structure` then `mcp__deepwiki__read_wiki_contents` or `mcp__deepwiki__ask_question` for architecture docs. If deepwiki fails (rate limit, timeout), record the failure in output notes AND proceed immediately to the next step.
3. **Exa (mandatory — always run)** — `mcp__exa__web_search_exa` for official docs and known pitfalls
4. **Exa code context** — `mcp__exa__get_code_context_exa` for real usage patterns in public repos
5. **Exa advanced** — `mcp__exa__web_search_advanced_exa` when filtering by recency or domain is needed

**Fallback discipline:** Steps 1-2 are preferred but may fail due to rate limits or missing coverage. Step 3 (Exa) is the mandatory floor — it must always run. Never fall back to training data as a primary source for pattern claims. If all external research fails (context7, deepwiki, and all Exa calls), stop and tell the user rather than spawning reviewers with no research backing. Do not flag something as wrong without verifying against current docs.

**Project docs site:** If AGENTS.md/CLAUDE.md or project configuration references a documentation site (e.g. a docs URL, llms.txt, or wiki), fetch relevant pages before spawning reviewers. Extract project-specific patterns and conventions, and include them in reviewer prompts alongside project-context.

**Recency matters.** Prefer sources from the last 1-2 years. If a practice appears only in older sources (3+ years), verify it hasn't been superseded. Ecosystems evolve fast; a best practice from a few years ago may be an anti-pattern today.

### Step 4: Cross-Check and Converge

The goal of this step is the same on every runtime: **catch duplicates, false positives, and blind spots before the report ships.** A finding raised by one reviewer that touches another reviewer's domain must be confirmed or challenged, not passed through unexamined.

How convergence is achieved depends on your runtime's worker model — see **§ Dispatch by Runtime**:

- If reviewers can message each other directly, they exchange preliminary findings, cross-check overlaps, and resolve duplicates over a bounded number of rounds before sending finals to the lead.
- If reviewers are fire-and-return workers (no peer channel), the **lead** performs convergence: collect every reviewer's findings, identify overlaps and conflicts, and resolve them — re-dispatching a targeted follow-up worker only when a specific disputed finding needs a second look.

**Convergence budget:** at most 2 rounds (initial → cross-check → finalize). If a disagreement persists, include both perspectives and let the lead adjudicate. Do not loop indefinitely chasing consensus.

<!-- GATE: reviewer-convergence — All reviewer findings collected and cross-checked -->

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

Tear down any worker sessions you created — see **§ Dispatch by Runtime** for the teardown step on your runtime (some runtimes auto-reclaim fire-and-return workers; others need an explicit shutdown).

---

## Lead Authority and Deadline Enforcement

You are the lead. You own the timeline. Reviewers work for you, not the other way around.

**Do not wait indefinitely for any reviewer.** After spawning reviewers, track which have returned final findings. If a reviewer has not reported back within a reasonable window after others have finished:

1. Prompt it once for final findings (or, for fire-and-return workers, give it one bounded retry)
2. If it still does not respond, **declare it timed out and move on** — compile the report from the reviewers who delivered
3. Note in the report: "Reviewer [name] timed out — findings excluded"

**Do not:**
- Send repeated "still waiting" status messages — act instead
- Hold the entire report hostage for one straggler
- Endlessly retry or respawn timed-out reviewers

**The report must ship.** A report from 3 out of 4 reviewers is valuable. A report from 0 out of 4 because you waited forever is worthless.

---

## Anti-Patterns (Do Not Do These)

- **Running all passes in one combined context.** The whole point is isolated reviewer passes that don't contaminate each other's reasoning. Spawn separate workers (per § Dispatch by Runtime) — do not just "think through" all reviewer roles in a single pass.
- **Spawning all reviewers every time.** Dynamic selection exists for a reason. A one-line fix does not need architecture review.
- **Inventing findings.** A clean diff is a valid outcome. "No issues found" is a correct review result.
- **Skipping fact-checking.** A finding that contradicts the actual codebase wastes the user's time. Verify before including.
- **Skipping convergence.** The cross-check step catches duplicates, false positives, and blind spots. Skip it and quality drops.
- **Inflating BUG count.** If everything is a BUG, nothing is. Reserve BUG for genuine correctness issues.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "The change is small, no review needed" | Small changes cause big bugs. A one-line SQL join change can silently fan out millions of rows. |
| "I already know this code well" | Familiarity breeds blind spots. The adversarial reviewer exists precisely to catch what you'd miss. |
| "The reviewers agree, so it must be fine" | Agreement after cross-checking is signal. Agreement without cross-checking is groupthink — did they actually verify each other? |
| "No findings, must be a tool issue" | Clean diffs happen. Don't re-run hoping for findings. A correct "no issues" is better than invented problems. |
| "Too many reviewers will slow things down" | All reviewers run in parallel. Cost is tokens, not time. Select based on relevance, not speed. |
| "I'll just use the adversarial reviewer alone" | Single-lens review misses domain-specific issues. The domain reviewer catches framework/convention bugs that adversarial review doesn't know to look for. |

---

## Context Discipline

**Read:** `git diff HEAD`, changed files in full, AGENTS.md/CLAUDE.md (for reviewer context)
**Research:** context7 + deepwiki (preferred), Exa (mandatory), WebSearch (fallback). Project docs site if referenced in project instructions.
**Write:** Nothing — review produces a report in the conversation, not on disk
**Do NOT read:** Unchanged files (unless needed to fact-check a specific finding)
**Do NOT do:** Fall back to training data when research tools fail — Exa is the mandatory floor

---

## Dispatch by Runtime

The review substance above is runtime-agnostic. The orchestration primitives below are the **only** runtime-specific part. Implement these five primitives for your runtime; everything else in this skill stays the same.

| Primitive | What it does |
|-----------|--------------|
| `spawn_reviewers` | Fan out the selected reviewers in parallel, each in an isolated context, each with its constructed prompt |
| `collect_findings` | Gather each reviewer's final findings back to the lead |
| `cross_check` | Achieve Step 4 convergence (peer messaging where available, else lead-mediated) |
| `retry_or_timeout` | Give a non-responding reviewer one bounded retry, then exclude it |
| `teardown` | Reclaim worker sessions after the report ships |

> Reviewer identity is defined by the **prompt** (role + criteria), not by a registered
> agent type. The reviewer names in Step 2 (`adversarial-reviewer`, `domain-reviewer`, …)
> are labels — each reviewer is an independent worker given its role and the relevant
> criteria in its delegated prompt. This mirrors the Claude version, which spawns them as
> prompt-defined team agents.
>
> Use your runtime's **native, in-session subagent delegation** — workers that report their
> findings back to the lead. Do **NOT** use cross-agent or cross-container dispatch
> primitives (e.g. NanoClaw's `spawn_task` MCP, available only to container agents): those
> launch *separate agent sessions* that can't share findings or converge with each other,
> which defeats the entire purpose of a collaborative review. Stay in-session.

### Codex

Codex delegates to subagents out of the box. Run each selected reviewer as an independent
Codex subagent — in parallel where your Codex environment supports it — following the
bounded-delegation rules in [`../shared/codex-workflow-primitives.md`](../shared/codex-workflow-primitives.md) (§ Codex Subagents):

- `spawn_reviewers`: delegate one subagent per selected reviewer. Each gets, in its prompt:
  its role and focus area, the relevant criteria from review-criteria.md, the full diff +
  changed file contents, and the reviewer-prompt-template content. Write scope is naturally
  disjoint here — reviewers produce findings, they don't edit. If your environment can't run
  subagents in parallel, run the passes sequentially with **separated notes** so their
  conclusions don't contaminate each other.
- `collect_findings`: each subagent returns its findings to the lead.
- `cross_check`: **lead-mediated** — Codex subagents report to the lead, not to one another.
  The lead collects all findings, reconciles overlaps and conflicts, and re-delegates a
  single targeted follow-up only when a specific finding is disputed.
- `retry_or_timeout`: re-delegate a failed or empty subagent once; exclude on second failure.
- `teardown`: subagents complete and return — the lead owns integration and the final report.

### OpenCode

- `spawn_reviewers`: issue parallel `task({ subagent_type: 'general', description, prompt, background: true })` calls **in one tool turn** — one per selected reviewer. OpenCode's general worker is named `general` (NOT `general-purpose`). Convey the reviewer's role + focus + criteria + diff + changed files + reviewer-prompt-template content in the `prompt`. `background: true` is the parallel key — without it the calls serialize.
- `collect_findings`: await each background task's completion and read its result.
- `cross_check`: **lead-mediated**, same as Codex — OpenCode `task` workers are fire-and-return with no peer channel. Lead collects, reconciles, and re-dispatches one targeted `task` only for a specific disputed finding.
- `retry_or_timeout`: re-dispatch a failed/empty task once via `task(...)`; exclude on second failure.
- `teardown`: background tasks self-complete; no explicit shutdown needed.

### Claude (reference — for parity, not used on this runtime)

On Claude this skill uses `TeamCreate` + `Agent(team_name=…)` for `spawn_reviewers`, live `SendMessage` rounds for `cross_check` (reviewers message each other directly), and `SendMessage(type: "shutdown_request")` + `TeamDelete` for `teardown`. The Codex/OpenCode lead-mediated convergence above is the near-parity equivalent of Claude's peer-messaging rounds: same goal (dedupe, challenge, resolve), achieved by the lead because fire-and-return workers have no peer channel.

---

## Resource Files

- **[review-criteria.md](references/review-criteria.md)** — Domain-specific review criteria, organized by reviewer role
- **[reviewer-prompt-template.md](references/reviewer-prompt-template.md)** — Prompt template for spawning reviewers, including the runtime-aware convergence note and output format
