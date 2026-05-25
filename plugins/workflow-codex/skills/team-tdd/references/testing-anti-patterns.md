# Testing Anti-Patterns

Eight anti-patterns that undermine test-driven development, each with a gate function to detect them.

---

## 1. Tautological Tests

**What it looks like:** The test restates the implementation rather than verifying behavior.

```javascript
// Anti-pattern: test mirrors implementation
test('calculates total', () => {
  const result = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(result);
});
```

**Gate:** Would this test fail if the production code were deleted entirely?

If the test reimplements the logic, deleting the production code means the test still computes the same value — it never fails. A real test uses a hardcoded expected value:

```javascript
test('calculates total', () => {
  expect(calculateTotal([{ price: 10 }, { price: 20 }])).toBe(30);
});
```

---

## 2. Implementation-Coupled Tests

**What it looks like:** The test asserts on internal calls, method counts, or private state rather than observable outputs.

```javascript
// Anti-pattern: testing internals
test('fetches data', () => {
  fetchUserData(1);
  expect(httpClient.get).toHaveBeenCalledWith('/users/1');
  expect(cache.set).toHaveBeenCalledTimes(1);
});
```

**Gate:** Would a correct refactor (same behavior, different internals) break this test?

If switching from `httpClient.get` to `fetch` breaks the test while the behavior is identical, the test is coupled to implementation. Test the output:

```javascript
test('returns user data for valid id', async () => {
  const user = await fetchUserData(1);
  expect(user).toEqual({ id: 1, name: 'Alice' });
});
```

---

## 3. Test-After Rationalization

**What it looks like:** Production code is written first, then tests are added that confirm the existing implementation.

The symptom: every test passes on the first run. No test was ever observed to fail. The developer writes code, then writes tests that describe what the code already does.

**Gate:** Was this test run and observed to fail before the production code was written?

If the answer is "no" or "I don't know," this is test-after, not TDD. The test may be correct, but it wasn't driving the development — it's a retroactive description of what happened to be implemented.

**Fix:** Delete the test. Write a new test for the next behavior change. Follow RED-GREEN-REFACTOR from that point forward.

---

## 4. Snapshot Abuse

**What it looks like:** Snapshot tests used as a substitute for behavioral assertions.

```javascript
// Anti-pattern: snapshot as behavior test
test('renders user profile', () => {
  const { container } = render(<UserProfile user={mockUser} />);
  expect(container).toMatchSnapshot();
});
```

**Gate:** Does this snapshot verify behavior, or does it freeze structure?

Snapshots freeze the entire output. Any change — even a correct one like adding a CSS class — breaks the test. The developer updates the snapshot without reading it. The test becomes a rubber stamp.

**When snapshots are appropriate:** Catching unintended changes to serialized output (API responses, config files). Not for UI components where the structure legitimately evolves.

**Fix:** Replace with targeted assertions:

```javascript
test('displays user name and email', () => {
  render(<UserProfile user={mockUser} />);
  expect(screen.getByText('Alice')).toBeInTheDocument();
  expect(screen.getByText('alice@example.com')).toBeInTheDocument();
});
```

---

## 5. Happy-Path-Only Testing

**What it looks like:** Tests only cover the success case. No error paths, edge cases, or boundary conditions.

```javascript
// Only tests the happy path
test('creates user', async () => {
  const user = await createUser({ name: 'Alice', email: 'alice@example.com' });
  expect(user.id).toBeDefined();
});
// Missing: duplicate email, invalid input, DB failure, empty name
```

**Gate:** Is there at least one error/edge case test for every happy-path test?

A 1:1 ratio is the minimum. Most functions have more failure modes than success modes. If you have 5 happy-path tests and 0 error tests, the test suite is a false confidence generator.

**Fix:** For each happy-path test, identify at least:
- One invalid input case
- One error response case
- One boundary condition (empty, null, max length, zero, negative)

---

## 6. Post-Hoc Threshold Setting (ML / Data Science)

**What it looks like:** Train the model first, observe metrics, then set thresholds to match what the model already achieves.

```python
# Anti-pattern: threshold set after seeing results
model.fit(X_train, y_train)
accuracy = model.score(X_test, y_test)  # 0.87
assert accuracy >= 0.85  # threshold suspiciously close to result
```

**Gate:** Was the threshold defined before training began? Can you point to the requirements doc, baseline model, or business rule that established it?

**Fix:** Define evaluation criteria from requirements or baseline before any training. Write the assertion first (RED), watch it fail against the baseline (0.72), train the model (GREEN), confirm it passes (0.87 >= 0.85).

---

## 7. Test-After Data Validation (Analytics Engineering / Data Engineering)

**What it looks like:** Build the dbt model or pipeline, run it, see the output, then write tests that describe what already exists.

```yaml
# Anti-pattern: tests written after model already runs
# schema.yml added after dbt run succeeds
models:
  - name: fct_orders
    columns:
      - name: order_id
        tests: [unique, not_null]  # added after seeing the data is already unique
```

**Gate:** Did the dbt test / quality check fail before the model/pipeline was built?

**Fix:** Write `schema.yml` tests first. Run `dbt test` (fails — model doesn't exist). Write model SQL. Run `dbt test` (passes). The test drove the model, not the other way around.

---

## 8. Control-Total Skipping (Analytics / Financial Analytics)

**What it looks like:** Build a query or dashboard metric without verifying against a known control total or trusted source. The result "looks right" — no formal assertion.

```sql
-- Anti-pattern: eyeball validation
SELECT SUM(revenue) as total_revenue
FROM fct_orders
WHERE order_date BETWEEN '2024-01-01' AND '2024-01-31'
-- Result: $1,247,832 — "looks about right"
```

**Gate:** Is there a known correct value to assert against? Did you check it?

**Fix:** Before building the query, identify a control total (finance report, GL extract, prior period known value, upstream system). Write an assertion: `ABS(query_result - 1200000) < 5000`. Run it (fails — table not built or result doesn't match). Build the transformation. Run again (passes within tolerance).
