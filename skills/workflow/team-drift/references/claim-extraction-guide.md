# Claim Extraction Guide

Reference for agents performing claim extraction in Step 2. What counts as a claim, how to
extract it precisely, and common extraction mistakes.

---

## What Is a Claim?

A claim is any statement in the SOT that implies something must be true in the target.

**The test:** "If the target doesn't satisfy this, is that a problem?"
- Yes → it's a claim
- No → it's background context, not a claim

---

## Claim Types

| Type | Definition | Example |
|------|-----------|---------|
| **REQUIREMENT** | Something that must exist or be implemented | "Task A2 creates `src/auth/middleware/requireAuth.ts`" |
| **DECISION** | A choice that must be reflected in the target | "Use Option B: JWT tokens stored in httpOnly cookies" |
| **CONSTRAINT** | A limit that must be respected | "Must not add dependencies beyond what's already in package.json" |
| **ACCEPTANCE** | A named acceptance criterion | "Returns 401 { error: 'Unauthorized' } when token is missing" |
| **BEHAVIOR** | A specific behavior that must be present | "Middleware calls next() when token is valid" |

---

## How to Extract Claims

### Step 1: Read the entire SOT first
Don't extract as you go. Read the whole document to understand structure, then extract. This
prevents missing implicit claims that become clear only in context.

### Step 2: Go section by section
Extract all claims from one section before moving to the next. Note the section for each claim.

### Step 3: Be literal, not inferential
Extract what the SOT says, not what it implies.

**Too inferential:** "The system handles authentication securely"
**Literal (correct):** "Authentication uses JWT tokens signed with JWT_SECRET env var"

### Step 4: One claim per statement
Don't bundle. A sentence with two verifiable things = two claims.

**Bundled (wrong):** "Creates the file and exports three functions"
**Split (correct):**
- Claim A: "Creates `src/auth/middleware/requireAuth.ts`"
- Claim B: "Exports `requireAuth`, `optionalAuth`, and `withRole` from that file"

### Step 5: Include implicit claims
Some claims are implicit in the document structure.

Example: A plan with Task B2 marked "Pre-conditions: Task A1 must be complete" implies:
- Claim: "Task A1's output exists before Task B2 runs"

Example: A design with Constraint HARD: "No new dependencies" implies:
- Claim: "The implementation adds no packages not already in package.json"

---

## Common Extraction Mistakes

### Under-extraction (missing claims)
- Skipping acceptance criteria — these are always claims
- Ignoring pre-conditions — they are claims about ordering
- Missing file path claims — every named file path is a claim
- Treating SOFT constraints as non-claims — they're PARTIAL if partially satisfied

### Over-extraction (false claims)
- Extracting rationale as a claim — "We chose JWT because it's stateless" is not a claim
- Extracting options not selected — if Option A was rejected, Option A's properties are not claims
- Extracting examples as requirements — "e.g., 200ms" is not a claim unless the SOT says "must"

### Imprecise extraction
- Paraphrasing away specificity — "creates auth file" loses the exact path
- Dropping numbers — "returns error status" loses "401"
- Losing the subject — "must be validated" without saying what

---

## Claim Format

```
Claim #N | TYPE | [Exact quote or precise paraphrase] | Source: [Section / Line / Task ID]
```

**Example claims from a plan document:**

```
Claim #1  | REQUIREMENT | Creates file at `src/auth/middleware/requireAuth.ts` | Source: Task A2
Claim #2  | ACCEPTANCE  | Returns status 401 with body { error: "Unauthorized" } when Authorization header is missing | Source: Task A2, test_requireAuth_missing_token
Claim #3  | BEHAVIOR    | Attaches decoded JWT payload to req.user when token is valid | Source: Task A2 approach
Claim #4  | CONSTRAINT  | Does not modify login() or logout() functions in auth.ts | Source: Task A2 operation
Claim #5  | DECISION    | Uses jsonwebtoken library (already in package.json) | Source: Task A2 code pattern
Claim #6  | ACCEPTANCE  | All 3 named test cases (test_requireAuth_valid_token, test_requireAuth_missing_token, test_requireAuth_expired_token) pass | Source: Task A2 acceptance criteria
```

---

## Verification Format

```
Claim #N | VERDICT | [Evidence from target — quote or file:line] | [Gap description if PARTIAL or DIVERGED]
```

**Verdict rules:**
- **CONFIRMED:** Quote the exact evidence from the target. Do not say "confirmed" without evidence.
- **PARTIAL:** Quote what IS there, then state precisely what's missing.
- **DIVERGED:** Quote the SOT claim AND the contradicting target content side by side.
- **MISSING:** State "No corresponding content found" and note where you searched.

**Example:**
```
Claim #1  | CONFIRMED | `src/auth/middleware/requireAuth.ts` created at line 1 of file listing |
Claim #2  | CONFIRMED | Line 8: `return res.status(401).json({ error: 'Unauthorized' })` when no token |
Claim #4  | DIVERGED  | SOT: "does not modify logout()". Target: logout() signature changed on line 42 | logout() now takes optional `redirect` param — breaking the contract
Claim #6  | PARTIAL   | test_requireAuth_valid_token and test_requireAuth_missing_token exist. test_requireAuth_expired_token not found in test file | Missing: expired token test case
```
