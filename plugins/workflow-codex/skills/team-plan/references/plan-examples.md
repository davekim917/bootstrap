# Good Plan vs. Bad Plan — examples

Concrete examples showing the difference between a task spec a builder can execute mechanically and one that forces the builder to redesign during implementation. The main `team-plan/SKILL.md` Step 6 references this file when the planner is checking spec quality.

## Table of contents

- [Software task — auth middleware](#software-task--auth-middleware) — bad vs good
- [Data task — dbt model](#data-task--dbt-model) — bad vs good

The principle in both cases: the bad plan describes *intent*; the good plan describes the *interface, invariants, and assertions* the builder needs to satisfy. Builders execute, don't design — the design happened during `/team-design` and was committed to in `/team-plan`.

---

## Software task — auth middleware

### Bad plan (builder has to guess)

```
Task: Add user authentication
Files: auth module
Approach: Follow the existing auth pattern
Tests: Write tests for the auth flow
Acceptance: Authentication works
```

What's missing: which file, which interface, which invariants, which test cases, which acceptance criteria. The builder has to invent all of it.

### Good plan (builder executes, doesn't design)

```
Task A2: Add requireAuth middleware
File: src/auth/middleware/requireAuth.ts [CREATE]
Approach: JWT validation middleware. Reads Authorization header, verifies with
  jsonwebtoken using JWT_SECRET env var. On failure: returns 401 with
  { error: "Unauthorized" }. On success: attaches decoded payload to req.user
  and calls next(). Follows the Express middleware pattern documented in AGENTS.md/CLAUDE.md.

Interface / signature:
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

The good plan gives the builder exactly enough: where the file goes, what the interface is, what invariants must hold (ASSERTs), what test cases prove them, and what counts as done.

---

## Data task — dbt model

### Bad

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

The bad version transcribes the implementation. That wastes context budget and crowds out the builder's own reasoning about edge cases — they end up copying the snippet rather than thinking about what the model needs to guarantee.

### Good

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

The good version names the contract (schema, grain, null-handling) and the invariants (ASSERTs); the builder writes the SQL that satisfies them. Same shape as the software example: interface + invariants + acceptance, no implementation transcription.
