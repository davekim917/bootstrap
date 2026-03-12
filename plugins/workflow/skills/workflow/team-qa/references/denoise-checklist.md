# Denoise Checklist

Applied to every changed file in Phase 1 of `/team-qa`. Universal rules — language-agnostic where
possible, with language-specific examples.

---

## Category 1: Unused Imports

**What to look for:** Import statements where the imported symbol is never referenced in the file body.

```typescript
// Flag this:
import { useState, useEffect } from 'react'  // useEffect never appears below
import { formatDate } from '../utils'         // formatDate never called

// Keep this:
import { useState } from 'react'  // used on line 12
```

**Action:** Propose auto-removal. These are always safe to remove.

---

## Category 2: Debug Artifacts

**What to look for:** Any logging or debugging statement that was not intentional production code.

```typescript
console.log('here')
console.log('user:', user)
console.error('DEBUG:', error)
debugger
```

```python
print("got here")
import pdb; pdb.set_trace()
breakpoint()
```

```ruby
binding.pry
puts "DEBUG: #{variable}"
```

**Action:** Propose auto-removal. If `console.error` is used for real error logging (not debugging),
keep it — but flag for user confirmation if it looks ad hoc.

---

## Category 3: Dead Code

**What to look for:** Functions, classes, variables, or exports that are defined in the changed
file but never referenced — not internally, not via import in other files.

**Be conservative here.** Only flag dead code you can confirm is unused:
- Defined and never called within the same file
- Exported but no other file imports it (only flag if you can grep confidently)
- A parameter that is never used inside the function body

```typescript
// Flag: function defined but never called in this file and not exported
function formatUserData(user) { ... }

// Flag: variable assigned but never read
const tempResult = computeSomething()
doOtherThing()  // tempResult never used
```

**Action:** Show the code block to the user, ask to confirm removal. Do not auto-remove dead code
without confirmation — what looks dead might be called from a place not visible in the changed files.

---

## Category 4: Hardcoded Test Values

**What to look for:** Literal values that look like placeholder or test data in production code.

```typescript
const userId = 123           // hardcoded ID
const email = "test@test.com"  // test email in production path
const apiKey = "sk-test-abc"   // test key
if (env === "test") { ... }    // test-specific branch in production code
```

**Exceptions:** Values that are clearly intentional constants (e.g., `MAX_RETRIES = 3`) are fine.
Flag only values that look like they were left from development/testing.

**Action:** Show to user, confirm whether intentional. Propose removal or replacement with config.

---

## Category 5: Commented-Out Code Blocks

**What to look for:** Multi-line blocks of code that have been commented out (not doc comments).

```typescript
// const oldImplementation = () => {
//   return fetch('/api/old-endpoint')
//     .then(res => res.json())
// }
```

**Distinction:** Doc comments (`/** ... */`, `# Description:`) are not noise — keep them.
Only flag commented-out code (blocks that look like they used to run).

**Action:** Show to user, ask to confirm removal. These often exist for a reason ("I might need this
later") — user should decide consciously, not just leave it.

---

## Category 6: TODO/FIXME Without Owner

**What to look for:** `TODO` or `FIXME` comments with no assigned owner or ticket reference.

```typescript
// TODO: fix this later                    ← flag: no owner, no ticket
// TODO(davidkim): fix null handling       ← keep: has owner
// TODO: #1234 — handle edge case         ← keep: has ticket
// FIXME: this breaks under load          ← flag: no owner
```

**Action:** Flag as advisory. User should either: add an owner/ticket, resolve the TODO, or
accept it as permanent documentation (rename to a comment).

---

## Category 7: Temp and Scratch Files

**What to look for:** Files that appear to be iteration debris rather than intentional code.

Patterns:
- `scratch.ts`, `test2.js`, `temp-fix.py`
- `*.bak`, `*.tmp`, `*.old`
- Files in `/tmp/` committed by accident
- Duplicate files (`UserCard copy.tsx`)

**Action:** Flag for user confirmation and removal.

---

## Category 8: SQL / Query Noise

**What to look for:** Query artifacts that indicate development debris in production SQL.

- Hardcoded date ranges in production models (`WHERE date >= '2024-01-01'`)
- Debug `LIMIT 10` or `LIMIT 100` left in production queries
- `SELECT *` in non-exploration SQL (production models, views, downstream queries)
- Commented-out SQL blocks (old joins, old filters, old WHERE clauses)
- Hardcoded schema/database/warehouse names instead of variables or macros
- Inline credentials or connection strings in SQL files
- Duplicated CTEs that should be extracted to intermediate models or macros

```sql
-- Flag: hardcoded date
WHERE order_date >= '2024-01-01'  -- should be parameterized or use variable

-- Flag: debug LIMIT
SELECT * FROM orders LIMIT 10  -- left from development

-- Flag: hardcoded schema
FROM raw_database.public.orders  -- should use {{ source() }} or variable
```

**Action:** Flag hardcoded dates and LIMIT as auto-safe. Flag SELECT * and commented SQL for user confirmation.

---

## Category 9: Notebook Noise

**What to look for:** Notebook artifacts that indicate development debris or sensitive data exposure.

- Uncleared cell outputs (large DataFrames, plots, data samples, model summaries)
- `display()`, `print()`, `.head()`, `.describe()` debug statements in production-path cells
- Cells that don't execute in order (out-of-sequence dependencies)
- Hardcoded file paths (`/Users/david/data/...`, `C:\Users\...`)
- Duplicate or scratch cells (unnamed experiments, copy-paste variations)
- Sensitive data visible in output cells (emails, IDs, PII, financial figures)
- Magic numbers without context (thresholds, cutoffs, sample sizes without comments)

**Action:** Flag PII in outputs as MUST-FIX. Flag uncleared outputs, debug prints, and hardcoded paths as auto-safe. Flag scratch cells for user confirmation.

---

## Category 10: Pipeline / DAG Noise

**What to look for:** Pipeline artifacts that indicate test/dev configuration left in production code.

- Hardcoded schedule strings that look like test values (`schedule_interval='*/5 * * * *'`)
- Disabled or commented-out tasks/operators in DAG definitions
- Test/dev connection references in production DAG configs
- `print()` / logging debug statements in task functions
- Temporary retry overrides (`retries=0` left from debugging)
- Hardcoded file paths for data sources or sinks

**Action:** Flag disabled tasks and test connections for user confirmation. Flag debug prints and temp overrides as auto-safe.

---

## Denoise Output Format

For each found item:

```
[FILE:LINE] | CATEGORY | AUTO-SAFE | DESCRIPTION
src/api/users.ts:3   | unused-import | YES | `formatDate` imported but never used
src/api/users.ts:47  | debug-log     | YES | console.log('got user:', user)
src/api/users.ts:89  | dead-code     | NO  | function `legacyFormat()` — defined but not called or exported
src/utils/helpers.ts:12 | todo-no-owner | NO | "TODO: fix null handling" — no owner or ticket
```

Present auto-safe items as a batch: "Safe to remove [N] items — approve all, or review individually."
Present judgment-call items one by one for user decision.
