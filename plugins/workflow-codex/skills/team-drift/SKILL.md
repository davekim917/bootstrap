---
name: team-drift
description: Detect drift between Codex workflow artifacts, such as brief versus design, design versus plan, or plan versus implementation, using evidence-backed claim comparison.
---

# Team Drift

Use this skill when comparing two artifacts or checking whether implementation still matches requirements.

Read `../shared/codex-workflow-primitives.md`, then read both source artifacts end to end. If one artifact is code, inspect the relevant source paths and tests.

## Process

1. Extract concrete claims from source A.
2. Extract concrete claims from source B.
3. Match claims by behavior, contract, file path, data shape, or acceptance criterion.
4. Classify each pair:
   - aligned
   - missing
   - contradicted
   - ambiguous
   - obsolete by explicit later decision
5. Recommend the smallest artifact or code update needed to resolve accepted drift.

For high-risk comparisons, run two independent Codex passes: one extracting claims and one challenging the classification.

## Output

Write `docs/specs/<slug>/drift.md` or return inline with:

- Drift summary
- Claim table
- Evidence for every contradiction
- Required fixes
- Unverified assumptions

Do not call drift resolved until every required fix is either applied or explicitly deferred by the user.
