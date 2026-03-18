---
name: team-tdd
description: >
  Test-driven development enforcement. Iron law: no production code without a failing test first.
  RED-GREEN-REFACTOR cycle with gates at each step. Applies across all domains: software unit/integration
  tests, dbt schema and data tests, data quality checks (Great Expectations, Soda, custom assertions),
  ML evaluation metrics, and analytics query assertions. Includes rationalization resistance table
  to counter common excuses for skipping TDD. Apply during /team-build, bug fixes, and refactoring.
version: 1.0.0
---

# /team-tdd — Test-Driven Development Enforcement

## What This Skill Does

Enforces test-first development discipline. Iron law: **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**

**Output:** Code with test-first coverage — every behavior change verified by a test written before the code.
**NOT output:** Test-after retrofits. Tests written to confirm code that already works are validation theater, not TDD.

## When to Use

- During `/team-build` — builders apply TDD for every task
- Bug fixes — reproduction test before fix (see `/team-debug`)
- Refactoring — existing tests green before and after

**Do NOT use for:**
- Spikes and prototypes (throwaway code)
- Configuration changes (no behavioral logic)
- Documentation-only changes
- One-off exploratory analysis (ad-hoc SQL queries, EDA notebooks, data profiling)
- Schema-only changes with no behavioral logic (adding a column description, updating YAML metadata)
- Dashboard layout changes (styling, chart positioning — not metric calculation logic)

## Cross-Domain Application

Read `.claude/project-scope.md`. The active rows in the table below are those matching the
project's `domains` list. If `relevant_global_skills` is empty and no row matches your domain,
use `quality_gates` and `description` from the scope file to define what "a failing test" means
for this project. For financial analytics specifically: if `financial-analytics` is in domains,
use the Financial Analytics row — which corresponds to control-total assertions and
reconciliation checks.

The RED-GREEN-REFACTOR cycle is universal. The vocabulary differs by domain:

| Domain | RED (failing test) | Run → FAIL | GREEN (make it pass) | Run → PASS | REFACTOR |
|---|---|---|---|---|---|
| Software | Write unit/integration test | `pytest`/`jest` fails | Write production code | `pytest`/`jest` passes | Clean code, re-run tests |
| Analytics Engineering | Write dbt test (`schema.yml` or singular) | `dbt test` fails (model missing or violates) | Write model SQL | `dbt test` passes | Refactor CTEs/SQL, re-run `dbt test` |
| Data Engineering | Write data quality check (GE, Soda, custom) | Quality check fails (no data yet) | Build pipeline / transformation | Quality check passes | Refactor pipeline, re-run checks |
| ML / Data Science | Define eval metric threshold | Evaluation fails (below baseline) | Train model / engineer features | Eval meets threshold | Refactor features/training, re-evaluate |
| Analytics | Write query assertion against control total | Query returns wrong/no result | Build query / metric logic | Query matches control total | Refactor query, re-run assertions |
| Mobile (React Native / Expo) | Jest + `@testing-library/react-native` test or Detox E2E spec asserting component behavior | `jest` fails (component/screen missing or wrong output) | Implement RN component, screen, or hook | `jest` passes | Apply `vercel-react-native-skills`: memoize list items, `StyleSheet.create`, move callbacks outside render → rerun tests |
| Financial Analytics | Reconciliation check: calculated total vs known source (GL, prior period, filing) shows variance outside tolerance | Check fails because model / calculation not built | Build GL model, financial calculation, or transformation | Reconciliation passes within tolerance | Optimize query, tighten tolerance, improve period logic → re-run checks |
| AI / LLM Integration | Write eval assertion: expected input → expected output format/content/quality | Eval harness fails (wrong shape, below threshold, or API not called yet) | Implement prompt template, chain, or agent logic | Eval assertion passes; response matches schema and quality threshold | Improve prompt clarity, reduce token cost, add retry logic → re-run evals |

### What Counts as a "Failing Test" by Domain

