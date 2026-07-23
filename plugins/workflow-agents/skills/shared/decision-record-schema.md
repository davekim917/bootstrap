# Decision Record Schema

Cross-cutting artifact that accumulates decisions, rejections, constraints, waivers, assumptions,
review cycles, and autonomous judgments across workflow stages. Each stage appends or updates its
owned fields; no stage overwrites prior history.

**Written to:** `docs/specs/<feature>/decisions.yaml`

```yaml
feature: <feature-name>
created_by: /team-brief
last_updated_by: <stage>

constraints:
  - id: C1
    type: HARD | SOFT
    text: "Exact constraint text"
    source: brief | design | project-instructions | implicit
    verified: true | false
    affects_groups: []

decisions:
  - id: D1
    stage: brief | design | review | plan | build
    description: "What was decided"
    chosen: "The selected approach"
    rejected:
      - option: "Rejected alternative"
        reason: "Why it was rejected"
    constraint_refs: [C1]
    affects_groups: [A]

waivers:
  - id: W1
    stage: review | build | qa
    finding: "The finding that was waived"
    reason: "Why it was waived"
    risk_level: low | medium | high

assumptions:
  - id: A1
    stage: design
    text: "What is assumed"
    validation: "How to validate it"
    validated: true | false
    invalidated_at: null | <stage>

review_cycles:
  - iteration: 1
    must_fix_count: 0
    should_fix_count: 0
    wont_fix_count: 0
    completed_at: <ISO-8601 timestamp>

auto_qa_cycles:
  - iteration: 1
    must_fix_count: 0
    should_fix_count: 0
    completed_at: <ISO-8601 timestamp>

auto_judgments:
  - stage: Review | Plan | Build | QA
    iteration: 1
    decision: "One-line decision"
    alternatives_considered: ["A", "B"]
    grounding: ["file:line or approved-artifact citation"]
    scope_check:
      adds_user_facing_capability: false
      changes_external_behavior: false
      changes_hard_constraint: false
      weakens_safety_invariant: false
    recorded_at: <ISO-8601 timestamp>
```

`auto_judgments.scope_check` must be all `false`; any `true` routes to user escalation.
Grounding must come from evidence actually surfaced by the owning stage, not model memory.

## Stage Responsibilities

| Stage | Responsibility |
|---|---|
| `/team-brief` | Initialize constraints and user decisions/defaults |
| `/team-design` | Append chosen/rejected options, new constraints, and assumptions |
| `/team-review` | Append waivers and one `review_cycles` entry per invocation; hard cap 5 |
| `/team-plan` | Populate `affects_groups`; append interpretation/conflict decisions |
| `/team-build` | Append lead decisions and user-approved waivers |
| `/team-auto` | Append QA cycles (hard cap 5) and grounded autonomous judgments |

## Downstream Use

- `/team-plan` injects every HARD constraint and rejected option into at least one task ASSERT or
  acceptance criterion.
- `/team-build` sends each builder only records whose `affects_groups` contains that builder's group.
- `/team-drift` treats rejected options as negative REJECTION claims.
- Unvalidated assumptions and waivers remain visible as plan/build known risks.
