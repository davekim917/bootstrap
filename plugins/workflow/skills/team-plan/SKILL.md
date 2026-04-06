---
name: team-plan
description: >
  Invoke after /team-review clears. Produces an execution plan at .context/specs/<feature>/plan.md.
  Do NOT write plans manually — this skill has task decomposition rules, conflict checks, and
  constraint injection that only load when invoked.
version: 1.0.0
---

# /team-plan — Atomic Task Decomposition

## What This Skill Does

Turns an approved design into a builder-ready execution plan. Each task in the plan is specified
completely enough that a builder can execute it without guessing, asking questions, or reading
anything beyond their task group.

**The standard:** "If the builder has to guess, the planner failed."

**Output:** A structured plan document (see `references/plan-template.md`)
**NOT output:** Code, file changes, or implementation

## Prerequisites

1. An approved design document (from `/team-design`)
2. A cleared review report (from `/team-review`) — all MUST-FIX items addressed or explicitly waived

**If either is missing:** Tell the user what's needed and stop.

## When to Use

- After `/team-review` clears and before `/team-build`
- When re-planning after a design revision
- Do NOT auto-trigger — the user types `/team-plan` to enter this workflow

---

## Process

### Step 1: Read All Inputs

Load in order:
1. **Design document** — check `.context/specs/<feature>/design.md` first (standard location from `/team-design`); ask user to provide it if not found
2. **Review report** — check `.context/specs/<feature>/review.md` first (standard location from `/team-review`); ask user to provide it if not found. Carry forward any waived MUST-FIX items as known risks in the plan. Also carry forward any reviewer fallback notes (e.g., "Reviewer B timed out — fell back to Claude") as known risks: note that adversarial blind-spot coverage may be reduced.

   **Render-check flag scan:** After reading the design document, scan it for `[RENDER-CHECK NEEDED]` flags and note each flagged decision. Task assignment for these flags happens in Step 2 (once task boundaries are identified) — complete the flag-to-task mapping after Step 2, then use it in Step 4f to add render-check acceptance criteria to the relevant tasks.
3. **CLAUDE.md** — tech stack, conventions, critical guardrails
4. **Project scope** — read `.claude/project-scope.md` if it exists. Determines which domain skills to load and provides implementation conventions (primary language, framework, test framework). If not present, proceed without it.
5. **Relevant project skills** — load the skills listed in `relevant_global_skills` from the scope file (or 2-4 most applicable skills if no scope file). Read them now — you will transcribe patterns directly into task specs so builders don't need to load skills themselves.

### Step 2: Identify Task Boundaries

Before decomposing, find the natural seams in the design:

- **Vertical seams** — feature slices that can be built and tested independently (e.g., data layer,
  API layer, UI layer)
- **Sequential dependencies** — what must exist before something else can be built (e.g., schema
  before queries, auth middleware before protected routes)
- **Parallel opportunities** — what has no dependency on each other and can be built simultaneously

Draw a dependency graph (in text). This determines task group structure.

**Sizing target:** ~5 tasks per task group. A task group is what one builder agent handles end-to-end.
Groups must be independently executable — no shared file writes between groups.

### Step 3: Decompose into Task Groups

Assign tasks to groups following the dependency graph from Step 2.

For each group:
- Name it descriptively (e.g., "Group A: Data Layer", "Group B: API Routes")
- List the files it owns exclusively
- Identify its pre-conditions (which other groups must finish first)
- Note the interface it exposes to other groups (the contract other groups depend on)

**Group sizing heuristics:**
- Each group should be completable in one focused session
- If a group has >7 tasks, split it
- If a group has <2 tasks, merge it with a related group
- Prefer fewer, more cohesive groups over many small ones

### Step 4: Write Complete Task Specifications

For every task in every group, write a full spec. No placeholders. No "follow the existing pattern"
without showing the pattern.

**Domain-specific task spec patterns:** See [`references/domain-task-patterns.md`](references/domain-task-patterns.md) for canonical templates covering analytics-engineering (dbt), data-engineering (DAGs), data-science (ML), llm-engineering (prompt pipelines), agentic-systems (agents/MCP), and financial-analytics (GL models). Transcribe the relevant pattern directly into the task spec — do not link to it.