- **Software:** A test file (`*.test.ts`, `test_*.py`) that asserts expected behavior and fails when run
- **Analytics engineering:** A dbt test — `unique`, `not_null`, `relationships`, `accepted_values` in `schema.yml`, or a singular test SQL file — that fails against the current state
- **Data engineering:** A data quality check (Great Expectations suite, Soda check, custom assertion) that fails because the data/table doesn't exist or violates the defined expectation
- **ML / Data science:** An evaluation metric assertion (`accuracy >= 0.85`, `RMSE < threshold`) that fails against the untrained/baseline model
- **Analytics:** A query assertion — the query result checked against a known control total, a finance report, or a manually calculated value — that doesn't match
- **Financial analytics:** A reconciliation check — comparing calculated figures against a known source (GL, prior period, regulatory filing) — that shows a variance outside tolerance
- **Mobile (React Native):** A Jest + `@testing-library/react-native` test asserting expected render or interaction — fails because the component doesn't exist yet.
- **AI / LLM integration:** An eval assertion in an evaluation harness (`*.eval.py`, `evals/`, or equivalent) that checks expected input → expected output shape/content and fails because the prompt, chain, or agent doesn't exist yet or produces wrong output.

## Process

### Step 1: Write Failing Test (RED)

1. Read the task spec — what behavior needs to exist?
2. Write a test that asserts the expected behavior
3. Run the test
4. Confirm it **FAILS** for the expected reason (not a syntax error, not a wrong import — the actual missing behavior)

**Gate:** Test must fail before proceeding. If it passes, either the behavior already exists (no code needed) or the test is wrong.

