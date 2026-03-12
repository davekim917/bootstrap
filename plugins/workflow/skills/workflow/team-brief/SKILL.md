---
name: team-brief
description: >
  Transform fuzzy thoughts into structured requirements through conversational extraction.
  Invoke when starting a non-trivial feature or change where requirements are unclear.
  BOUNDARY: Does not design solutions, does not read code. Output is a structured requirements brief only.
version: 1.0.0
---

# /team-brief — Requirements Crystallization Skill

## What This Skill Does

Transforms fuzzy user intent into a validated, structured brief through conversational Q&A.

**Output:** A structured requirements brief (see `references/brief-template.md`)
**NOT output:** Design decisions, architecture, implementation plans, code

## When to Use

- Before any non-trivial feature or task where requirements are unclear
- When a user says "I want to..." or "Build me a..." without clear constraints
- When scope boundaries are fuzzy (what's in vs out)
- When multiple valid interpretations exist

## When NOT to Use

- Trivial fixes (typos, single-line bugs, config tweaks)
- Tasks where requirements are already fully specified
- Do NOT auto-trigger — the user consciously enters this workflow by typing `/team-brief`

---

## Process

### Step 1: Understand What You Have

Read the user's input carefully. Identify:
- **Clear:** What is explicitly stated and unambiguous
- **Ambiguous:** What could be interpreted multiple ways
- **Missing:** What must be true for this to succeed but hasn't been stated

Do not ask questions yet. Just build your internal map.

### Step 1b: Project Scope Discovery

**Check for existing scope file first:**
- If `.claude/project-scope.md` exists:
  - Check `generated_at` timestamp vs. modification date of key indicator files (`dbt_project.yml`, `package.json`, `requirements.txt`).
  - If any indicator file is newer: warn "project-scope.md may be stale. Refresh recommended." Offer: refresh now (re-run discovery, overwrite) or proceed as-is.
  - If not stale: read and proceed to Step 2.

**If no scope file (or refresh chosen), run discovery scan (max 6 file reads):**

| File to check | Domain signal |
|---|---|
| `dbt_project.yml` | `analytics-engineering` |
| `airflow_settings.py` / `dags/` directory | `data-engineering` (Airflow) |
| `dagster_cloud.yaml` / `workspace.yaml` | `data-engineering` (Dagster) |
| `prefect.yaml` | `data-engineering` (Prefect) |
| `*.ipynb` (count ≥ 1) | `data-science` |
| `requirements.txt` / `pyproject.toml` | Parse for: `scikit-learn`, `torch`, `tensorflow`, `xgboost` → `data-science`; `fastapi`, `django`, `flask` → `web-app`; `airflow`, `dagster`, `prefect` → `data-engineering`; `anthropic`, `openai`, `langchain` → `ai-integration`; `openpyxl`, `xlrd`, `xlsxwriter`, `quantlib`, `pandas-finance` → hint toward `financial-analytics` |
| `package.json` | `react`, `next` → `web-app`; `expo`, `react-native` → `mobile-app`; `@anthropic-ai/sdk`, `openai` → `ai-integration` |
| `pubspec.yaml` | `mobile-app` |
| `Cargo.toml` | `cli-tool` (or `web-app` if axum/actix present) |
| `evals/` directory or `*.eval.py` files | `ai-integration` |
| `finance/`, `accounting/`, `gl_`, `coa_`, or `ledger` directory with any SQL or Python indicators | `financial-analytics` (auto-write; no prompt needed — compound signal is unambiguous) |

**Union accumulation (collect all fired signals):**
After running all individual signal checks above, collect every domain where at least one indicator fired. The `domains` list is the union of all matches:

  domains: [<every domain with ≥1 signal>]
  relevant_global_skills: [<skill for each domain, deduplicated>]

Only use AND-logic for disambiguation: when a file pattern matches multiple domains, the AND-logic below resolves which domain takes precedence.

**AND-logic disambiguation (for ambiguous signals only):**
- `package.json` has `expo`/`react-native` AND `@anthropic-ai/sdk`/`openai` → prefer `[mobile-app, ai-integration]` over either alone
- `requirements.txt` has `fastapi`/`flask` AND `scikit-learn`/`torch` → prefer `[web-app, ml-inference]`

**Novel domain handling:**
- If no indicators match any known domain: set `relevant_global_skills: []`
- Prompt user: "No standard domain detected. Describe the project in 1-2 sentences for the scope file." Use their answer to populate `description`, `quality_gates`, and `security_surface`.

**Write `.claude/project-scope.md`** using schema from `references/project-scope-template.md`. Set `generated_at: <today's date>`.

**Context Discipline:** Scan reads indicator files only — no source code, no implementation files.

---

### Step 2: Extract Initial Requirements

From the user's input, extract:
- **Requirements:** What must be true when this is done
- **Constraints:** Limits the solution must operate within (hard vs soft)
- **Non-goals:** What this explicitly should NOT do
- **Key concepts:** Domain terms that need shared definitions
- **Style preferences:** How the user thinks about quality

### Step 2b: Feasibility Check for Reuse Requirements

**When the brief includes layout or visual reuse requirements** — i.e., explicit or implicit claims that a page layout, component structure, or visual pattern should transfer to or be consistent with another specific page or view (e.g., "layout should transfer to page X", "use the same layout as the auth pages", "component should work in the account page sidebar"). Does NOT trigger on generic consistency language about behavior, APIs, or patterns ("consistent error handling", "consistent validation style"):

Verify layout constraints of all target pages/contexts before writing the requirement. Read the layout wrapper (e.g., `MainContent`, `layout.tsx`, app shell) to confirm the proposed pattern can physically work in each target context. This takes 1-2 minutes and prevents infeasible requirements from reaching design.

Write a `[HARD]` constraint in the `## Constraints` section of the brief using one of these forms:
- **Feasible reuse:** `[HARD] Reuse [ComponentName] layout: [specific structural requirement] — confirmed by inspection`
- **Infeasible:** `[HARD] [Page/Component] uses [layout type] — [proposed pattern] is not feasible there`

Do not silently drop or rephrase the reuse requirement — document the finding explicitly so /team-design sees it as a classified constraint.

**This is a narrow exception to the "don't read code" rule** — layout wrappers are structural constraints, not implementation details. Limit reads to files named `layout.tsx` (any route segment — e.g., `app/layout.tsx`, `app/(auth)/layout.tsx`). Do not read named components, page files, or app shell wrappers outside of route segment layout files.

### Step 3: Ask ONE Question Per Ambiguity

For each ambiguity you identified, ask ONE targeted question. Rules:
- One question per turn. Do not batch-dump 5 questions at once.
- Make the question specific. "What database?" is weak. "Should this use the existing PostgreSQL users table, or is a separate data store acceptable?" is strong.
- Provide a default if one is clearly better. "I'll assume X unless you say otherwise."
- Stop asking when you have enough to write a complete brief. You do not need perfect information.

### Step 4: Force Remaining Decisions

After questions are resolved, if any ambiguities remain:
1. List them with your recommended default
2. Present as a single checkpoint:
   ```
   Remaining decisions — I'll use these defaults unless you override:
   - [Decision A]: [Default] — [brief rationale]
   - [Decision B]: [Default] — [brief rationale]

   Override any? Or proceed with defaults?
   ```
3. Wait for response, then finalize.

### Step 5: STOP — Present Brief and Wait for Approval

Using `references/brief-template.md`, write the complete structured brief.

Save the brief to disk:
1. Derive the feature name from the brief title (kebab-case, e.g., "User Authentication" → "user-authentication")
2. `mkdir -p .context/specs/<feature>/`
3. Write the brief to `.context/specs/<feature>/brief.md`
4. Initialize the decision record at `.context/specs/<feature>/decisions.yaml`:
   - Record all constraints from Step 2 (with HARD/SOFT classification)
   - Record all decisions from Step 3 Q&A (what was asked, what the user chose, what alternatives were considered)
   - Record all forced defaults from Step 4 (what was defaulted, what the alternative was)
   - Format: see `skills/workflow/shared/decision-record-schema.md`

Then STOP. Display exactly this gate:

```
---
**Brief ready for review.**

**Saved to:** `.context/specs/<feature>/brief.md`

If this looks right, say "approved" to proceed to `/team-design`.
If anything needs adjusting, tell me what to change.
---
```

<!-- GATE: brief-approval — Brief must be explicitly approved before proceeding to /team-design -->
**Do not proceed to /team-design or any implementation until the user explicitly approves this brief.**

---

## Anti-Patterns (Do Not Do These)

- **Don't start designing.** If you find yourself saying "we could use X library" or "the API would look like..." — stop. That's `/team-design`'s job.
- **Don't read code.** The brief is about what to build, not how. Code is irrelevant at this stage. Exception: `layout.tsx` files in Step 2b (structural constraints only — route segment layout files only, see that step for full scope limits).
- **Don't propose solutions.** "We could do A or B" is design thinking, not requirements extraction.
- **Don't ask everything at once.** Batching questions overwhelms users and signals you haven't prioritized.
- **Don't over-specify.** The brief captures requirements and constraints, not implementation details. Leave room for design.
- **Don't skip the gate.** The brief is worthless if you immediately start designing. The gate is the point.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "Too simple for a brief" | Simple features with unclear scope become complex. Brief takes 5 minutes. |
| "I already understand what's needed" | Brief is for shared understanding, not just yours. Write it down. |
| "Let me just start building" | Building without a brief is designing by accident. |
| "The user already told me everything" | Users state what they want, not what they need. Brief captures both. |
| "Brief would be redundant" | If truly redundant, writing it takes 2 minutes. If not, you saved hours. |

---

## Rollback

Brief does not accept rollbacks. If later stages invalidate the brief, re-run `/team-brief` from scratch.

---

## Context Discipline

**Read:**
- `CLAUDE.md` — for project context (tech stack, conventions, existing patterns)

**Write:**
- `.context/specs/<feature>/brief.md` — the completed brief (Step 5)
- `.context/specs/<feature>/decisions.yaml` — initialized decision record (Step 5)
- `.claude/project-scope.md` — scope file written or refreshed in Step 1b

**Do NOT read:**
- Source code (irrelevant to requirements). Exception: `layout.tsx` files in Step 2b (structural constraints only — route segment layout files only, see that step for full scope limits).
- Existing skills (design will load what's needed)
- Any file not needed to understand the user's intent

**Rationale:** Context is noise. Every file you read at this stage is a file that might bias your requirements extraction toward the existing implementation rather than the user's actual needs.

---

## Model Tier

**Tier:** Opus (current session)
**Rationale:** Requirements extraction is strategic judgment work — understanding user intent, identifying ambiguities, forcing decisions on the right defaults, and knowing when you have enough information to stop. Opus-level reasoning produces higher-quality briefs that catch more edge cases before design begins.
