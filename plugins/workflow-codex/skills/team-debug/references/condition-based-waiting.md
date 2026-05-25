# Condition-Based Waiting

## Problem

Fixed delays (`sleep(1000)`, `setTimeout(2000)`) are the #1 cause of flaky tests and unreliable automation. They encode assumptions about timing that are true on your machine right now but fail under load, on CI, or on slower hardware.

```javascript
// Anti-pattern: fixed delay
await page.click('#submit');
await sleep(2000);  // "should be enough time"
expect(page.getByText('Success')).toBeVisible();
```

## Solution

Wait for conditions, not time. Replace every fixed delay with a condition that describes what you're actually waiting for.

```javascript
// Correct: wait for the condition
await page.click('#submit');
await expect(page.getByText('Success')).toBeVisible({ timeout: 5000 });
```

## Patterns by Environment

### DOM / Browser

| Instead of | Use |
|------------|-----|
| `sleep(N)` after click | `waitForSelector`, `waitForText`, `toBeVisible` |
| `sleep(N)` after navigation | `waitForURL`, `waitForLoadState` |
| `sleep(N)` for animation | `waitForFunction(() => el.style.opacity === '1')` |
| `sleep(N)` for network | `waitForResponse(url)`, `waitForRequest(url)` |

### Node.js / Server

| Instead of | Use |
|------------|-----|
| `sleep(N)` for file write | `fs.watch`, poll with `fs.existsSync` + backoff |
| `sleep(N)` for server start | Poll health endpoint with exponential backoff |
| `sleep(N)` for DB operation | Use the async operation's promise directly |
| `sleep(N)` for queue message | Use consumer's message event or acknowledgment callback |

### Database

| Instead of | Use |
|------------|-----|
| `sleep(N)` after write | Read-after-write with retry |
| `sleep(N)` for replication | Read from primary or use read-your-writes consistency |
| `sleep(N)` for index build | Query the index with retry until it returns expected results |

### API / Network

| Instead of | Use |
|------------|-----|
| `sleep(N)` between requests | Rate limiter + retry-after header |
| `sleep(N)` for eventual consistency | Poll with exponential backoff + max attempts |
| `sleep(N)` for webhook delivery | Register a promise that resolves on webhook receipt |

## When to Apply During Debugging

If you encounter a flaky test or intermittent failure during `/team-debug` Phase 1:

1. Search for fixed delays in the failing test and its setup
2. Each `sleep`, `setTimeout`, or `wait(N)` is a candidate root cause
3. Replace with the appropriate condition-based pattern
4. If the flakiness disappears, you've found the root cause

If fixed delays exist in production code (not just tests):

1. The delay is either a workaround for a race condition or an intentional throttle
2. If workaround: find the race condition and fix it properly
3. If intentional throttle: document why and use a named constant, not a magic number

## Backoff Pattern

When polling is the only option (no event to wait for), use exponential backoff with a cap:

```javascript
async function waitForCondition(check, { maxAttempts = 10, initialDelay = 100, maxDelay = 5000 } = {}) {
  let delay = initialDelay;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await check()) return;
    await sleep(Math.min(delay, maxDelay));
    delay *= 2;
  }
  throw new Error(`Condition not met after ${maxAttempts} attempts`);
}
```

This is the one acceptable use of `sleep` — inside a backoff loop with a termination condition and maximum attempts.
