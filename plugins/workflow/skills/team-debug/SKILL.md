---
name: team-debug
description: >
  Systematic debugging methodology. Iron law: no fixes without root cause investigation first.
  Five-phase process: investigate, analyze patterns, test hypothesis, implement fix, architecture check.
  Includes rationalization resistance and escalation protocol. Apply during /team-build failures and bug reports.
version: 1.0.0
---

# /team-debug — Systematic Debugging Methodology

## What This Skill Does

Enforces root-cause-first debugging discipline. Iron law: **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

**Output:** Root-cause-verified fix with regression test.
**NOT output:** Shotgun fixes. Changing code until something works is not debugging.

## When to Use

- Test failures during `/team-build`
- Bug reports from users or QA
- Unexpected behavior in development

**Do NOT use for:**
- Known one-line fixes where root cause is obvious (typo, missing import)
- Feature development (use `/team-tdd`)
- Refactoring (use `/team-tdd`)

## Process

### Phase 1: Root Cause Investigation

1. Read the error message or symptom in full — do not skim
2. Trace backward from the symptom to the source:
   - What function produced the error?
   - What called that function?
   - What was the state at the call site?
3. Find the earliest point of divergence — where does actual behavior first differ from expected?
4. Document your hypothesis: "The root cause is [X] because [evidence]"

**Do not write any code in this phase.** Investigation only.

### Phase 2: Pattern Analysis

1. Search for the same pattern elsewhere in the codebase
2. If the bug is in a pattern (e.g., missing null check), how many instances exist?
3. Document the scope: "This pattern appears in [N] places. [M] are affected."

**Why this matters:** Fixing one instance of a systematic bug leaves the others. Pattern analysis turns a point fix into a comprehensive fix.

### Phase 3: Hypothesis Testing

1. Write a reproduction test that captures the bug (RED)
2. Run the test — confirm it fails
3. Confirm it fails **for the predicted reason** (matches your Phase 1 hypothesis)

If the test fails for a different reason than predicted:
- Your hypothesis is wrong
- Return to Phase 1 with new information
- Do not proceed with a fix based on a wrong hypothesis

**Gate:** Reproduction test fails for the predicted reason.

### Phase 4: Implementation

1. Fix the root cause (not the symptom)
2. Run the reproduction test — confirm PASS
3. Run the full test suite — confirm no regressions
4. If Phase 2 found multiple instances, fix all of them

**Gate:** Reproduction test passes. Full suite passes. All pattern instances addressed.

### Phase 4.5: Architecture Check (Conditional)

**Trigger:** 3 or more fix attempts have failed on the same bug.

If you reach this point, STOP. Do not attempt a 4th fix. Present to the user:

```
**Architecture Check: 3 fix attempts failed.**

Attempt 1: [what was tried] -> [what happened]
Attempt 2: [what was tried] -> [what happened]
Attempt 3: [what was tried] -> [what happened]

Question: Does the current architecture make this bug inevitable?
- [Observation about why fixes keep failing]
- [Structural issue that may be the real root cause]

I will not continue without your input.
Options:
- Approve a 4th attempt with guidance
- Redesign the relevant component
- Waive the fix with stated reason
```

**Do NOT continue without user input.** Three failed attempts means the approach is wrong, not that you need to try harder.

## Rationalization Resistance

These are not valid reasons to skip systematic debugging:

| Excuse | Counter |
|--------|---------|
| "I know the fix" | Then Phase 1-3 will take 60 seconds. If you're right, you'll confirm it. If you're wrong, you saved hours. |
| "Quick fix, no investigation needed" | Quick fixes without investigation are the #1 source of regression bugs. |
| "The stack trace tells me everything" | Stack traces show where the error surfaced, not where it originated. |
| "Works on my machine" | That's a symptom, not a diagnosis. What's different about the other machine? |
| "The test is flaky" | Flaky tests have root causes: timing, shared state, external dependency. Investigate, don't dismiss. |

## Anti-Patterns (Do Not Do These)

- **Fix before root cause:** Changing code before understanding why it's broken. You might fix the symptom and hide the real bug.
- **Fix symptom, not cause:** Adding a null check where the real problem is that the value should never be null. Symptom fixes accumulate into defensive code that masks structural issues.
- **Skip pattern analysis:** Fixing one instance of a repeated bug. The other instances become future bug reports.
- **"Should work now":** Claiming a fix works without running the reproduction test. Unverified claims are not fixes.
- **Blame the tool:** "The framework has a bug" is rarely true. Investigate your usage before blaming upstream.

## Context Discipline

**READ:** Error messages, stack traces, failing test output, relevant source files (trace backward from error).
**WRITE:** Reproduction test first (Phase 3), then fix (Phase 4).
**DO NOT READ:** Unrelated source files, other builders' files, the full codebase.

## Model Tier

- **Sonnet** (builders): Debug process is applied when tests fail during `/team-build`
- **Opus** (direct invocation): When user explicitly calls `/team-debug`
- **Phase 4.5 escalation** always goes to the user, regardless of model tier
