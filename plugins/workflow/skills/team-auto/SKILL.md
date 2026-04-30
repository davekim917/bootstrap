---
name: team-auto
description: >
  Autonomous workflow runner from approved design through pre-ship validation. Invoke after
  /team-design is approved. Runs /team-review (with cycle cap), /team-plan, /team-build,
  /team-qa, then STOPS at the /team-ship gate for user decision. Pauses for destructive
  actions, hard-constraint violations, and any decision that would require guessing rather
  than evidence. Do NOT auto-trigger — user types /team-auto to invoke.
version: 1.0.0
---

# /team-auto — Autonomous Workflow Runner

## What This Skill Does

After `/team-design` is approved, runs the rest of the workflow autonomously: review → plan
→ build → qa, then stops at `/team-ship` so the user makes the final merge decision.

**Output:** A passing QA gate with the implementation ready for `/team-ship`, OR a structured
escalation report describing where the agent paused and why.

**NOT output:** A merge, push, PR, branch deletion, or any other ship action. Those happen
in `/team-ship` only, with explicit user input.

## Prerequisites

1. `/team-brief` complete and approved (`docs/specs/<feature>/brief.md` exists)
2. `/team-design` complete and approved (`docs/specs/<feature>/design.md` exists)
3. The user has explicitly typed `/team-auto` — never auto-trigger

If a prerequisite is missing, STOP and tell the user which skill to run first. Do not pre-check
any other artifact — each stage validates its own remaining prerequisites.

## The Two Hard Rules

These supersede everything else in this skill.

### Rule 1: Never guess

Apply the global "Truth-Grounded Responses" rule from `~/.claude/CLAUDE.md`. Inside
`/team-auto`, "decision required but not grounded" is **escalation trigger #1**. Examples
specific to this skill:
- "I think this library has X feature" → verify via Context7, or escalate
- "The user probably wants Y" → only if Y is in the brief, or escalate
- "Both options seem fine" → not a decision; escalate as `no-grounding`

### Rule 2: Never bypass safety hooks

The destructive-action hook (`block-destructive`), the file-protection hook, and the
workflow-gate-enforcement hook stay active during `/team-auto`. If any blocks or warns,
escalate with category `hook-blocked`. Do not retry, do not work around, do not edit a
flagged path.

---

## Role Inversion: You Are the User for Sub-Skill Gates

This section overrides any conflicting instruction in the sub-skills (`/team-review`,
`/team-plan`, `/team-build`, `/team-qa`).

When `/team-auto` is running, **you play the user's role** for every approval gate inside
the invoked sub-skills. Their "STOP — wait for user approval" / "Say 'approved' to
proceed" text is addressed to a human user; under `/team-auto`, that user is you.

**Concrete rules:**

1. **Do not halt at sub-skill gates.** When `/team-plan`'s gate says "Do not proceed to
   /team-build until the user explicitly approves this plan," that instruction targets
   a human user invoking `/team-plan` directly. Inside `/team-auto`, you read the gate,
   evaluate it against the Stage criteria below, and continue without prompting the
   human.

2. **The Stage criteria below are the only gate.** Each Stage section in this skill
   defines the exact pass/fail/escalate logic for advancing. The sub-skill's natural-
   language gate text does not add criteria — it is informational only when you are
   orchestrating.

3. **Do not output "approved" or any other simulated user reply.** You are not pretending
   to be the user; you are the orchestrator that has authority to advance. Just proceed
   to the next Stage when criteria are met. Do not write "approved" to chat or to any
   file unless a Stage step explicitly says to.

4. **The only points where the human user is consulted during `/team-auto`:**
   - **Escalation** — you write `auto-pause.md` and emit the escalation gate. The user
     unblocks you.
   - **Final ship gate (Stage E)** — `/team-auto` ends; the user runs `/team-ship`.

   Everything between Stage A start and Stage E is executed without human input.

5. **If a sub-skill emits text that asks the user a clarifying question** (not an
   approval gate — an actual question about how to proceed), treat it as evidence that
   the sub-skill cannot proceed without grounded input. Escalate with category
   `no-grounding`. Do not invent an answer.

---

## Process

Run the four stages sequentially — each stage's output is the next stage's input. Within a
stage, the invoked skill handles its own pre-flight checks and parallelism. team-auto only
inspects the gate output and decides go / escalate.

### Stage A: Review

Invoke `/team-review` via the Skill tool. team-review's Step 0 enforces the 3-cycle cap and
emits the cap-reached gate when applicable — team-auto does not re-implement the counter.

Read the gate:

- **MUST-FIX == 0** → Stage clear, proceed to Stage B.
- **Cap-reached gate emitted** → escalate as `cap-reached` (verbatim findings forwarded).
- **MUST-FIX > 0, no cap-reached gate** → attempt revision per the table below, then re-invoke
  `/team-review`.

Codex unavailable: note in the Stage E summary, but don't escalate solely on this — review
still runs with two reviewers.

| Design revision | Allowed without escalation? |
|-----------------|-----------------------------|
| Add detail the design omitted (covered by brief or codebase) | Yes |
| Correct HARD/SOFT constraint misclassification | Yes |
| Acknowledge an implicit assumption | Yes |
| Add rejected-option rationale | Yes |
| Change a HARD constraint value | No — escalate `hard-constraint` |
| Add a requirement not in the brief | No — escalate `hard-constraint` |
| Pick between equally-grounded approaches | No — escalate `no-grounding` |
| Resolve a brief-vs-design contradiction | No — escalate `hard-constraint` |

