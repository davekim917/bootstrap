# Root Cause Tracing

## Backward Trace Method

When a bug surfaces, trace backward from the symptom to the origin. Do not start at the beginning and work forward — start at the failure and work backward.

### 5 Steps

1. **Read the error** — full message, not just the first line. Stack traces, error codes, log context.
2. **Identify the failure point** — which function, which line, which assertion failed?
3. **Trace the inputs** — what values arrived at the failure point? Where did they come from?
4. **Find the divergence** — at what point did actual state first differ from expected state? This is the earliest divergence point.
5. **Verify the root** — is this the actual root, or a downstream effect of something earlier? Keep tracing until you reach a point where the code is correct but its input is wrong — the producer of that input is the root cause.

## Common Root Cause Categories

### State Mutation
Shared mutable state modified by an unexpected caller. Symptoms: intermittent failures, order-dependent test results, "it worked yesterday."

**Investigation:** Look for shared variables, global state, module-level caches, singletons modified between calls.

### Timing
Race conditions, async operations completing in unexpected order. Symptoms: flaky tests, works-sometimes failures, different behavior under load.

**Investigation:** Look for missing `await`, unguarded concurrent access, assumptions about execution order, fixed-delay waits.

### Type Mismatch
Wrong type arrives at a function — string instead of number, null instead of object, array instead of single value. Symptoms: `undefined is not a function`, `cannot read property of null`, silent wrong behavior.

**Investigation:** Trace the value backward. Where was it created? What transformations did it pass through? Where did the type change?

### Missing Check
A precondition that should be validated isn't. The function proceeds with invalid input and fails downstream. Symptoms: errors far from the actual cause, confusing stack traces.

**Investigation:** What assumptions does the failing code make about its inputs? Are those assumptions validated at the boundary?

### Configuration
Wrong environment variable, missing config key, default value used instead of actual. Symptoms: works in dev but not prod, works for one user but not another.

**Investigation:** Log the actual config values at runtime. Compare dev vs prod configs. Check for missing `.env` entries, typos in variable names, case sensitivity.

### Dependency
External service changed, package upgraded with breaking change, peer dependency conflict. Symptoms: sudden failure without code changes, works with old lockfile.

**Investigation:** Check recent dependency updates (`git diff` on lockfile), service changelogs, deprecation notices.

## Evidence Standard

A root cause claim requires evidence, not assertion.

**Not evidence:**
- "I think the problem is..."
- "It's probably..."
- "The error message says..."  (error messages describe symptoms, not causes)

**Evidence:**
- "In [file:line], the value is [X] but should be [Y], as confirmed by [log output / test / debugger]"
- "The state diverges at [function], where [input] produces [wrong output] because [specific code path]"
- "Reproduction test confirms: [test name] fails with [exact error] when [specific condition]"