**Domain examples:**
- **dbt:** Add `unique` + `not_null` tests to `schema.yml` for new model → `dbt test` fails (model doesn't exist)
- **Data quality:** Define expectation (row count > 0, no nulls in key column) → check fails (table empty/missing)
- **ML:** Define `accuracy >= 0.85` threshold from baseline → evaluate untrained model → below threshold
- **Analytics:** Get control total from finance report → write assertion query → result doesn't match (table not built)

### Step 2: Write Minimal Code (GREEN)

1. Write the minimum code to make the failing test pass
2. Do not write more than what the test demands
3. Run the test — confirm PASS
4. Run the full test suite — confirm no regressions

**Gate:** All tests pass. If the new test passes but others break, fix the regression before proceeding.

**Domain examples:**
- **dbt:** Write model SQL → `dbt run` → `dbt test` passes (unique keys, no nulls)
- **Data quality:** Build pipeline → run quality check → row count > 0, no null keys
- **ML:** Train model → evaluate → accuracy meets 0.85 threshold
- **Analytics:** Build transformation query → run assertion → matches finance control total

### Step 3: Refactor (REFACTOR)

1. Clean up the code you just wrote — extract, rename, simplify
2. Clean up the test if needed — but do not change what it asserts
3. Run the full test suite

**Gate:** All tests still green. If refactoring breaks a test, undo the refactor and try again.

**Domain examples:**
- **dbt:** Refactor CTEs, improve column naming, optimize materialization → `dbt test` still passes
- **Data quality:** Extract common transforms, improve error handling → quality checks still pass
- **ML:** Refactor feature engineering, clean training pipeline → evaluation metrics unchanged
- **Analytics:** Optimize query performance, improve readability → assertion still matches

### Step 4: STOP — Verify Cycle

Before moving to the next task, confirm:
- [ ] Test existed before production code
- [ ] Test failed before production code was written
- [ ] Test passes after production code was written
- [ ] Full suite still passes

If any of these are false, you skipped TDD. Go back.

## Rationalization Resistance

These are not valid reasons to skip TDD:

| Excuse | Counter |
|--------|---------|
| "Too simple to test" | Simple code has simple tests. Write it in 30 seconds. If it's truly trivial, the test is trivial too. |
| "I'll write the test after" | Test-after verifies your implementation, not the behavior. You're testing that you typed what you typed. |
| "Time pressure" | The test IS the shortcut. It catches regressions immediately instead of 3 hours into debugging. |
| "One-line change" | One-line changes cause production outages. The test takes one line too. |
| "I know this works" | You knew the last bug "worked" too. The test is for future-you and other agents. |
| "The test would be tautological" | Then you're testing the wrong thing. Test the observable behavior, not the implementation. |
| "I need to see the shape first" | Write the test as a spec. The shape IS the test — what goes in, what comes out. |
| "It's just glue code" | Glue code is where integration bugs live. Test the contract: does A's output become B's input correctly? |
| "The framework handles this" | You're not testing the framework. You're testing that you configured it correctly. |
| "dbt tests are just schema checks" | Schema tests catch nulls, duplicates, and broken joins — the top 3 data bugs. Write them first. |
| "I'll validate the data after the pipeline runs" | After-the-fact validation is test-after. Define the check, watch it fail, then build. |
| "ML metrics are evaluated at the end" | Define the threshold before training. Otherwise you're fitting the criterion to the result. |
| "Queries don't need tests" | Queries encode business logic. A wrong join or filter silently produces wrong numbers with no error. Assert first. |
| "Financial reconciliation comes later" | Reconciliation IS the test. Define the expected total before building the calculation. |

## Red Flags

Stop immediately if you catch yourself thinking:

- "Let me just get this working first, then I'll add tests"
- "I'll circle back to tests after the implementation"
- "This is obvious, it doesn't need a test"
- "I'll test the whole thing at the end"
- "The acceptance criteria are the tests" (they're not — they're what the tests verify)
- "Let me just run the pipeline first, then I'll add quality checks"
- "I'll set the evaluation threshold after I see the model's performance"
- "Let me build the dbt model first, then add schema tests"
- "The query looks right, I don't need to check it against a control total"
- "I'll add data tests after I see what the data looks like"
- "The pipeline worked in dev, it'll work in prod"

These thought patterns are the precursor to test-after code. Recognize them and redirect to RED.

## Spirit vs. Letter

**Spirit:** Every behavior change is verified by an automated test written before the production code.

**Letter:** RED-GREEN-REFACTOR cycle with gates.

Follow the spirit. The letter is the mechanism that ensures the spirit is followed. If you find a situation where the letter doesn't apply but the spirit does, follow the spirit.

## Anti-Patterns (Do Not Do These)

- **Backfilling tests:** Writing production code, then writing tests that pass. This is test-after, not TDD.
- **Tautological assertions:** `expect(add(2,3)).toBe(add(2,3))` — tests nothing.
- **Testing implementation details:** `expect(spy).toHaveBeenCalledTimes(3)` — breaks on correct refactors.
- **Skipping RED:** Writing a test that passes immediately means you didn't need to write code, or the test is wrong.
- **Giant test then giant code:** Write one test, make it pass, write the next test. Not: write 10 tests, then write all the code.
- **Modifying tests to make them pass:** If a test fails, the production code is wrong, not the test (unless the spec changed).
- **Post-hoc thresholds:** Training an ML model, observing metrics, then setting the threshold to match. The threshold must exist before training.
- **Test-after data validation:** Building the dbt model or pipeline, then adding tests that describe what already exists. Tests first.
- **Control-total skipping:** Building a revenue query without comparing against a known correct value. Eyeballing is not validation.
- **Schema-test-only coverage:** Having only `unique` and `not_null` dbt tests but no data/logic tests. Schema tests are necessary but not sufficient.

## Context Discipline

**READ:** Task spec, existing test files, production files under modification.
**WRITE:** Test files first, then production files.
**DO NOT READ:** Unrelated source files, other builders' files, the full plan.

## Model Tier

- **Sonnet** (builders): TDD cycle is embedded in builder prompts via `/team-build`
- **Opus** (direct invocation): When user explicitly calls `/team-tdd`

The rationalization resistance table is static content — it is embedded in the skill, not generated at runtime.
