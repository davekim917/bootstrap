---
name: team-auto
description: >
  Autonomous workflow runner from approved design through pre-ship validation. Invoke after
  /team-design is approved. Runs /team-review (with cycle cap), /team-plan, /team-build,
  /team-qa, then STOPS at the /team-ship gate for user decision. Pauses for destructive
  actions, hard-constraint violations, and any decision that would require guessing rather
  than evidence. Do NOT auto-trigger — user types /team-auto to invoke.
version: 1.2.0
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

## Three Foundational Principles

The whole skill turns on these three. Read them first; the stage logic below is mechanical execution of what they imply.

### Principle 1: Decisions without grounding are guesses, but engineering judgment with grounding is the work

`/team-auto` runs without a human-in-the-loop, so any ungrounded decision becomes part of the artifact with no review. The global "Truth-Grounded Responses" rule from your agent's global config (`AGENTS.md`, or `CLAUDE.md`) applies absolutely. But not every decision is a guess — frontier-model judgment grounded in citable evidence (sub-skill findings, brief excerpts, project docs) is exactly the kind of work that justifies running autonomously in the first place.

Inside `/team-auto`:

**Guessing (escalate as `truly-ambiguous`):**
- "I think this library has X feature" → verify via Context7, or escalate
- "The user probably wants Y" → only if Y is in the brief, or escalate
- "I'm not sure what the codebase convention is here" → check via the sub-skill that already read it, or escalate
- "Both options seem fine" without grounding → not a decision; escalate

**Engineering judgment (apply, record under `auto_judgments`):**
- "Both options A and B exist in the codebase; A is more consistent with this module's pattern (per finding `<file:line>`)"
- "Library docs surfaced by the sub-skill show two valid approaches; the simpler one fits the brief's complexity budget"
- "This QA finding can be addressed by extracting a helper — the cited code already has 3 similar helpers, I'll match their shape"

The dividing line is **named, citable grounding**. Acceptable grounding sources:
- A code reference surfaced by a sub-skill finding (`file:line`)
- A doc citation surfaced by a sub-skill (Context7, README, design.md excerpt the sub-skill quoted)
- A brief excerpt the sub-skill quoted
- An established codebase convention — must cite either a project doc / `AGENTS.md/CLAUDE.md` line, or **at least two** code references in the same area, that the sub-skill surfaced