**Each task spec must contain:**

**a) File path (exact)**
Not "the auth module" — `src/auth/middleware/requireAuth.ts`. If creating a new file, give the
full path. If modifying an existing file, confirm it exists first with a quick read.

**b) Operation**
One of: CREATE (new file), MODIFY (change existing file), DELETE (remove file).
For MODIFY: state which functions/sections change and which must stay untouched.

**c) Implementation approach**
2-4 sentences describing what to build. Cite the project skill or CLAUDE.md section this
follows. Do not describe the obvious — describe the non-obvious decisions.
The builder infers implementation approach from the interface + invariants + project context
(scope file, CLAUDE.md, domain skills). The plan specifies *what* to build; the builder decides *how*.

**d) Interface / signature (from project skills)**
Specify the observable contract for this artifact. Format depends on artifact type:

| Artifact | Interface specification format |
|---|---|
| Python function | `def fn_name(param: Type, ...) -> ReturnType` — signature + type hints only |
| TypeScript / React component | `interface Props { userId: string; onSuccess: (data: T) => void; isLoading?: boolean }` |
| API endpoint | `POST /api/users/:id/activate — request: { reason: string }, response: { status: "ok" \| "error", message: string }` |
| dbt model | schema.yml column definitions: name + description + grain comment |
| Airflow / Dagster DAG | Task IDs + dependency arrows + XCom keys published |
| Jupyter notebook cell | Kernel namespace in/out: inputs (type, columns) → outputs (type, shape, nulls handled) |
| SQL query / analytics view | Column names + grain + filters |

**ASSERT annotations** — state each invariant the builder must satisfy:
```
ASSERT: <observable condition in plain English>
```

Examples (software):
```
ASSERT: function returns { error: "Email required" } for empty or whitespace-only email
ASSERT: retry fires exactly 3 times before raising (not 2, not 4)
```

Examples (data):
```
ASSERT: aggregation is at user-day grain (no duplicate user_id + date combinations)
ASSERT: revenue_usd is NULL-safe (source nulls → 0.00, not dropped)
```

ASSERT lines activate per-assertion verification in `/team-build`'s spec compliance gate.
Tasks without ASSERT lines fall back to the general criteria check.

If no project skill covers the interface pattern, check whether an external library provides it.
Verify the interface via the Research Fallback Chain before specifying it:
1. **Context7** — `resolve-library-id` → `query-docs` for the library
2. **Exa fallback** — `mcp__exa__get_code_context_exa` for real usage patterns in public repos
3. **WebSearch** — last resort

If unable to verify at all, write:
`[NO SKILL PATTERN — builder uses judgment, cite reasoning in commit message]` and note as a risk.

**e) Named test cases**
Write test cases by name before the code exists. Format:

```
test_[descriptive_name]:
  Setup:    [initial state — what exists before the action]
  Action:   [the specific thing being tested]
  Assert:   [exact expected outcome — status codes, return values, DB state]
  Teardown: [cleanup if needed, or "none"]
```

Minimum: one happy path, one error/edge case per task. For data tasks: include a constraint
violation case. For API tasks: include an unauthorized access case.

**f) Acceptance criteria**
Non-negotiable checkboxes. `/team-build` validates these before marking a task complete. Write them
as verifiable statements, not intentions:

**Render-check flags:** Check the render-check flag index from Step 1. For each flag mapped to this task, add an explicit acceptance criterion: "Render-check: lead must visually verify that [specific decision, e.g., 'text-accent on bg-primary logo color'] matches design intent after build — via dev server + screenshot (devtools MCP if available) or explicit human approval. Builder implements; lead verifies." This is a lead-verified criterion: the builder implements the decision, and the build lead performs the visual check after the group's functional criteria pass. Deliberate exception to the "don't write unverifiable criteria" anti-pattern — visual inspection is a valid verification method, assigned to the lead.

