---
name: team-plan
description: >
  Invoke after /team-review clears. Produces an execution plan at docs/specs/<feature>/plan.md.
  Do NOT write plans manually — this skill has task decomposition rules, conflict checks, and
  constraint injection that only load when invoked.
version: 1.1.0
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
1. **Design document** — check `docs/specs/<feature>/design.md` first (standard location from `/team-design`); ask user to provide it if not found
2. **Review report** — check `docs/specs/<feature>/review.md` first (standard location from `/team-review`); ask user to provide it if not found. Carry forward any waived MUST-FIX items as known risks in the plan. Also carry forward any reviewer fallback notes (e.g., "Reviewer B timed out — fell back to Claude") as known risks: note that adversarial blind-spot coverage may be reduced. Scan review.md for `[NEEDS SPEC]` tags; resolve each to concrete spec text on a specific task or escalate as a Known Risk before /team-build.

   **Render-check flag scan:** After reading the design document, scan it for `[RENDER-CHECK NEEDED]` flags and note each flagged decision. Task assignment for these flags happens in Step 2 (once task boundaries are identified) — complete the flag-to-task mapping after Step 2, then use it in Step 4f to add render-check acceptance criteria to the relevant tasks.
3. **CLAUDE.md** — tech stack, conventions, critical guardrails
4. **Project scope** — read `docs/project-scope.md` if it exists. Determines which domain skills to load and provides implementation conventions (primary language, framework, test framework). If not present, proceed without it.
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

**b.5) Test file path (required unless task produces non-testable artifact)**

Every task producing testable code MUST include an exact test file path in the task spec,
formatted as `**Test file:** exact/path/to/file.test.ts`. Use the project's test convention
from CLAUDE.md (co-located `.test.ts`, `__tests__/file.spec.ts`, top-level `tests/`, etc.).

**The test file is a first-class owned file** — it must also appear in the File Ownership
Map at the top of the plan as a separate row, with the same Group/Task assignment as the
production file. Builders own BOTH files and are responsible for producing BOTH. A task
that ships without its test file is a `/team-build` acceptance failure (see
`/team-build` Step 5 named-test-cases pre-flight gate).

**Omission is allowed ONLY for tasks with no testable code** — e.g. a pure SQL migration
(tested end-to-end at integration level), a static JSON data file, a docs-only edit. In
these cases, write `**Test file:** none — reason: [specific reason]` in place of the path,
and carry the reason forward into the Integration Checklist so `/team-build` knows this
task is legitimately test-less rather than missing tests by oversight.

**Do NOT omit the test file for tasks that COULD have unit tests but "seem small".** If
the code has branching logic, input validation, error paths, or any behavior the plan
specifies in ASSERT lines, it has testable code and requires a test file.

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

**LLM-consumer tasks:** If a task includes any LLM call, specify the prompt input shape and trace each input field to (a) a touched schema column or (b) an explicit runtime computation. Empty-string LLM inputs (e.g., `content: ''` because schema only has `id`) are spec defects; surface at plan time.

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
Write test cases by name before the code exists. These are the RED-side artifact for the cross-cutting `team-tdd` protocol that builders apply during implementation — the names and assertions you write here become the failing tests builders run before writing production code. If you can't name the test now, the task is underspecified.

Format:

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

Read `docs/specs/<feature>/decisions.yaml`. For each HARD constraint and each rejected option:

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

**Symbol dependency check (parallel groups only):** For each parallel group, list symbols (functions, constants, types, exports) imported from another parallel group. Resolve any dependency at plan time — either (a) sequence the dependent group after the provider, or (b) move the shared symbol into a sequentially-earlier group (typically Group A) or shared module loaded before both. No runtime fallbacks or temporary coupling workarounds for parallel siblings.

```
Symbol dependency check:
  Group B imports <SHARED_CONST> from Group C — ⚠ DEPENDENCY (resolve before parallel spawn)
  Group D imports nothing from B/C — ✓
```

**Test file coverage check:** In the same pass, verify every task has a `**Test file:**`
field populated — either with an exact test file path OR with an explicit
`none — reason: [specific reason]` for legitimately non-testable tasks (migrations tested
via integration, static data files, docs-only edits). Tasks with neither are plan defects.

```
Test file coverage:
  Task A1 (migration 001)         — Test file: none — reason: integration-tested ✓
  Task A2 (validateUser function) — Test file: src/auth/validateUser.test.ts     ✓
  Task B1 (visit log service)     — Test file: **MISSING** ⚠ DEFECT
```

Do not proceed with a missing test file field silently. Either add the path, or add the
explicit "none — reason: [X]" note and carry the reason into the Integration Checklist so
`/team-build`'s named-test-cases pre-flight knows this task is legitimately test-less.

**Render-check coverage check:** If the design contained `[RENDER-CHECK NEEDED]` flags (collected in Step 1), verify that every flag appears in at least one task's acceptance criteria. List the results:

```
Render-check coverage:
  [flag 1: decision description] — Task [X] acceptance criterion ✓
  [flag 2: decision description] — ⚠ UNASSIGNED
```

Unassigned flags are plan defects. Either assign each to the closest owning task or add it to Known Risks with an explicit reason. Do not proceed with an unassigned flag silently dropped.

### Step 5.5: Cross-Stage Traceability Check

After writing all task specs, verify constraint coverage against the decision record:

1. Read `docs/specs/<feature>/decisions.yaml`
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
2. `mkdir -p docs/specs/<feature>/`
3. Write the plan to `docs/specs/<feature>/plan.md`

