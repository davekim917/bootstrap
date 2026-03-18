# Completion Report Format

## Builder → Lead (completion)

Sent via `SendMessage(type: "message", recipient: "team-lead", ...)` when a builder finishes.

```
Group [NAME] complete.

Tasks completed: [A1, A2, A3 — list all]

Test results:
  test_[name]:            PASS
  test_[name]_[scenario]: PASS
  test_[name]_[error]:    PASS
  Full test suite:        PASS (or FAIL — list failing tests)

Acceptance criteria:
  [Task A1] [criterion text]: ✓ PASS
  [Task A1] [criterion text]: ✓ PASS (fix attempt 2 of 3)
  [Task A2] [criterion text]: ✗ FAIL (fix attempt 3 of 3 — escalating)
  [Task A2] [criterion text]: ✓ PASS

Decisions made not in spec (interpretation calls):
  [What I decided and why — so lead can validate the choice]
  OR: None

Acceptance criteria I could not satisfy:
  [Criterion text]: [Why it failed and what the actual state is]
  OR: None
```

---

## Builder → Lead (blocker)

Sent immediately when a builder is stuck.

```
BLOCKED on Task [ID]: [one sentence]

What I tried:
  [concrete attempts]

What I need:
  [decision / clarification / file path / other]

Current state:
  [what exists now so lead can assess]
```

---

## Lead → Builder (resolution)

Lead sends this after investigating a blocker.

```
Resolution for Task [ID]:

Decision: [what to do]
Reasoning: [why — brief]

[If a file path clarification]: The correct path is [exact path]
[If an interpretation call]: Use [X] because [reason from CLAUDE.md / plan]
[If unresolvable]: This is a plan gap. Pause Task [ID]. Continue with [other tasks].
  I will handle [ID] directly and update the task spec.

Resume when ready.
```

---

## Lead → Builder (acceptance failure)

Lead sends this when a validation check fails.

```
Task [ID] acceptance check failed.

Criterion: [exact criterion text]
Expected: [what the criterion requires]
Actual: [what the lead found — file:line or test output]
Fix attempt: [N] of 3

Fix required:
  [specific description of what to change]

Re-run test_[name] after fixing. Send updated completion report.

⚠ After 3 failed attempts on this criterion, the lead will escalate to the user rather than send another fix.
```

---

## Lead validation checklist (internal — not sent to builder)

After receiving each completion report, before marking task complete:

- [ ] Read each file listed in the group at its exact path — does it exist?
- [ ] For MODIFY tasks: confirm the changed functions are present, unchanged functions untouched
- [ ] Run each named test case: `[test command] [test name]` — confirm PASS
- [ ] Run full test suite: confirm no regressions
- [ ] Check every acceptance criterion — read the code, don't trust the report
- [ ] Review any "decisions not in spec" — are they consistent with the plan's intent?
- [ ] Any unsatisfied criteria → send acceptance failure message, do NOT mark complete
- [ ] Track fix attempts per criterion — if a criterion has failed 3 times, escalate to user, do NOT send another fix
- [ ] Only after all checks pass: `TaskUpdate(taskId: "[id]", status: "completed")`
