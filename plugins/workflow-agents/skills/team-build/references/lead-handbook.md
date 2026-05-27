# Build Lead Handbook

Mid-build operational details that the lead reads on an as-needed basis: the two-stage implementation review, the build-state checkpoint template, the verification gate, and the retry-limit escalation templates. The main `team-build/SKILL.md` references each section here at the point in the process where it applies.

## Table of contents

- [Two-stage implementation review](#two-stage-implementation-review) — per-group spec compliance + code quality, after a builder reports done
- [Verification before completion](#verification-before-completion) — the gate language for claiming a group complete
- [Build-state checkpoint template](#build-state-checkpoint-template) — what to write to `build-state.md` after each group
- [Fix loop retry limit](#fix-loop-retry-limit) — escalation template after 3 failed fix attempts on a criterion
- [Drift fix retry limit](#drift-fix-retry-limit) — escalation template after 3 drift cycles fail to converge

---

## Two-stage implementation review

After the validation checklist in `team-build/SKILL.md` Step 5 passes, the lead performs two sequential reviews before marking a group complete.

### Stage 1: Spec Compliance

> **Distinction from post-build drift:** Spec compliance (Stage 1, per-group) verifies each task's output matches its task spec — a task-level check. Post-build drift (Step 7) verifies the aggregate implementation matches the plan's file ownership map — a build-level check that catches cross-group issues (e.g., Group A's output file overwritten by Group C). Both checks are needed; they do not overlap.

Re-read the original task spec from the plan for this group.

**Adversarial stance:** Assume the builder's completion report is optimistic. Don't trust self-reported criteria status — read the actual code and run the actual tests. The builder may have misunderstood the spec, implemented something slightly different from what was asked, or reported a criterion as passing based on reading code rather than running verification.

For each task in the group:
1. Check each acceptance criterion by name — not a general impression.
2. For each `ASSERT:` annotation in the task spec: verify the stated condition holds. (ASSERT checks are active only for tasks written in the contracts format. Tasks without ASSERT lines fall back to the general criteria check.)
3. Verify each file listed in the spec was created or modified.
4. Verify no unspecified files were created or modified (over-building check).

Report: ✅ all criteria met, or ❌ list of unmet criteria by task + criterion name.

Unmet criteria → message the builder with file:line (via your runtime's worker channel — see the skill's § Dispatch by Runtime) → builder fixes → re-review. Same 3-iteration retry limit as the Fix Loop below. Don't proceed to Stage 2 until ✅.

### Stage 2: Code Quality

After Stage 1 clears: well-structured? follows AGENTS.md/CLAUDE.md conventions? obvious perf issues? adequate error handling at boundaries? hardcoded values that should be configurable?

- MUST-FIX → builder fixes → re-review (3-iteration limit)
- SHOULD-FIX → logged for `/team-qa` phase

Builders follow the `/team-receiving-review-feedback` protocol when processing review findings: evaluate before implementing, verify claims, check necessity.

Gate: both stages clear before marking group complete.

<!-- GATE: group-validation — Both review stages clear, all criteria verified -->

---

## Verification before completion

Lead verification gate — IDENTIFY → RUN → READ → VERIFY → CLAIM. Before marking any group complete:

1. **IDENTIFY** the specific tests and criteria to verify.
2. **RUN** the actual commands.
3. **READ** the actual output.
4. **VERIFY** actual vs expected.
5. **CLAIM** only after verification.

This is the in-build instance of the cross-cutting `team-verification-before-completion` protocol — see that skill for the full rationale.

**Forbidden wording (lead and builders):** "should work now" / "I'm confident" / "looks correct" / "I believe this passes." These indicate unverified claims. Replace with actual command → actual output → comparison.

---

## Build-state checkpoint template

After marking each group complete (and before spawning the next sequential group), write or update `docs/specs/<feature>/build-state.md`:

```
## Build State Checkpoint
Last updated: [timestamp]

### Groups Completed
- [Group A]: validated [timestamp] — all criteria passed
- [Group B]: validated [timestamp] — criterion X required 2 fix attempts

### Groups Remaining
- [Group C]: blocked by [A, B] — ready to spawn
- [Group D]: blocked by [C] — waiting

### Decisions Made During Build
- [Interpretation call 1: what the lead decided and why]
- [Blocker resolution 1: what was resolved and how]

### Escalations
- [None / criterion text + current status]

### Known Risks (Accumulated)
- [Pre-build drift PARTIAL findings]
- [Waived review findings]
- [Build-time decisions that deviated from plan]
```

This file is the lead's persistent memory. **If your conversation context has been compressed, re-read this file before any coordination action** (spawning builders, validating criteria, running drift checks). The checkpoint is the recovery mechanism for context compression during long builds — without it, the lead loses validation results, interpretation calls, and accumulated risks silently.

---

## Fix loop retry limit

Track fix attempts per acceptance criterion. After **3 failed attempts** on the same criterion:

1. STOP sending fixes to the builder.
2. Mark the criterion as `ESCALATED`.
3. Present to the user:

   ```
   **Escalation: Acceptance criterion stuck after 3 attempts.**

   Criterion: [exact criterion text]
   Builder: [builder name]
   Attempt 1: [what was tried] → [what happened]
   Attempt 2: [what was tried] → [what happened]
   Attempt 3: [what was tried] → [what happened]

   This may indicate a flawed criterion, a spec gap, or a genuine implementation blocker.
   Options:
   - Revise the criterion and retry
   - Waive the criterion with a stated reason
   - Abort the build and revisit the plan
   ```

4. Don't continue the build or mark the group complete until the user responds.

---

## Drift fix retry limit

Track drift fix-and-recheck cycles in Step 7. After **3 cycles** where the drift check still finds MISSING or DIVERGED:

1. STOP fixing.
2. Present to the user:

   ```
   **Escalation: Drift not converging after 3 fix cycles.**

   Cycle 1: [N] MISSING, [N] DIVERGED → fixed → re-ran drift
   Cycle 2: [N] MISSING, [N] DIVERGED → fixed → re-ran drift
   Cycle 3: [N] MISSING, [N] DIVERGED → still present

   Remaining findings: [list each finding]

   This may indicate the plan has structural issues that can't be resolved by patching code.
   Options:
   - Review and fix the remaining findings manually
   - Waive specific findings with stated reasons
   - Re-run /team-plan to reconcile the implementation approach
   ```

3. Don't proceed to Step 8 until the user responds.
