# Rollback Protocol — Full Matrix

## Stage Transitions

| From | To | Trigger | Re-entry Point |
|------|-----|---------|----------------|
| team-build | team-plan | Plan under-specified — builders had to guess, file conflicts, wrong task boundaries | /team-plan Step 2 (boundaries) or Step 4 (specs) |
| team-build | team-design | Design assumption invalidated — library limitation, infeasible approach, misclassified constraint | /team-design Step 4 (First-Principles Reconstruction) |
| team-qa | team-build | QA reveals implementation doesn't match intent — not just style, but builder misunderstood acceptance criteria | /team-build — targeted fix agent on affected group |
| team-qa | team-design | QA reveals architectural issue — library doesn't support assumed capability, pattern incompatibility | /team-design Step 4 (First-Principles Reconstruction) |
| team-ship | team-build | Pre-ship test suite fails — regression introduced by merge or environment difference | /team-build — targeted fix agent |
| team-ship | team-qa | Post-merge tests fail — test that passed in isolation fails after merge | /team-qa — re-run on merged files |

## Artifact Handling Rules

### What to Preserve
- All builder work (code, models, queries, tests written so far)
- Test results from failed attempts (diagnostic evidence)
- Builder messages and blocker reports (context for next attempt)
- Drift check reports (evidence of what diverged)

### What to Invalidate
- Affected task group specs (mark as "needs re-planning" if rolling back to /team-plan)
- Design recommendation (mark as "invalidated" if rolling back to /team-design)
- QA report (invalid if implementation changes after rollback)

### What to Pass Forward
Rollback context must be structured — the receiving stage needs to know:

```
## Rollback Context

**From:** [stage] — [specific trigger]
**To:** [target stage] — [re-entry point]

**What failed:**
- [Specific finding 1 — cite acceptance criterion, drift finding, or QA item]
- [Specific finding 2]

**What was learned:**
- [Constraint or fact discovered during the failed attempt]
- [Library limitation, pattern incompatibility, or assumption disproved]

**Builder work preserved at:**
- [Branch name or file paths with existing work]

**Recommendation:**
- [What the receiving stage should do differently]
```

## Decision Authority

- **Lead recommends** rollback target with evidence (which findings trigger it, which stage should receive it)
- **User decides** whether to roll back, accept the risk, or try a different resolution
- **No unilateral rollback** — the lead never rolls back without user consent

Rollback is expensive (re-planning, re-building) but less expensive than shipping a fundamentally flawed implementation. The decision is the user's.