Training data is **not** an acceptable grounding source (per your global agent config's truth-source rule). If the only thing supporting a decision is "this is generally how it's done," that is guessing — escalate.

### Principle 2: Safety hooks are the only thing standing between autonomous work and irreversible damage

`block-destructive`, file-protection, and workflow-gate-enforcement exist precisely because the human is not in the loop on every action. When one fires, it has caught something the orchestrator was about to miss — that is signal, not noise. Working around a hook block defeats the safety model.

The hooks stay active throughout `/team-auto`. If any blocks or warns, escalate with category `hook-blocked`. Don't retry, don't work around, don't edit a flagged path.

### Principle 3: Escalating every judgment call defeats the purpose of running autonomously

Earlier versions of this skill escalated on almost any non-mechanical decision — and the result was that nearly every run paused for human input on choices the model had clear grounding for. That collapsed the autonomous workflow back into a manual one with extra ceremony. The orthogonal rule to Principle 1: when a decision is required and falls within established engineering practice with citable grounding, *make the decision* and record it.

**Escalate when a decision would change:**
- User-facing product intent (what the system does for the user, not how)
- A HARD constraint declared in the design
- Product scope (adding or removing capabilities)
- A safety or correctness invariant the design or codebase relies on

**Apply judgment (record under `auto_judgments`, do not escalate) when the decision is:**
- Choosing between approaches with similar grounding (e.g. two valid patterns in the codebase, both surfaced by a sub-skill finding)
- Resolving scope ambiguity in a way consistent with the brief's intent
- Adding a code-quality fix, refactor, or test that doesn't change observable behavior
- Filling a documentation gap (rejected-option rationale, design assumption)
- Picking the more conservative option when both are correct
- Applying an established codebase convention over a less-established alternative

**Grounding-and-scope check — run before applying judgment:**

1. **Cite grounding** the sub-skill already surfaced: `file:line`, doc citation, brief excerpt, or convention evidence. A convention requires either a project doc / `AGENTS.md/CLAUDE.md` citation or at least two code references in the same area. Training data is not acceptable.
2. **Negative scope check** — answer all four explicitly:
   - Does this add or remove a user-facing capability? If yes → escalate `hard-constraint`.
   - Does this change API / schema / UI / CLI output / error behavior visible to a user? If yes → escalate `hard-constraint`.
   - Does this change a HARD constraint? If yes → escalate `hard-constraint`.
   - Does this weaken a safety or correctness invariant? If yes → escalate `hard-constraint`.
3. If grounding cannot be cited or any scope answer is "unknown," escalate `truly-ambiguous`.

Record the citations and the four scope answers in the `auto_judgments` entry — that is the audit trail.

---

## Sentinel: `.team-auto-active`

When Stage A begins, write an empty sentinel file at `docs/specs/<feature>/.team-auto-active`. Touch it (update mtime) at every stage transition (start of B, C, D, E) and after every QA fix-cycle.

**Why:** The `AskUserQuestion` block hook reads this sentinel to enforce no-mid-flight prompts. A fresh sentinel (mtime < 30 min) means the hook will reject any `AskUserQuestion` call — the only way to consult the human is through the escalation protocol (write `auto-pause.md`, display the gate, exit).

**Lifecycle:**
- Stage A start → create sentinel
- Stage transitions and fix-cycle completions → `touch` the sentinel
- Stage E success → delete sentinel
- Escalation → delete sentinel as Step 0 of the protocol (escalation = team-auto has exited; the human takes over)
- Stale sentinel (mtime > 30 min) is ignored by the hook, so a crashed `/team-auto` never permanently blocks `AskUserQuestion`

**Do not bypass the hook.** If you find yourself wanting to call `AskUserQuestion`, that is the model drifting toward a manual workflow — re-read Principle 3 and the Stage D rules. The hook is not your adversary; it is the load-bearing enforcement of the principles below.

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
   `truly-ambiguous`. Do not invent an answer.

---

## Process

Run the four stages sequentially — each stage's output is the next stage's input. Within a
stage, the invoked skill handles its own pre-flight checks and parallelism. team-auto only
inspects the gate output and decides go / escalate.

### Stage A: Review

**First action of Stage A:** create the sentinel `docs/specs/<feature>/.team-auto-active` (empty file). Touch this sentinel at every subsequent stage transition.

Invoke `/team-review` (the way your runtime loads skills). team-review's Step 0 enforces the 5-cycle cap and
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
| Pick between approaches with similar codebase/brief grounding (after grounding-and-scope check) | Yes — record under `auto_judgments` |
| Resolve scope ambiguity consistent with brief intent (after grounding-and-scope check) | Yes — record under `auto_judgments` |
| Apply an established codebase convention over a less-established one (after grounding-and-scope check) | Yes — record under `auto_judgments` |
| Change a HARD constraint value | No — escalate `hard-constraint` |
| Add a requirement that expands product scope | No — escalate `hard-constraint` |
| Resolve a brief-vs-design contradiction that changes user-facing behavior | No — escalate `hard-constraint` |
| Decision required with no codebase / brief / convention grounding | No — escalate `truly-ambiguous` |

### Stage B: Plan

Invoke `/team-plan`. Read the gate:

- Plan written, no errors → Stage C.
- Plan has a fixable issue (missing decision-record entry, feature-name mismatch, ambiguous task scope, minor sequencing issue) **and `revision-cycle == 0`** → revise inline (run grounding-and-scope check; record any judgment calls under `auto_judgments`) and re-invoke `/team-plan`.
- Plan would require changing a HARD constraint, brief requirement, or product scope → escalate `hard-constraint`.
- Missing tests for HARD constraints (warning only, plan still produced) → proceed; QA catches it.

Revision cap: 1. A second revision is evidence of upstream design instability — escalate `cap-reached`, don't keep patching. (Plan revision is a deterministic repair of the artifact, not iterative validation like Review/QA — one pass is enough.)

### Stage C: Build

Invoke `/team-build`. team-build runs the pre-build drift gate, spawns builders, and runs the
post-build drift gate. Read the gate:

- Build completes, drift gates pass → Stage D.
- Pre-build or post-build drift gate fails → escalate `drift-gate`.
- Builder fails on a test or compile error → invoke `/team-debug`. If it produces a fix verifiable by passing tests, apply and continue. If the first pass narrows the problem with new evidence but does not fully resolve it, invoke `/team-debug` once more with that evidence. After 2 passes without a verified fix (not just a hypothesized root cause — the fix must pass the previously-failing test), escalate `test-failure-unresolved`. Do not loop further.
- Hook block → escalate `hook-blocked` (Principle 2).

team-build owns its own internal drift retry policy; do not impose a different cap from
team-auto.

### Stage D: QA

**Default disposition: iterate. Do not pause.** By the time Stage D runs, the feature has cleared brief + design + up to five review cycles + plan + build. Any QA finding framed as a new "design call" or "architectural choice" is presumptively reviewer noise dressed as a design question — design and review already had ~six passes to settle architecture. Apply judgment, record, move on. Genuine HARD-constraint or user-facing-behavior changes are the rare exception, not the default.

**Iteration scope: MUST-FIX only.**

- SHOULD-FIX and ADVISORY findings are **never touched in Stage D**. They are listed verbatim in the Stage E summary so the user can address them during `/team-ship` review (or defer).
- Do not estimate effort by severity tier, do not present a fix plan, do not enumerate "phases." Stage D is not a planning stage — it iterates and validates.

Touch the sentinel (`.team-auto-active`) at Stage D start and after every fix-cycle.

Invoke `/team-qa`. Read the gate:

- **MUST-FIX == 0** → Stage E.
- **MUST-FIX > 0 and fix-cycle < 5** → for each **MUST-FIX** finding (ignore SHOULD-FIX/ADVISORY), apply the cross-cutting `team-receiving-review-feedback` protocol (verify the finding, then evaluate: correct? necessary? complete? in scope?), then decide:
  - **Mechanical fix** (the finding tells you what to change, no judgment) — after the four-question evaluation passes, apply, then `/team-qa --only <validator>` to re-validate the affected lane.
  - **Judgment-grounded fix** (engineering choice with citable codebase / brief / convention grounding — picking a pattern, naming a helper, choosing how to split a function, applying a refactor that doesn't change observable behavior) — run the grounding-and-scope check, apply, append to `auto_judgments` in `decisions.yaml`, then re-validate.
  - **"Design call" reframed at QA stage** (finding presents a design tradeoff like "library A vs B", "frontend rewrite vs backend transform", "refactor strategy X vs Y") — **default: apply the more conservative / less-invasive option that is consistent with the existing design**. The design already chose; reviewer noise at QA stage does not re-open it. Cite the design section that authorized the existing approach, apply, record under `auto_judgments`. **Do not present options to the user.** Only escalate `hard-constraint` if the finding proves the existing design violates a user-facing requirement or safety invariant — not because two paths exist.
  - **User-facing change** (fix would change observable behavior visible to the user, a HARD constraint declared in the design, or product scope) → escalate `hard-constraint`.
  - **Truly ambiguous** (decision required with no citable grounding *and* the four scope-check answers are not all "no" / unknown) → escalate `truly-ambiguous`.
- **MUST-FIX > 0 and fix-cycle == 5** → escalate `cap-reached`.

**Forbidden Stage D actions (these patterns are evidence of bail-out, not legitimate escalation):**

- Calling `AskUserQuestion` (the block hook will refuse it — see the Sentinel section)
- Presenting "two options" or any N-options menu in chat
- Estimating fix effort by phase / severity tier and asking the user to choose a phase
- Summarizing planned fixes before iterating ("here's what I'm about to do…")
- Calling any finding a "design call" or "architectural decision" without first checking whether design.md already settled the underlying question
- Asking the user whether to also tackle SHOULD-FIX or ADVISORY findings — the answer is always no, by definition of Stage D's scope
- Stopping after applying a fix to "confirm before continuing" — re-validate via `/team-qa --only <validator>` and move to the next MUST-FIX

If you find yourself drafting any of the above, that is the signal to instead apply Principle 3 and iterate, or (rarely) write `auto-pause.md` and exit. There is no third path.

After each completed fix-cycle, append to `docs/specs/<feature>/decisions.yaml`:

```yaml
auto_qa_cycles:
  - iteration: <N+1>
    must_fix_count: <N>
    should_fix_count: <N>
    completed_at: <ISO 8601 timestamp>
```

Whenever a judgment call is applied at any stage (Review, Plan, Build, QA), also append:

```yaml
auto_judgments:
  - stage: <Review|Plan|Build|QA>
    iteration: <N>
    decision: <one-line summary of what was decided>
    alternatives_considered: [<option-A>, <option-B>]
    grounding:
      - <"file.ts:42 — finding from /team-qa">
      - <"docs/specs/<feature>/design.md §3 quoted by /team-review">
      - <"established convention in <area>: file-a.ts:10, file-b.ts:25">
    scope_check:
      adds_user_facing_capability: false
      changes_external_behavior: false
      changes_hard_constraint: false
      weakens_safety_invariant: false
    recorded_at: <ISO 8601 timestamp>
```

Both schemas are also documented at `skills/shared/decision-record-schema.md`.

### Stage E: Ship Gate

When all four stages clear, delete the sentinel (`docs/specs/<feature>/.team-auto-active`), then STOP. Display:

```
---
**/team-auto complete — ready for ship gate.**

Feature: <name>
Review:  <N>/5 cycle(s) — final MUST-FIX: 0
Plan:    written (<N>/1 revision pass(es))
Build:   completed (<files-changed> files, <tests-added> tests)
QA:      <N>/5 fix-cycle(s) — final MUST-FIX: 0

Auto judgments recorded: <N> — review `docs/specs/<feature>/decisions.yaml` (`auto_judgments`) before `/team-ship`.

Codex availability: review=<ok|skipped> qa=<ok|skipped>
Notes: <any non-blocking warnings>

Run `/team-ship` to merge, push, keep, or discard the branch.
---
```

Do **not** invoke `/team-ship`. The user runs it themselves.

---

## Escalation Protocol

When you escalate, do all five in order:

0. **Delete the sentinel** `docs/specs/<feature>/.team-auto-active`. Escalation means `/team-auto` has exited; the human now drives. Leaving the sentinel in place would keep the `AskUserQuestion` block hook armed against a human-led session.
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
| `cap-reached` | 5-cycle limit hit on Review or QA, or 1-revision limit hit on Plan |
| `hook-blocked` | Destructive-action / file-protection / workflow-gate hook fired |
| `hard-constraint` | Finding requires changing a HARD constraint, brief, product scope, or user-facing behavior |
| `truly-ambiguous` | Decision required with no citable codebase / brief / convention grounding |
| `drift-gate` | Pre-build or post-build drift fails and no ack policy fits |
| `test-failure-unresolved` | Build/QA test failure that `/team-debug` could not produce a verified fix for in 2 passes |
| `prereq-missing` | Required input file (design, decisions.yaml) not at expected path |

---

## Anti-Patterns

- **Don't run `/team-ship` from inside `/team-auto`.** The whole point is to stop at the ship gate.
- **Don't run stages in parallel.** Each stage's output is the next stage's input.
- **Don't waive findings.** Only the user waives, with stated reason. team-auto escalates instead.
- **Don't dress up scope creep as judgment.** "Apply judgment" means choosing between options with citable grounding (sub-skill finding, doc, brief, named convention). Adding a feature, expanding observable behavior, or making safety/correctness tradeoffs is escalation territory, not judgment territory. If you cannot name the specific grounding, it is not judgment — escalate.
- **Don't fabricate "convention."** A convention requires an actual citation: a project doc / `AGENTS.md/CLAUDE.md` line, or at least two code references in the same area surfaced by a sub-skill. "I've seen this pattern before" is not a citation — it's training data, which is not an acceptable grounding source.
- **Don't resurrect design questions at Stage D.** By QA, the feature has cleared brief + design + up to five review cycles + plan + build. A QA finding framed as "library A vs B" or "frontend vs backend" is presumptively not a new design call — design already chose. Apply the option consistent with the existing design, cite the design section, record under `auto_judgments`. Only escalate `hard-constraint` when the finding proves the existing design violates a user-facing requirement or safety invariant.
- **Don't call `AskUserQuestion` mid-flight.** The block hook will refuse it while the sentinel is fresh. If you feel the need to ask, the answer is one of: (a) apply judgment per Principle 3, (b) write `auto-pause.md` and escalate. There is no third path. Calling `AskUserQuestion` and seeing it blocked is wasted tokens and a sign of model drift.
- **Don't present a Stage D "fix plan" before iterating.** Stage D is not a planning stage. Iterate MUST-FIX findings one at a time, applying judgment with grounding, validating after each. SHOULD-FIX and ADVISORY are deferred to Stage E's summary unconditionally.

---

## Context Discipline

**Read:**
- `docs/specs/<feature>/decisions.yaml` — at start (seed cycle counters) and before each append
- The gate text returned by each invoked stage skill (this is your only source of grounding citations)
- A specific `file:line` cited in a sub-skill finding, **only when applying that exact mechanical or judgment-grounded fix to those exact lines**

**Write:**
- `docs/specs/<feature>/decisions.yaml` — append `auto_qa_cycles` after each QA fix-cycle; append `auto_judgments` whenever a judgment call is applied at any stage
- `docs/specs/<feature>/auto-pause.md` — only on escalation

**Do NOT read:**
- `design.md`, `brief.md`, `AGENTS.md/CLAUDE.md`, or the wider source tree to *gather* grounding — the invoked stages handle their own reads. If you need grounding the sub-skill didn't surface, re-invoke the sub-skill (or escalate). team-auto is an orchestrator, not a fact-checker.

The grounding you cite in `auto_judgments` must come from sub-skill output you actually have. Citing a `file:line` you have not seen surfaced is fabrication — escalate `truly-ambiguous` instead.

---

## Model Tier

**Current session model.** Stage transitions, escalation decisions, and grounding judgments are
exactly the kind of work where strong reasoning matters. Invoked stage skills and their subagents
inherit the session model; team-auto's role is to read their gate output and decide go / no-go / escalate.