**CRITICAL — how to write the plan file:**

Plans with 3+ task groups routinely exceed 400 lines. A single monolithic `Write` tool call
for a long plan risks hitting the per-turn output-token ceiling mid-generation, producing a
silently truncated file. Worse, attempting to "append the rest" via a second `Write` call to
the same path will **overwrite** the first write entirely — `Write` never appends.

**DO use the Write-skeleton-then-Edit pattern for any plan with more than 3 task groups or
where the expected length exceeds ~300 lines:**

1. **First `Write`** — skeleton only: header, overview, dependency graph, and empty section
   stubs for each group (e.g. `## Group A: Data Layer\n\n_To be filled._`). Keep this
   skeleton under ~150 lines. It should fit comfortably in one turn.
2. **Subsequent `Edit` calls** — one per group, replacing each `_To be filled._` stub with
   that group's full task spec. Each Edit is scoped to a single group, so per-turn output
   stays well under the ceiling even for large groups.
3. **Final verification** — after all Edits, `grep '^## Group' <plan-file>` to confirm every
   group you intended is present. If any are missing, you hit a partial write — re-run the
   Edit for that specific group, do not re-Write the whole file.

**DO NOT** do back-to-back `Write` calls to the same file thinking the second will append.
`Write` always overwrites. If you find yourself about to do a second `Write` to the same
path, stop and use `Edit` with a specific `old_string` anchor instead.

**DO NOT** attempt a single monster `Write` for plans > ~500 lines. Output-token budgets
deplete mid-tool-call and the tool call can be emitted with empty or truncated input,
producing either an InputValidationError or a silently incomplete file. Neither failure mode
is reliably surfaced to you in the same turn.

Both failure modes have been observed in production on large-context plan sessions. The
skeleton-then-Edit pattern avoids both entirely.

Then STOP. Display exactly this gate:

```
---
**Plan ready for review.**

**Saved to:** `docs/specs/<feature>/plan.md`

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

A bad plan describes intent ("add user authentication"); a good plan describes the *interface, invariants (ASSERTs), test cases, and acceptance criteria* the builder needs to satisfy. Builders execute, don't design — design happened during `/team-design`.

Concrete bad-vs-good examples for both software (auth middleware) and data (dbt model) domains live in [`references/plan-examples.md`](references/plan-examples.md). Read it when you're checking whether a task spec is ready to hand to a builder.

---

## Anti-Patterns

Each pattern below leads with the failure mode the rule is preventing. Read these as the cost of the shortcut, not as commandments.

- **Vague file paths cause ownership ambiguity, file conflicts, and builders guessing where to put things** — and when two builders guess differently, you get a mid-build merge disaster. "The users module" is not a path; `src/api/users/route.ts` is. Use exact paths.
- **Full code bodies in task specs waste context budget and crowd out builder reasoning** — the builder ends up transcribing your code rather than thinking about the contract. Write the interface plus invariants (ASSERT lines); let the builder infer the implementation from the contract, scope file, and domain skills.
- **Acceptance criteria you can't verify don't actually accept anything** — "works correctly" passes any output, including broken ones. Every criterion must be objectively checkable. Render-check criteria (from `[RENDER-CHECK NEEDED]` design flags) are the one exception: lead-verified via visual inspection — see Step 4f.
- **Tests defined after the plan are tests defined under build pressure** — they end up shaped to whatever was convenient to write, not what the spec actually requires. If you can't name the tests during planning, the task is underspecified. Define tests as part of the plan.
- **An unresolved file conflict between groups becomes a merge disaster mid-build** — and the longer it goes undetected, the more rework downstream. Resolve conflicts in the plan, not during build.
- **A group too large for one builder session leads to mid-task context compression and silent dropped work** — symptoms surface late, often as missed acceptance criteria. Size groups so a focused builder can finish in one session.
- **Waived review findings that don't appear in the plan become invisible risks** — the build proceeds as if they were resolved. Capture every waived finding in the plan as a known risk with explicit mitigation.

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
- `docs/specs/<feature>/design.md` — always (standard location)
- `docs/specs/<feature>/review.md` — always (standard location; carry waived MUST-FIX as known risks)
- `docs/specs/<feature>/decisions.yaml` — always (constraint injection and traceability check)
- `CLAUDE.md` — always (conventions, guardrails)
- 2-4 relevant project skills — transcribe patterns into task specs
- Specific source files — only to confirm exact paths and existing function signatures for MODIFY tasks

**Write:**
- `docs/specs/<feature>/plan.md` — the completed plan (Step 6)
- `docs/specs/<feature>/decisions.yaml` — updated with `affects_groups` mappings (Step 4.5)

**Do NOT read:**
- Entire codebase
- Unrelated skills
- Files not touched by the design

---

## Model Tier

**Tier:** Current session model (inherited)
**Rationale:** Task decomposition requires architectural judgment — identifying seams, catching file conflicts, writing complete specs. Frontier-tier reasoning ensures the plan is detailed enough that builders never have to guess.

---

## Resource Files

### [references/plan-template.md](references/plan-template.md)
Complete plan document template. Used in Step 6 to write and save the final plan.

### [references/domain-task-patterns.md](references/domain-task-patterns.md)
Canonical task spec examples for all 6 supported domains: analytics-engineering, data-engineering, data-science, llm-engineering, agentic-systems, financial-analytics. Transcribe the relevant pattern directly into task specs in Step 4.