**Flag-to-task mapping heuristic:** Assign each render-check flag to the task that creates or owns the component file where the decision is applied. If a flag spans multiple tasks (e.g., a shared layout component referenced across groups), assign it to the lowest-dependency task — the task that creates the file, not a task that modifies it afterward. If no task clearly owns the decision, note it as a Known Risk in the plan with an explicit reason rather than dropping it silently.

- "Returns 201 with `{ id, email }` when email is valid" ✅
- "Works correctly" ❌ (not verifiable)
- "POST /api/users rejects duplicate email with 409" ✅
- "Handles errors" ❌ (not verifiable)

**g) Pre-conditions**
What must be true before this task can start. Reference specific task IDs (e.g., "Task A1 must
be complete — `requireAuth` middleware must exist at `src/auth/middleware/requireAuth.ts`").

### Step 4.5: Constraint Injection

Read `.context/specs/<feature>/decisions.yaml`. For each HARD constraint and each rejected option:

1. Identify which task group's files could violate this constraint or reintroduce the rejected approach
2. Encode the constraint as a negative ASSERT line or acceptance criterion in that group's task spec

**Constraint → ASSERT examples:**
```
Decision record: C3 type=HARD "Must support horizontal scaling without shared state"
→ Group A, Task A2 ASSERT: implementation does not use express-session, cookie-session,
  or any server-side session state management

Decision record: D1 rejected "Server-side sessions" reason="statelessness constraint"
→ Group A, Task A2 acceptance criterion:
  - [ ] No session middleware imported or configured
```

**Rules:**
- Every HARD constraint must appear as an ASSERT or criterion in at least one task
- Every rejected option must appear as a negative ASSERT or criterion in the task group most likely to reintroduce it
- Populate `affects_groups` on each constraint and decision in the decision record
- If a constraint cannot be meaningfully encoded as an assertion (e.g., "code must be maintainable"), note it as a Known Risk with an explicit reason

### Step 5: File Conflict Check

Before finalizing the plan, run a static analysis:

1. List every file touched by every task across all groups
2. Flag any file that appears in more than one group

```
File conflict check:
  src/auth/middleware/requireAuth.ts — Group A (Task A1) only ✓
  src/api/users/route.ts            — Group B (Task B2) only ✓
  src/types/index.ts                — Group A (Task A1) AND Group B (Task B3) ⚠ CONFLICT
```

**Resolve every conflict before proceeding.** Options:
- Reassign: move the conflicting task to one group
- Split the file: define which group owns which section (with exact line ranges if needed)
- Sequence: make one group's task depend on the other's completion
- Merge point: explicitly designate a merge task that runs after both groups finish

No unresolved file conflicts in the final plan.

**Render-check coverage check:** If the design contained `[RENDER-CHECK NEEDED]` flags (collected in Step 1), verify that every flag appears in at least one task's acceptance criteria. List the results:

```
Render-check coverage:
  [flag 1: decision description] — Task [X] acceptance criterion ✓
  [flag 2: decision description] — ⚠ UNASSIGNED
```

Unassigned flags are plan defects. Either assign each to the closest owning task or add it to Known Risks with an explicit reason. Do not proceed with an unassigned flag silently dropped.

### Step 5.5: Cross-Stage Traceability Check

After writing all task specs, verify constraint coverage against the decision record:

1. Read `.context/specs/<feature>/decisions.yaml`
2. For each entry:

| Entry type | Required traceability |
|---|---|
| HARD constraint | Must appear as ASSERT or acceptance criterion in at least one task |
| Rejected option | Must appear as negative ASSERT or acceptance criterion in the task group most likely to reintroduce it |
| SOFT constraint | Should appear (log as known risk if not traced) |
| Assumption (unvalidated) | Must appear in Known Risks section |
| Waiver | Must appear in Known Risks section with mitigation |

3. Report traceability results using `references/plan-template.md` Constraint Traceability section

**Untraced HARD constraints and rejected options are plan defects.** Fix them before presenting the plan.

### Step 6: STOP — Present Plan and Wait for Approval

Write the complete plan using `references/plan-template.md`.

Save the plan to disk:
1. Derive the feature name from the design title (kebab-case, matching the design's feature name)
2. `mkdir -p .context/specs/<feature>/`
3. Write the plan to `.context/specs/<feature>/plan.md`

Then STOP. Display exactly this gate:

```
---
**Plan ready for review.**

**Saved to:** `.context/specs/<feature>/plan.md`

Groups: [N]
Total tasks: [N]
File conflicts: None (resolved)
Waived review findings carried forward: [N or "none"]

Review each task group. Pay attention to:
- Do the file paths look right?
- Are the test cases sufficient?
- Are the acceptance criteria tight enough?
- Is the group sequencing correct?

Say "approved" to proceed to `/team-build`.
If anything needs adjusting, tell me what to change.
---
```

<!-- GATE: plan-approval — Plan approved, no file conflicts before /team-build -->
**Do not proceed to /team-build or write any code until the user explicitly approves this plan.**

---

## What Makes a Good Plan vs. a Bad Plan

### Bad plan (builder has to guess)

```
Task: Add user authentication
Files: auth module
Approach: Follow the existing auth pattern
Tests: Write tests for the auth flow
Acceptance: Authentication works
```

### Good plan (builder executes, doesn't design)

```
Task A2: Add requireAuth middleware
File: src/auth/middleware/requireAuth.ts [CREATE]
Approach: JWT validation middleware. Reads Authorization header, verifies with
  jsonwebtoken using JWT_SECRET env var. On failure: returns 401 with
  { error: "Unauthorized" }. On success: attaches decoded payload to req.user
  and calls next(). Follows the middleware pattern in code-conventions skill §4.

Interface / signature:
  // From: code-conventions — §4 Express Middleware Pattern
  export const requireAuth: RequestHandler = (req, res, next) => { ... }
  // req.user: { id: string; email: string } (decoded JWT payload)

ASSERT: returns { error: "Unauthorized" } with status 401 when token is missing
ASSERT: returns { error: "Unauthorized" } with status 401 when token is expired or invalid
ASSERT: attaches decoded payload to req.user and calls next() when token is valid

Test cases:
  test_requireAuth_valid_token:
    Setup:  valid JWT signed with JWT_SECRET
    Action: GET /api/protected with Authorization: Bearer <token>
    Assert: next() called, req.user.id === token payload id
    Teardown: none

  test_requireAuth_missing_token:
    Setup:  no Authorization header
    Action: GET /api/protected
    Assert: status 401, body.error === "Unauthorized"

  test_requireAuth_expired_token:
    Setup:  expired JWT (exp in the past)
    Action: GET /api/protected with Authorization: Bearer <expired-token>
    Assert: status 401, body.error === "Unauthorized"

Acceptance criteria:
  - [ ] Middleware exported from src/auth/middleware/requireAuth.ts
  - [ ] Returns 401 { error: "Unauthorized" } when token is missing
  - [ ] Returns 401 { error: "Unauthorized" } when token is expired or invalid
  - [ ] Attaches decoded payload to req.user when token is valid
  - [ ] All 3 test cases pass

Pre-conditions: JWT_SECRET documented in .env.example (Task A1 complete)
```

### Good plan (data domain — dbt model)

**Bad:**
```
Task B1: Add weekly revenue model
File: models/marts/fct_user_revenue_weekly.sql [CREATE]
Code pattern:
  WITH source AS (SELECT * FROM {{ ref('stg_payments') }}),
  agg AS (
    SELECT user_id, DATE_TRUNC('week', paid_at) AS week_start,
           SUM(COALESCE(amount, 0)) AS revenue_usd
    FROM source GROUP BY 1, 2
  )
  SELECT * FROM agg
```

**Good:**
```
Task B1: Add weekly revenue model
File: models/marts/fct_user_revenue_weekly.sql [CREATE]
Approach: Aggregate payments to user-week grain. Follows analytics-engineering skill §3 mart conventions.

Interface / signature (schema.yml):
  - name: fct_user_revenue_weekly
    columns:
      - name: user_id        # FK to dim_users
      - name: week_start     # grain: one row per user per week (Monday)
      - name: revenue_usd    # null-safe: source nulls → 0.00

ASSERT: aggregation is at user-week grain (no duplicate user_id + week_start combinations)
ASSERT: revenue_usd is NULL-safe (source nulls → 0.00, not dropped)
ASSERT: no rows from before project launch date 2023-01-01

Acceptance criteria:
  - [ ] dbt test: unique user_id + week_start passes
  - [ ] dbt test: not_null revenue_usd passes
  - [ ] Row count matches control total from stg_payments
```

---

## Anti-Patterns (Do Not Do These)

- **Don't use vague file paths.** "The users module" is not a path. `src/api/users/route.ts` is.
- **Don't transcribe implementation bodies.** Write the interface + invariants (ASSERT lines). Full code bodies waste context budget and crowd out builder reasoning. The builder infers how to implement from the contract + scope file + domain skills.
- **Don't write acceptance criteria you can't verify.** "Works correctly" fails this test. Exception: render-check criteria (from `[RENDER-CHECK NEEDED]` design flags) are lead-verified via visual inspection — see Step 4f.
- **Don't define tests after the plan.** Tests are part of the plan. If you can't name the tests now, the task is underspecified.
- **Don't leave file conflicts.** Even one unresolved conflict can cause a mid-build merge disaster.
- **Don't make groups too large.** A group a builder can't finish in one focused session is too large.
- **Don't ignore waived review findings.** They belong in the plan as known risks with explicit mitigations.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "Design is detailed enough to build from" | Designs describe what. Plans describe how, where, and in what order. |
| "I'll figure out details during build" | Details during build = decisions under pressure with incomplete info. |
| "File paths don't need to be exact yet" | Vague paths cause file conflicts, ownership ambiguity, builder guessing. |
| "Acceptance checks can be defined during implementation" | Checks defined in the plan ARE the acceptance criteria. Undefined checks = undefined acceptance. |
| "One big task group is simpler" | One group = one builder, no parallelism, single point of failure. |

---

## Rollback

Accepts rollback from `/team-build` when the plan is under-specified or structurally flawed.

**Re-entry points:**
- **Step 2** (Identify Task Boundaries) — if the structural decomposition was wrong (wrong seams, wrong dependencies)
- **Step 4** (Write Complete Task Specifications) — if individual task specs were under-specified but structure was sound

**Trigger:** Build lead identifies that builders are guessing or that file conflicts emerged that the plan should have caught.

---

## Context Discipline

**Read:**
- `.context/specs/<feature>/design.md` — always (standard location)
- `.context/specs/<feature>/review.md` — always (standard location; carry waived MUST-FIX as known risks)
- `.context/specs/<feature>/decisions.yaml` — always (constraint injection and traceability check)
- `CLAUDE.md` — always (conventions, guardrails)
- 2-4 relevant project skills — transcribe patterns into task specs
- Specific source files — only to confirm exact paths and existing function signatures for MODIFY tasks

**Write:**
- `.context/specs/<feature>/plan.md` — the completed plan (Step 6)
- `.context/specs/<feature>/decisions.yaml` — updated with `affects_groups` mappings (Step 4.5)

**Do NOT read:**
- Entire codebase
- Unrelated skills
- Files not touched by the design

---

## Model Tier

**Tier:** Opus (current session)
**Rationale:** Task decomposition requires architectural judgment — identifying seams, catching file conflicts, writing complete specs. Opus-level reasoning ensures the plan is detailed enough that builders never have to guess.

---

## Resource Files

### [references/plan-template.md](references/plan-template.md)
Complete plan document template. Used in Step 6 to write and save the final plan.

### [references/domain-task-patterns.md](references/domain-task-patterns.md)
Canonical task spec examples for all 6 supported domains: analytics-engineering, data-engineering, data-science, llm-engineering, agentic-systems, financial-analytics. Transcribe the relevant pattern directly into task specs in Step 4.
