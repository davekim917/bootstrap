# Defense in Depth

## Boundary Guard Principle

Add guards at system boundaries — where data enters from external sources, where modules interface, where user input arrives. Do not add guards deep inside trusted internal code.

**Boundary examples:**
- API request handlers (user input)
- Database query results (external system)
- File I/O operations (filesystem)
- Third-party API responses (external service)
- Message queue consumers (async input)
- Environment variable reads (configuration)

**Not boundaries (do not guard):**
- Internal function calls within a module
- Private methods called by the same class
- Helper functions with known callers
- Values already validated upstream

## Guard Types

### Input Validation
Validate shape, type, and range of external input at the boundary. Reject invalid input early with clear error messages.

```
// At the boundary
function handleRequest(body) {
  if (!body.email || typeof body.email !== 'string') {
    throw new ValidationError('email is required and must be a string');
  }
  // Internal code can now trust body.email is a string
}
```

### Type Assertions
Assert expected types when consuming data from external systems (DB results, API responses, parsed JSON).

```
// After external system call
const user = await db.findUser(id);
if (!user) {
  throw new NotFoundError(`user ${id} not found`);
}
// Internal code can now trust user exists
```

### Null Checks
Check for null/undefined at boundaries where external data may be missing. Do not sprinkle null checks throughout internal code — validate once at entry.

### Timeout Guards
Set explicit timeouts on external operations. Never wait indefinitely for a network call, database query, or file operation.

```
const result = await Promise.race([
  fetchExternalData(),
  timeout(5000, 'external data fetch')
]);
```

### Retry Limits
When retrying failed operations, set explicit limits. Unbounded retries are infinite loops.

```
const MAX_RETRIES = 3;
for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  try {
    return await operation();
  } catch (err) {
    if (attempt === MAX_RETRIES - 1) throw err;
  }
}
```

## When to Add Guards During Debugging (Phase 4)

After fixing a root cause in Phase 4, ask: "Would a boundary guard have caught this earlier?"

Add a guard if:
- The root cause was invalid data crossing a boundary without validation
- The error surfaced far from where the bad data entered
- The same boundary could receive similar bad data in the future

Do not add a guard if:
- The root cause was internal logic error (fix the logic, don't guard around it)
- The boundary already has validation (the guard wouldn't have helped)
- The guard would mask the real error (defensive code that silently swallows problems)
