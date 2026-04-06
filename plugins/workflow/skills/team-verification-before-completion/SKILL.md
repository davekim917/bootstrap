---
name: team-verification-before-completion
description: >
  Cross-cutting verification guard. Enforces evidence-based completion claims by requiring fresh
  verification output before any task can be declared done. Applies across all workflow stages:
  /team-build, /team-qa, /team-ship, /team-debug, /team-tdd, and direct implementation. Covers software tests, ML metrics,
  pipeline runs, query results, dashboard rendering, and schema validation.
  Use when agent claims work is done or signals task completion.
  Do not use for intermediate progress updates or partial status reports.
user-invocable: false
version: 1.0.0
---

# Verification Before Completion

## Iron Law

**NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**

A completion claim without attached verification output is not a completion claim — it is a guess.

## When to Use

This is a cross-cutting guard. It applies regardless of:
- **Workflow stage:** /team-build, /team-qa, /team-ship, /team-debug, /team-tdd, direct implementation
- **Domain:** Software tests, ML evaluation metrics, pipeline job status, query results, dashboard rendering, schema validation, data quality checks
- **Agent role:** Builder, lead, reviewer, or solo agent

It activates whenever an agent is about to signal that work is done. The signal can be explicit ("all tests pass") or implicit ("the implementation is complete").

## The Gate Function

Every completion claim must pass through 5 steps:

### 1. IDENTIFY
Name the specific checks that must pass for this work to be done.

- Software: "test suite for auth module", "lint passes", "build succeeds"
- ML: "evaluation metrics on holdout set", "model artifact saved", "inference latency under threshold"
- Data engineering: "pipeline run completes", "row counts match expected", "quality checks pass", "no orphaned records"
- Analytics: "query returns expected results", "dashboard renders without errors", "metric values match validation source"

### 2. RUN
Execute the identified checks. Not "recall" them. Not "assume" them. Execute them now.

### 3. READ
Read the actual output. Copy the relevant portion — pass/fail status, metric values, row counts, error messages.

### 4. VERIFY
Compare actual output against expected. State the comparison explicitly:
- "Expected: 0 failures. Actual: 0 failures. PASS."
- "Expected: accuracy >= 0.85. Actual: 0.87. PASS."
- "Expected: 1,000 rows. Actual: 1,000 rows. PASS."
- "Expected: no errors. Actual: 2 errors on line 45, 78. FAIL."

### 5. CLAIM
Only after steps 1-4 produce a PASS: state the completion claim with the evidence attached.

Format: "[What was verified] — [command/action run] — [actual output] — [pass/fail]"

## Red Flags — STOP

If you catch yourself about to say any of these, STOP and go back to step 1:

- "Should work now"
- "I'm confident this is correct"
- "Looks correct to me"
- "I believe this passes"
- "This should be good"
- "Metrics look good" (without showing the metrics)
- "Pipeline completed successfully" (without showing the output)
- "All criteria are met" (without showing the evidence)
- "I've verified this" (without showing what you ran and what it returned)
- "Everything passes" (without the actual pass/fail output)

Each of these is a completion claim without evidence. Replace with: run the check → read the output → show the comparison.

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "Verification passed earlier" | State changed since. Run it now. |
| "Simple enough to verify by reading" | Simple work still fails. Execute, don't eyeball. |
| "I just built it, I know it works" | You also just built the last bug. Verify. |
| "Running verification takes too long" | False completion claims take longer when they're wrong. |
| "Previous task/group passed so this one should too" | Each task is independent. Verify each. |
| "I already checked this" | Show the output. "Already checked" is not evidence. |
| "Obvious from the output/code/model" | Obvious errors are still errors. Execute, don't assume. |
| "The tool/framework/library guarantees this" | You're verifying your usage, not the tool. |

## Forbidden Alternative Paths

These are NOT valid verification:

1. **Reading code/config and concluding it "looks correct."** Reading is not executing. Code that looks correct fails all the time.
2. **Citing a previous run from before current changes.** Previous runs verify previous state. Current changes require current verification.
3. **"It compiles/imports/loads."** Compilation verifies syntax, not behavior. Loading verifies existence, not correctness.
4. **Reporting criteria as met based on intent, not output.** "I implemented X, so criterion X is met" is circular. Run the check that X actually works.

## Spirit vs. Letter

Violating the letter of this skill IS violating the spirit. There are no edge cases where skipping verification is acceptable. The entire point is that humans and agents systematically overestimate confidence in their own work.

No exceptions.

## Embedding in Builder Prompts

When spawning builder agents (e.g., during /team-build), include this requirement in the builder prompt template:
- Reference: `~/.claude/skills/team-verification-before-completion/SKILL.md`
- Key instruction: "Before reporting any task as complete, run the verification gate: IDENTIFY → RUN → READ → VERIFY → CLAIM. Attach actual output to your completion report."
