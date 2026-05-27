# QA Validator Routing

Which validators run on which file types, and what file-type concerns to forward to the code review swarm. The lead reads this file during Step 2 of `team-qa/SKILL.md` to build the validator routing decisions and the `<DOMAIN_HINTS>` block for Validator CD.

## Table of contents

- [Validator routing by file type](#validator-routing-by-file-type) — which of A/B/CD/E run for each file type
- [Validator E (Codex) routing rule](#validator-e-codex-routing-rule)
- [Domain hints — Part 1: file-type concerns](#domain-hints--part-1-file-type-concerns) — annotation block forwarded verbatim to review-swarm
- [Domain hints — Part 2: project conventions](#domain-hints--part-2-project-conventions)

---

## Validator routing by file type

Team-qa decides "swarm or not" per file type below; review-swarm picks its own reviewer mix internally (see `review-swarm/SKILL.md:71-78`).

| Changed file type | Denoise | Style | Doc | Code Review (CD) |
|-------------------|---------|-------|-----|------------------|
| API route / controller | ✓ | ✓ | ✓ | ✓ |
| Data layer / queries | ✓ | ✓ | ✓ | ✓ |
| Auth / middleware | ✓ | ✓ | ✓ | ✓ |
| Frontend component | ✓ | ✓ | ✓ | ✓ |
| Config / env | ✓ | — | ✓ | — (no code) |
| Tests | ✓ | ✓ | — | ✓ |
| Docs / README | — | — | ✓ | — (no code) |
| Migrations / schema | ✓ | ✓ | ✓ | ✓ |
| dbt model / SQL transformation | ✓ | ✓ | ✓ | ✓ |
| Pipeline / DAG definition | ✓ | ✓ | ✓ | ✓ |
| Notebook (.ipynb) | ✓ | ✓ | ✓ | ✓ |
| ML / feature code | ✓ | ✓ | ✓ | ✓ |
| Metric / dashboard definition | ✓ | ✓ | ✓ | ✓ |
| Schema / quality definition | ✓ | ✓ | ✓ | ✓ |
| GL model / financial SQL | ✓ | ✓ | ✓ | ✓ |
| Reconciliation script | ✓ | ✓ | ✓ | ✓ |
| Regulatory / report output config | ✓ | — | ✓ | ✓ |
| LLM client / API wrapper | ✓ | ✓ (llm-engineering) | ✓ | ✓ |
| Prompt template / eval harness | ✓ | ✓ (llm-engineering) | ✓ | ✓ |
| Agent loop / orchestrator | ✓ | ✓ (agentic-systems) | ✓ | ✓ |
| MCP server / tool definition | ✓ | ✓ (agentic-systems) | ✓ | ✓ |
| Mobile screen / component | ✓ | ✓ (vercel-react-native-skills) | ✓ | ✓ |
| Native module bridge | ✓ | ✓ | ✓ | ✓ |
| Mobile config (app.json, eas.json) | ✓ | — | ✓ | — (no code) |

When `vercel-react-native-skills` is in `relevant_global_skills`, Validator A loads it for mobile screen/component files.

## Validator E (Codex) routing rule

Codex operates on the git diff as a whole, not on individual file types. It runs on **every QA invocation that has any code changes**, regardless of file type — its adversarial framing applies broadly (auth, data, race conditions, observability gaps appear everywhere).

Skip Validator E only when:
- The diff contains pure docs (`.md`, `README`) and no code at all.
- The diff is empty (no changed files).
- Codex CLI is unavailable (pre-flight skip with warning — see `team-qa/SKILL.md`).

---

## Domain hints — Part 1: file-type concerns

Build the annotation block from the changed files identified in Step 1 of `team-qa/SKILL.md`. For each file type present in the diff, include the matching line below. Send to review-swarm verbatim — these are hints, not directives; review-swarm's dynamic selection still decides which reviewers to spawn.

```
File-type concerns to consider when selecting and prompting reviewers:

- API route / controller       → security (auth, input validation), performance (N+1)
- Data layer / queries         → security (injection, access control), performance (indexes, unbounded fetches)
- Auth / middleware            → security (priority — permission boundaries, session handling)
- Frontend component           → security (XSS), performance (re-renders, bundle size)
- Config / env                 → security (secret exposure)
- Migrations / schema          → performance (index coverage, lock duration), data correctness (backfill safety)
- dbt model / SQL              → security (PII exposure), performance (query cost, materialization sizing)
- Pipeline / DAG               → security (credentials in config), correctness (idempotency, late arrivals)
- Notebook (.ipynb)            → security (PII in cell outputs), performance (memory, chunking)
- ML / feature code            → security (data leakage, train/test contamination), performance (compute)
- Metric / dashboard           → security (PII in dashboard exposure), correctness (metric definition drift)
- GL model / financial SQL     → security (salary/comp PII, row-level access controls), performance (full-table scans on multi-year transaction tables)
- Reconciliation script        → correctness (control totals), performance (query cost)
- Regulatory / report config   → security (audit trail, data access controls)
- LLM client / API wrapper     → security (API key exposure, prompt injection), performance (token cost, model tier)
- Prompt template / eval       → security (system prompt leakage, key in eval scripts), performance (token budget, live API in unit tests)
- Agent loop / orchestrator    → security (prompt injection via tool results, inter-agent trust), performance (unbounded loops, cost per run)
- MCP server / tool definition → security (auth on tool endpoints, scope creep), performance (tool error handling, retry behavior)
- Mobile screen / component    → security (deep links, API keys in config), performance (list perf, animation)
- Native module bridge         → security (permissions, native API misuse), performance
- Mobile config (app.json)     → security (secrets, permissions)
```

## Domain hints — Part 2: project conventions

Project-specific conventions, security rules, and performance rules live in `AGENTS.md/CLAUDE.md`. The swarm's reviewers read `AGENTS.md/CLAUDE.md` directly as part of their built-in setup — no extra hint needed beyond Part 1's file-type concerns. If a project documents specific patterns or guardrails in AGENTS.md/CLAUDE.md, the swarm picks them up automatically.