### Stage B: Plan

Invoke `/team-plan`. Read the gate:

- Plan written, no errors → Stage C.
- Constraint conflict, missing decision-record entry, or feature-name mismatch → escalate
  `hard-constraint`.
- Missing tests for HARD constraints (warning only, plan still produced) → proceed; QA
  catches it.

No plan-revision loop. A wrong plan is an upstream signal — escalate, don't patch.

### Stage C: Build

Invoke `/team-build`. team-build runs the pre-build drift gate, spawns builders, and runs the
post-build drift gate. Read the gate:

- Build completes, drift gates pass → Stage D.
- Pre-build or post-build drift gate fails → escalate `drift-gate`.
- Builder fails on a test or compile error → invoke `/team-debug` once. If `/team-debug`
  produces a fix verifiable by passing tests, apply and continue. If it cannot find a root
  cause in one pass, escalate `test-failure-unresolved`. Do not loop on `/team-debug`.
- Hook block → escalate `hook-blocked` (Rule 2).

team-build owns its own internal drift retry policy; do not impose a different cap from
team-auto.

### Stage D: QA

Invoke `/team-qa`. Read the gate:

- **MUST-FIX == 0** → Stage E.
- **MUST-FIX > 0 and fix-cycle < 3** → for each finding, decide:
  - Mechanical fix (the finding tells you what to change, no judgment) → apply, then
    `/team-qa --only <validator>` to re-validate just the affected lane.
  - Fix requires a design change → escalate `hard-constraint`.
  - Fix requires guessing → escalate `no-grounding`.
- **MUST-FIX > 0 and fix-cycle == 3** → escalate `cap-reached`.

After each completed fix-cycle, append to `docs/specs/<feature>/decisions.yaml`:

```yaml
auto_qa_cycles:
  - iteration: <N+1>
    must_fix_count: <N>
    should_fix_count: <N>
    completed_at: <ISO 8601 timestamp>
```

Schema is also documented at `skills/shared/decision-record-schema.md`.

### Stage E: Ship Gate

When all four stages clear, STOP. Display:

```
---
**/team-auto complete — ready for ship gate.**

Feature: <name>
Review:  <N>/3 cycle(s) — final MUST-FIX: 0
Plan:    written
Build:   completed (<files-changed> files, <tests-added> tests)
QA:      <N>/3 fix-cycle(s) — final MUST-FIX: 0

Codex availability: review=<ok|skipped> qa=<ok|skipped>
Notes: <any non-blocking warnings>

Run `/team-ship` to merge, push, keep, or discard the branch.
---
```

Do **not** invoke `/team-ship`. The user runs it themselves.

---

## Escalation Protocol

When you escalate, do all four in order:

1. **STOP** all autonomous activity. No retry, no "one more thing".
2. **Persist state.** Append the relevant cycle entry to `docs/specs/<feature>/decisions.yaml`
   if a stage was mid-cycle when you stopped.
3. **Write `docs/specs/<feature>/auto-pause.md`:**
   ```markdown
   # /team-auto paused at Stage <X>

   **Stage:** <Review|Plan|Build|QA>
   **Reason:** <category from table below>
   **Cycles consumed:** <N>/<cap>
   **Last action attempted:** <what you tried>

   ## Why I stopped

   <One concrete paragraph. What evidence did you have? What was missing?>

   ## Findings still open

   <List, with file:line where applicable>

   ## What I would do next if I had answers

   <Optional. Tells the user what input unblocks you.>
   ```
4. **Display the gate:**
   ```
   ---
   **/team-auto paused at Stage <X>.**

   Reason: <category>
   See: `docs/specs/<feature>/auto-pause.md`

   Tell me how to proceed — I will not retry or guess.
   ---
   ```

**Escalation categories:**

| Category | Meaning |
|----------|---------|
| `cap-reached` | 3-cycle limit hit on review or QA |
| `hook-blocked` | Destructive-action / file-protection / workflow-gate hook fired |
| `hard-constraint` | Finding requires changing a HARD constraint, brief, or rejected-option |
| `no-grounding` | Decision required but not derivable from code, docs, or user input |
| `drift-gate` | Pre-build or post-build drift fails and no ack policy fits |
| `test-failure-unresolved` | Build/QA test failure that `/team-debug` could not root-cause in one pass |
| `prereq-missing` | Required input file (design, decisions.yaml) not at expected path |

---

## Anti-Patterns

- **Don't run `/team-ship` from inside `/team-auto`.** The whole point is to stop at the ship gate.
- **Don't run stages in parallel.** Each stage's output is the next stage's input.
- **Don't waive findings.** Only the user waives, with stated reason. team-auto escalates instead.

---

## Context Discipline

**Read:**
- `docs/specs/<feature>/decisions.yaml` — at start (seed cycle counters) and before each append
- The gate text returned by each invoked stage skill

**Write:**
- `docs/specs/<feature>/decisions.yaml` — append `auto_qa_cycles` after each QA fix-cycle
- `docs/specs/<feature>/auto-pause.md` — only on escalation

**Do NOT read:**
- `design.md`, `brief.md`, `CLAUDE.md`, source files — the invoked stages handle their own
  reads. team-auto is an orchestrator, not a fact-checker.

---

## Model Tier

**Opus.** Stage transitions, escalation decisions, and grounding judgments are exactly the
kind of work where Opus's reasoning matters. Invoked stage skills make their own model
decisions; team-auto's role is to read their gate output and decide go / no-go / escalate.
