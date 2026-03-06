# Constraint Analysis Reference

## The Two Types of Constraints

### HARD Constraints
**Definition:** Must be true. Non-negotiable. Violating it makes the design invalid.

**Characteristics:**
- Stems from external reality (regulation, hardware, existing system contracts)
- Cannot be negotiated away without changing the project's fundamental nature
- Failure to meet it = the feature doesn't ship or breaks something

**Examples:**
- "Must work offline" (hardware constraint)
- "Cannot break existing API contracts" (system constraint)
- "Must run in under 200ms" (explicit SLA)
- "Must use the existing auth system" (organizational constraint)

### SOFT Constraints
**Definition:** Preferred but negotiable. Can be overridden with explicit justification.

**Characteristics:**
- Stems from preference, convention, or current best practice
- Can be negotiated with the right tradeoff argument
- Violating it may incur technical debt but won't break the system

**Examples:**
- "Prefer TypeScript over JavaScript" (convention)
- "Should match existing UI patterns" (aesthetic preference)
- "Ideally under 100ms" (performance preference, not SLA)
- "Try to avoid adding a new dependency" (hygiene preference)

---

## Common Classification Mistakes

### Soft-Treated-as-Hard
**Pattern:** The brief states "must" or "required" for something that is actually a preference.

**Signal:** Ask "what happens if we violate this?" If the answer is "it would be inconvenient" or "it breaks convention" — it's SOFT. If the answer is "the feature doesn't work" or "we violate a contract" — it's HARD.

**Action:** Flag it in the Flagged Constraints section. Reclassify as SOFT and note that it can be overridden.

### Implicit Constraints
**Pattern:** A constraint not stated in the brief but evident from project context.

**Sources:**
- CLAUDE.md behavioral rules (e.g., "no @imports")
- CLAUDE.md critical guardrails (e.g., "always use {{ ref() }}")
- Existing codebase patterns (e.g., "all API routes follow REST conventions")

**Action:** Add as IMPLICIT source in the constraint table. Flag if they conflict with brief constraints.

### Contradictory Constraints
**Pattern:** Two constraints that cannot both be satisfied simultaneously.

**Examples:**
- "Must be fully offline" + "Must sync in real-time"
- "Must not add dependencies" + "Must support X feature" (where X requires a library)

**Action:** Flag immediately. Do not proceed with design until the user resolves the contradiction.

---

## Constraint Analysis Workflow

```
For each constraint in the brief:
  1. Classify: HARD or SOFT
  2. Source: Brief / CLAUDE.md / Implicit
  3. Validate: Does this constraint actually apply? Is the source authoritative?
  4. Flag if: soft-treated-as-hard, implicit, or contradicts another constraint

After classifying all brief constraints:
  5. Scan CLAUDE.md for implicit constraints that apply to this design area
  6. Add them to the table with source=Implicit
  7. Check for contradictions across all constraints
```

---

## How Constraints Drive Options

Each design option should be evaluated against the constraint table:

- **HARD constraint violated** → option is invalid, eliminate it
- **SOFT constraint violated** → option is valid but has a cost, note it in Cons
- **All constraints satisfied** → option is a candidate

Options that violate no HARD constraints and satisfy the most SOFT constraints are typically stronger candidates — but tradeoffs between SOFT constraints may still produce genuinely different options.
