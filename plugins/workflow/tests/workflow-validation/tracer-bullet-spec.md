# Workflow Tracer Bullet Test

Synthetic feature designed to validate context preservation across the full workflow pipeline.
Contains deliberate traps that test whether constraints, rejections, and design intent survive
from brief through implementation.

## How to Use

1. Start a fresh Claude Code session in any project with a CLAUDE.md
2. Provide the scenario below as input to `/team-brief`
3. Run the full pipeline: brief → design → review → plan → build
4. After build completes, run the checklist at the bottom to score context preservation

## The Scenario

**User request:** "Add a rate limiter to our API. We get about 100 requests per second and need
to limit abusive clients to 20 requests per minute."

### Trap 1: Rejected Alternative (tests REJECTION claim extraction)

During `/team-design`, the design should evaluate:
- Option A: Redis-backed sliding window (requires new dependency)
- Option B: In-memory token bucket (no new dependencies)

The project has a HARD constraint: "no new runtime dependencies without explicit approval."
Therefore Option A (Redis) must be rejected. If the builder later adds `ioredis` or `redis`
as a dependency, the constraint was lost.

**Validation:** Does the built implementation avoid Redis/external dependencies?

### Trap 2: Non-Obvious Constraint (tests constraint injection)

The rate limiter must use the client's API key, not IP address, for identification. This is
because the service runs behind a load balancer that masks client IPs.

If the builder implements IP-based rate limiting (the default assumption), the constraint was lost.

**Validation:** Does the implementation key on API key, not IP address?

### Trap 3: Implicit Design Decision (tests decision record propagation)

The design should specify that rate limit headers (X-RateLimit-Remaining, X-RateLimit-Reset)
must be returned on EVERY response, not just 429 responses. This is a common oversight —
builders typically only add rate limit headers to the rejection response.

**Validation:** Are rate limit headers present on 200 responses, not just 429?

### Trap 4: Acceptance Criteria Fidelity (tests spec compliance review)

The plan should specify: "429 response body must include `retryAfter` field with seconds
until reset (integer, not ISO timestamp)."

A builder might return `retryAfter` as an ISO timestamp string, or omit it entirely, or
name the field `retry_after` (snake_case vs camelCase).

**Validation:** Is the 429 response body exactly `{ error: "Rate limit exceeded", retryAfter: <integer> }`?

### Trap 5: Cross-Group Contamination (tests builder isolation)

If the plan has multiple groups (e.g., Group A: rate limiter middleware, Group B: rate limit
configuration endpoint), Group B's builder should not modify Group A's middleware file.

**Validation:** Did each builder only modify files in its ownership list?

## Scoring Checklist

Run after `/team-build` completes. For each trap:

| # | Trap | What to Check | Pass/Fail |
|---|------|--------------|-----------|
| 1 | Rejected alternative | No Redis/external dependency in package.json/requirements | |
| 2 | Non-obvious constraint | Rate limiting keys on API key, not IP address | |
| 3 | Implicit design decision | Rate limit headers on 200 responses, not just 429 | |
| 4 | Acceptance criteria fidelity | 429 body is exactly `{ error: "...", retryAfter: <int> }` | |
| 5 | Cross-group contamination | File ownership respected (check git blame) | |

**Additionally, check the artifacts:**

| Artifact | What to Verify |
|----------|---------------|
| `decisions.yaml` | Contains Redis rejection with reason |
| `decisions.yaml` | Contains API-key-not-IP decision |
| `plan.md` Constraint Traceability | All 3 constraints traced to ASSERT/criteria |
| `pre-build-drift.md` | REJECTION claim for Redis present and CONFIRMED |
| `post-build-drift.md` | All claims CONFIRMED, no MISSING/DIVERGED |
| `build-state.md` | Exists, records group completions |

## Expected Results

**Full pass (6/6 traps + all artifacts):** The pipeline preserved context end-to-end.

**Partial pass:** Identify which trap failed, which stage lost the information, and whether
the failure was in the skill instructions (prompt-level) or the agent's execution (compliance-level).
This distinction determines whether the fix is a skill edit or an acceptance of probabilistic failure.

**Fail (3+ traps):** The pipeline has structural gaps that the current mitigations don't cover.
Investigate which handoff lost the information and why the decision record / constraint injection
/ drift detection didn't catch it.
