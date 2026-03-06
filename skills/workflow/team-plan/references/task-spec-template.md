# Single Task Specification Template

Reference for writing individual task specs in Step 4. Each task must satisfy all fields.

---

## Task [GROUP][NUM]: [Name]

**File:** `exact/path/to/file.ext`
**Operation:** CREATE | MODIFY | DELETE

> For MODIFY: also state which functions/sections change and which must stay untouched.
> Example: "Add `validateToken()` to the existing `auth.ts`. Do not modify `login()` or `logout()`."

**Approach:**
[2-4 sentences. Answer: What is being built? Why this approach over alternatives? Which project
convention does it follow? What is the non-obvious decision the builder should know about?]

Cite source: "Follows [skill-name] §[section]" or "Per CLAUDE.md §[section]."

**Interface / signature:**

Specify the observable contract for this artifact. Format by artifact type:
- Python function: `def fn_name(param: Type, ...) -> ReturnType` — signature + type hints only
- TypeScript / React component: `interface Props { ... }` — props shape only
- API endpoint: `POST /path — request: { ... }, response: { ... }`
- dbt model: schema.yml column definitions (name + description + grain comment)
- Airflow/Dagster DAG: task IDs + dependency arrows + XCom keys
- Jupyter notebook cell: `Inputs: df (pd.DataFrame, cols: [...]) → Outputs: df_clean (...)`
- SQL / analytics view: column names + grain + filters

```
// From: [skill-name] — [section name]
// Contract for: [this specific task]

[Interface specification — NOT implementation body]
```

**ASSERT annotations** — one line per invariant the builder must satisfy:

```
ASSERT: <observable condition in plain English>
ASSERT: <another invariant>
```

ASSERT lines activate explicit per-assertion verification in `/team-build` spec compliance gate.
Tasks without ASSERT lines fall back to the general criteria check.

> If no project skill covers this: write `[NO SKILL PATTERN]` and explain what the builder
> should use as a reference. Flag this task as higher-risk in the plan overview.

**Test cases:**

Each test case must have a name, setup, action, assertion, and teardown.

```
test_[subject]_[scenario]:
  Setup:    [Exact initial state. What records exist? What env vars are set? What mocks are active?]
  Action:   [The specific thing being tested — function call, HTTP request, event, etc.]
  Assert:   [Exact expected result — status codes, return values, DB row counts, thrown errors]
  Teardown: none | [What to clean up]

test_[subject]_[error_or_edge_case]:
  Setup:    [State that should produce the error or edge behavior]
  Action:   [Same or similar action]
  Assert:   [Exact error response or edge behavior]
  Teardown: none | [cleanup]
```

**Minimum test coverage:**
- 1 happy path test
- 1 error/rejection test
- For data operations: 1 constraint violation test (duplicate, null, foreign key)
- For API endpoints: 1 unauthorized access test
- For async operations: 1 timeout or failure test

**Acceptance criteria:**

Non-negotiable. Stated as verifiable facts, not intentions.
`/team-build` checks these before marking this task complete.

- [ ] [Exact verifiable outcome 1]
- [ ] [Exact verifiable outcome 2]
- [ ] All named test cases pass
- [ ] No TypeScript errors in this file (or equivalent for the project language)
- [ ] [Any specific constraint from the design or review]

**Pre-conditions:**

What must be true before this task can start. Reference specific task IDs.

- [Task A1 complete] — `[file]` must exist with `[export or function]`
- OR: None

---

## Checklist: Is This Task Spec Complete?

Before including a task in the plan, verify:

- [ ] File path is exact and absolute from project root
- [ ] Operation is stated (CREATE / MODIFY / DELETE)
- [ ] Approach cites a project skill or CLAUDE.md section
- [ ] Interface/signature specified for the artifact type (see SKILL.md artifact-type table)
- [ ] ASSERT: lines present for each invariant that must hold
- [ ] Named edge cases listed (not "handle errors" — name the specific cases)
- [ ] At least 2 named test cases with setup + assert
- [ ] Acceptance criteria are verifiable statements (not intentions)
- [ ] Pre-conditions reference specific task IDs (or state "None")

> Note: ASSERT lines in the spec enable explicit per-assertion verification in the `/team-build`
> spec compliance gate. Plans written before this format change will use the general-impression
> check; ASSERT-based checking activates automatically for tasks that include ASSERT annotations.

If any box is unchecked, the task spec is not ready.
