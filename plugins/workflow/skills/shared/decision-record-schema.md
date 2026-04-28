# Decision Record Schema

Cross-cutting artifact that accumulates decisions, rejections, constraints, waivers, and assumptions
across all workflow stages. Each stage **appends** to this file; no stage overwrites previous entries.

**Written to:** `docs/specs/<feature>/decisions.yaml`

---

## Schema

```yaml
feature: <feature-name>
created_by: /team-brief
last_updated_by: <stage that last wrote>

constraints:
  - id: C1
    type: HARD | SOFT
    text: "Exact constraint text"
    source: brief | design | CLAUDE.md | implicit
    verified: true | false
    affects_groups: []  # populated by /team-plan

decisions:
  - id: D1
    stage: brief | design | review | plan | build
    description: "What was decided"
    chosen: "The selected approach"
    rejected:
      - option: "Description of rejected alternative"
        reason: "Why it was rejected"
    constraint_refs: [C1, C3]  # which constraints informed this decision
    affects_groups: [A, B]     # which builder groups need to know (populated by /team-plan)

waivers:
  - id: W1
    stage: review | build | qa
    finding: "The finding that was waived"
    reason: "Why it was waived"
    risk_level: low | medium | high

assumptions:
  - id: A1
    stage: design
    text: "What is assumed to be true"
    validation: "How to validate this assumption"
    validated: true | false
    invalidated_at: null | <stage>

review_cycles:
  - iteration: 1
    must_fix_count: 5
    should_fix_count: 3
    wont_fix_count: 1
    completed_at: 2026-04-28T20:00:00Z
  - iteration: 2
    must_fix_count: 1
    should_fix_count: 2
    wont_fix_count: 1
    completed_at: 2026-04-28T20:30:00Z

auto_qa_cycles:
  - iteration: 1
    must_fix_count: 3
    should_fix_count: 2
    completed_at: 2026-04-28T21:00:00Z
```

---

## Stage Responsibilities

| Stage | Reads | Writes |
|-------|-------|--------|
| `/team-brief` | — | Initialize: `constraints` (from Step 2), `decisions` (from Steps 3-4 Q&A and forced defaults) |
| `/team-design` | Full record | Append: `decisions` (chosen option + rejected options), `constraints` (new HARD/SOFT from constraint analysis), `assumptions` (from Assumptions Log) |
| `/team-review` | Full record | Append: `waivers` (waived MUST-FIX findings with stated reasons), `review_cycles` (one entry per invocation; hard cap at 3) |
| `/team-plan` | Full record | Update: `affects_groups` on constraints and decisions. Append: `decisions` (interpretation calls, file conflict resolutions) |
| `/team-build` | Full record | Append: `decisions` (lead interpretation calls during build), `waivers` (escalated criteria accepted by user) |
| `/team-auto` | Full record | Append: `auto_qa_cycles` (one entry per QA fix pass; hard cap at 3). Reads `review_cycles` for cycle-cap evaluation. |

---

## How Downstream Stages Use the Record

### /team-plan — Constraint Injection

For each HARD constraint and each rejected option: encode as an ASSERT line or acceptance criterion
in the relevant task group's spec. The `affects_groups` field determines which groups receive which
constraints.

### /team-build — Builder Prompt Construction

The lead extracts entries where `affects_groups` includes the current builder's group. Only relevant
constraints and rejections are included — not the entire record.

### /team-drift — Negative Claim Extraction

Drift extractors treat each `rejected` entry as a REJECTION claim: "The SOT explicitly excludes
[rejected option] because [reason]." These are verified against the target like any other claim.

### /team-plan — Cross-Stage Traceability

After writing task specs, verify that every HARD constraint and every rejected option from the
decision record appears in at least one task's ASSERT or acceptance criteria.
