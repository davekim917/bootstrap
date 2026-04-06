---
name: team-build
description: >
  Invoke after /team-plan is approved. Spawns parallel builder agents from the approved plan.
  Do NOT coordinate builds manually — this skill has drift checks, context isolation, and
  validation gates that only load when invoked.
version: 1.1.0
---

# /team-build — Team-Coordinated Parallel Build

## What This Skill Does

Executes the approved `/team-plan` using a coordinated team of builder agents. The current Claude
session acts as the lead: it runs a pre-build drift check (design vs. plan) to confirm the plan
faithfully reflects the design, creates the team, assigns work, monitors progress, validates
acceptance criteria, and runs a post-build drift check (plan vs. implementation). Builders execute
in parallel, each isolated to their own task group and files.

**Key principles:**
- **Lead never writes code.** It orchestrates, validates, and unblocks.
- **Builders never see other groups' files.** Context isolation prevents cross-contamination.
- **Every acceptance criterion is validated** by the lead, not self-reported by builders.
- **Pre-build drift check** (Step 2) confirms the plan faithfully reflects the approved design.
- **Post-build drift check** (Step 7) confirms implementation matches plan before the user approves.

**Output:** Implemented feature, validated against plan, cleared by `/team-drift` (both pre- and post-build)
**NOT output:** Anything before all acceptance criteria pass and drift checks clear

## Prerequisites

1. An approved plan document (from `/team-plan`)
2. All plan task groups have: exact file paths, code patterns, named test cases, acceptance criteria
3. An approved design document (from `/team-design`) — required for the pre-build drift check (Step 2). Standard location: `.context/specs/<feature>/design.md`. If not at the standard location, Step 2 will ask for it before proceeding.

**If the plan is missing any of these:** Stop and tell the user to run `/team-plan` first.

## When to Use

- After `/team-plan` is approved
- Do NOT auto-trigger — the user types `/team-build` to enter this workflow

---

## Process

### Step 1: Read and Parse the Plan

1. Read the approved plan — either from `.context/specs/<feature>/plan.md` or ask user to provide it
2. Read the decision record — `.context/specs/<feature>/decisions.yaml` (constraints, rejected options, waivers, assumptions). This record informs builder prompt construction and sequential group context refresh.
3. Read `CLAUDE.md` — extract:
   - Tech stack and key commands (test runner, lint, build)
   - Critical guardrails (must-never-miss rules)
   - Workflow hints (which project skills are relevant)
4. Parse the plan into:
   - **Task groups** — names, file ownership, task specs
   - **Dependency graph** — which groups block which
   - **Independent groups** — can start immediately (no blockedBy)
   - **Waived findings** — from review, carried forward as known risks

Write a mental model:
```
Independent (start immediately): Group A, Group B
Sequential (wait for A+B):       Group C
```

### Step 2: Pre-Build Drift Check (Design vs. Plan)

Locate the approved design document. Check in order:
- `.context/specs/<feature>/design.md` (standard location from `/team-design`)
- Ask the user: "I need the design document for the pre-build drift check. Where is it, or can you paste it?"

Do not proceed to the drift check or team creation until the design document is found, or the user explicitly waives the check (log the waiver as a known risk in the build record).

Then invoke `/team-drift`:

- **SOT:** The approved design document (`.context/specs/<feature>/design.md` or provided path)
- **Target:** The approved plan document (`.context/specs/<feature>/plan.md`)
- **Save report to:** `.context/specs/<feature>/pre-build-drift.md`

<!-- GATE: pre-build-drift — MISSING=0, DIVERGED=0 -->
**Gate:**
- If **MISSING > 0 or DIVERGED > 0:** STOP. The plan doesn't faithfully reflect the design. Display the blocking findings and tell the user to reconcile the plan with the design before proceeding. Do not create the team or spawn builders.
- If **MISSING == 0 and DIVERGED == 0:** Proceed to Step 3 (team creation). Log any PARTIAL findings as known risks carried into the build.

**Why before team creation:** Spawning builders costs tokens and time. If the plan drifts from the design, everything built from it is wrong. Catch it before spending anything.

### Optional: Worktree Isolation

**Pre-check (run before asking):**
1. Run `git worktree list` — if current directory is already a worktree, skip this step entirely.
2. Check current branch name:
   - If on `main`/`master`: show "Currently on main. Isolating on a new branch is recommended."
   - If on a feature branch: show "Currently on <branch-name>. Continue here, or create a new worktree?"

**If pre-configured in CLAUDE.md** (`worktree: always` / `worktree: never`): follow config, skip question.

**Otherwise, ask once:** [continue on current branch / create worktree]

If worktree chosen:
- Check if `.worktrees/` exists and is in `.gitignore`; add + commit if not.
- `git worktree add .worktrees/<feature-name> -b <feature-branch>`
- Run project setup (`npm install` / `pip install` / etc.).
- Run baseline tests; if failing, report + ask whether to proceed.

If continue chosen:
- If on `main`/`master`: log "Proceeding on main — known risk."
- Proceed to Build Path Selection.

Do not ask again.

---

### Build Path Selection

Before creating the team, determine which execution path fits this build:

**Path A: Team-Coordinated (default)** — Use when:
- More than 3 task groups in the plan
- Cross-group dependencies exist (groups that block other groups)
- Groups share interface contracts that need lead coordination

This is the existing flow described in Steps 3-6 below.

**Path B: Subagent-Driven** — Use when:
- 3 or fewer task groups in the plan
- No cross-group dependencies (all groups are independent)
- No shared interface contracts between groups

Path B uses same-session sequential execution with the same verification gates. Details in `references/subagent-build-path.md`.

The user can override path selection. If uncertain, default to Path A (team-coordinated).

---

### Step 3: Create Team and Register Tasks

**Create the team:**
```
TeamCreate(
  team_name: "[feature-name]-build",
  description: "[feature name] — [N] task groups, [N] builders"
)
```

**Create one task per group** using TaskCreate. Set `blockedBy` from the plan's dependency graph:
```
TaskCreate(subject: "Group A: [Name]", description: "[full group spec from plan]", activeForm: "Building [Name]")
TaskCreate(subject: "Group B: [Name]", ...)
TaskCreate(subject: "Group C: [Name]", ...)  → then TaskUpdate(addBlockedBy: ["[A-id]", "[B-id]"])
```

**Important:** The task `description` should be the complete task group spec from the plan —
builders will read it from the task list to know what to do.

### Step 4: Spawn Builder Agents

Spawn one builder per **independent** task group simultaneously (parallel Task tool calls).
Sequential groups are spawned after their dependencies complete (Step 5 handles this).

**For each independent group**, launch a background Task with `run_in_background: true`:

```
Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  team_name: "[feature-name]-build",
  name: "builder-[group-name]",
  run_in_background: true,
  prompt: [see references/builder-prompt-template.md]
)
```

The builder prompt (see `references/builder-prompt-template.md`) must contain:
1. The complete task group spec verbatim from the plan (all tasks, code patterns, test cases, acceptance criteria)
2. CLAUDE.md excerpts: tech stack, test/lint commands, critical guardrails
3. The team name and their task ID (so they can TaskUpdate and SendMessage)
4. Clear instructions: read only owned files, report via SendMessage, don't load external skills

### Step 5: Monitor, Unblock, and Validate

The lead stays active as the message hub. Builders send two types of messages:

**Completion report** (see `references/completion-report-format.md`):
- Builder reports tasks done, test results, acceptance criterion status
- Lead validates: reads the files, runs the named tests via Bash, checks each acceptance criterion
- If criteria pass: TaskUpdate(status: "completed") and check if this unblocks a sequential group
- If criteria fail: SendMessage to builder with specific fix required

**Blocker notification:**
- Builder reports what it's stuck on
- Lead investigates: reads relevant files, checks CLAUDE.md, makes the decision
- SendMessage to builder with the resolution (a decision, a clarification, a file path)

**When a sequential group becomes unblocked:**

**Context refresh (required before spawning):**
Before constructing the builder prompt for a sequential group, re-read:
1. `.context/specs/<feature>/decisions.yaml` — extract decisions and constraints where `affects_groups` includes this group
2. `.context/specs/<feature>/design.md` — re-read the constraint analysis and recommendation sections
3. `.context/specs/<feature>/build-state.md` — re-read your own checkpoint to recover any compressed context

Do not rely on conversation context for constraint details — it may have been compressed during earlier group validation.

Spawn its builder immediately:
```
Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  team_name: "[feature-name]-build",
  name: "builder-[group-c-name]",
  run_in_background: true,
  prompt: [group C spec + context that A and B produced]
)
```

**Lead validation checklist per group (before marking complete):**
- [ ] Each file listed in the group exists at the exact path specified
- [ ] For MODIFY tasks: read the file, confirm the specified changes are present
- [ ] Run each named test case: `[test command from CLAUDE.md]`
- [ ] Every acceptance criterion verifies as true (not self-reported — actually check)
- [ ] No regressions: existing test suite still passes
- [ ] For frontend groups with render-check acceptance criteria: after functional criteria pass, the **lead** (not the builder) performs visual verification — start the dev server, use `mcp__chrome-devtools__navigate_page` + `mcp__chrome-devtools__take_screenshot` if devtools MCP is available; or if devtools MCP is unavailable, pause and tell the user explicitly: "Render-check required — [specific decision from the acceptance criterion, e.g., 'text-accent on bg-primary logo color']. Please verify in the browser and confirm to continue." Do not ask the builder for visual confirmation — builder agents cannot render or observe visual output. Do not self-approve render-checks.
- [ ] Domain-specific completion gate passes — see [`references/domain-completion-gates.md`](references/domain-completion-gates.md) for gates by artifact type (dbt, DAG, ML, LLM eval, agent/MCP, GL model)

### Two-Stage Implementation Review

After the validation checklist above passes, the lead performs two sequential reviews
before marking a group complete.

**Stage 1: Spec Compliance**

> **Distinction from post-build drift:** Spec compliance (Stage 1, per-group) verifies each
> task's output matches its task spec — a task-level check. Post-build drift (Step 7) verifies
> the aggregate implementation matches the plan's file ownership map — a build-level check
> that catches cross-group issues (e.g., Group A's output file overwritten by Group C).
> Both checks are needed; they do not overlap.

Re-read the original task spec from the plan for this group.

**Adversarial stance:** Assume the builder's completion report is optimistic. Do not trust self-reported
criteria status. Read the actual code and run the actual tests — verify everything independently.
The builder may have misunderstood the spec, implemented something slightly different from what was
asked, or reported a criterion as passing based on reading code rather than running verification.

For each task in the group:
1. Check each acceptance criterion by name — not a general impression.
2. For each `ASSERT:` annotation in the task spec: verify the stated condition holds.
   (ASSERT checks are active only for tasks written in the contracts format.
    Tasks without ASSERT lines fall back to the general criteria check.)
3. Verify each file listed in the spec was created or modified.
4. Verify no unspecified files were created or modified (over-building check).

Report: ✅ all criteria met, or ❌ list of unmet criteria by task + criterion name.
Unmet criteria → builder fixes → spec compliance re-run. Do not proceed to Stage 2 until ✅.

- Issues → SendMessage to builder with file:line → builder fixes → re-review
- Same 3-iteration retry limit as Fix Loop below

**Stage 2: Code Quality**
After Stage 1 clears: well-structured? follows CLAUDE.md conventions? obvious perf issues?
adequate error handling at boundaries? hardcoded values that should be configurable?
- MUST-FIX → builder fixes → re-review (3-iteration limit)
- SHOULD-FIX → logged for /team-qa phase

Builders follow the `/team-receiving-review-feedback` protocol when processing review findings: evaluate before implementing, verify claims, check necessity.

Gate: both stages clear before marking group complete.

<!-- GATE: group-validation — Both review stages clear, all criteria verified -->

### Lead Context Checkpoint

After marking each group complete (and before spawning the next sequential group), write or update
`.context/specs/<feature>/build-state.md`:

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

This file is the lead's persistent memory. **If your conversation context has been compressed, re-read
this file before any coordination action** (spawning builders, validating criteria, running drift checks).

The checkpoint ensures that context compression during long builds does not cause the lead to forget
validation results, interpretation calls, or accumulated risks.

### Verification Before Completion

Lead verification gate (IDENTIFY → RUN → READ → VERIFY → CLAIM):
Before marking any group complete, the lead must:
1. IDENTIFY the specific tests and criteria to verify
2. RUN the actual commands
3. READ the actual output
4. VERIFY actual vs expected
5. CLAIM only after verification

Forbidden wording (lead and builders):
- "should work now" / "I'm confident" / "looks correct" / "I believe this passes"
These indicate unverified claims. Replace with: actual command → actual output → comparison.

### Fix Loop Retry Limit

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

4. Do NOT continue the build or mark the group complete until the user responds.

### Step 6: Shut Down Team

When all task groups are complete and validated:

1. Send shutdown to each builder:
   ```
   SendMessage(type: "shutdown_request", recipient: "builder-[name]", content: "Your group is validated. Shutting down.")
   ```
2. Wait for shutdown confirmations
3. TeamDelete to clean up

### Step 7: Post-Build Drift Check

After the team is shut down, run `/team-drift`. This is the implementation drift check (plan vs. code), distinct from the pre-build fidelity check (design vs. plan) in Step 2.

- **SOT:** The approved plan document
- **Target:** The implementation (all files listed in the plan's file ownership map)
- **Save report to:** `.context/specs/<feature>/post-build-drift.md`

```
/team-drift
SOT: .context/specs/[feature]/plan.md
Target: [list of built files from plan's file ownership map]
Save report to: .context/specs/[feature]/post-build-drift.md
```

<!-- GATE: post-build-drift — Implementation matches plan -->

Any MISSING or DIVERGED findings go back for fixes. The builder agents are gone — the lead
handles these directly (or spawns a targeted fix agent).

### Drift Fix Retry Limit

Track drift fix-and-recheck cycles. After **3 cycles** where the drift check still finds MISSING or DIVERGED:

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

3. Do NOT proceed to Step 8 until the user responds.

### Step 7.5: Pre-Gate Artifact Check

Before proceeding to Step 8, verify both drift report artifacts exist on disk:

1. **Pre-build drift report:** Read `.context/specs/<feature>/pre-build-drift.md`
2. **Post-build drift report:** Read `.context/specs/<feature>/post-build-drift.md`

For each report, extract the summary line (MISSING/DIVERGED/PARTIAL/CONFIRMED counts).
Paste the **actual summary lines from the files** into the Step 8 template.

**Do not type drift numbers from memory. Read them from the artifact files.**

If either file does not exist: **STOP. You skipped a drift check.** Go back to the missing step
(Step 2 for pre-build, Step 7 for post-build) before proceeding.

### Step 8: STOP — Gate

When drift check clears, present the summary and wait for user approval:

```
---
**Build complete.**

Groups completed: [N/N]
Acceptance criteria: [N] passed, [N] failed (0 should be here)
Drift check: CONFIRMED [N], PARTIAL [N], MISSING 0, DIVERGED 0
Waived review findings: [N] — [verify each was handled or remained acceptable]

The implementation is ready for /team-qa.
Say "approved" to proceed, or flag anything to revisit.
---
```

<!-- GATE: build-approval — Build approved before /team-qa -->

**Do not close the session or mark the build done until the user explicitly approves.**

---

## Builder Context Isolation

Each builder receives: task group spec (complete, with injected ASSERTs) + CLAUDE.md excerpts (stack/commands/guardrails) + team name + task ID.

Each builder reads only files in their task group's ownership list. Each builder never reads other groups' files, loads project skills, reads the full plan, or writes to files outside their ownership. Cross-group reads introduce mid-build assumptions about unfinished work — isolation eliminates this failure class.

---

## Lead Responsibilities

**Lead DOES:** read plan/design/decision record, run drift checks, create team, spawn builders, answer blockers, validate criteria by reading files and running tests, write context checkpoints, shut down builders.

**Lead does NOT:** write or edit code, make implementation decisions that should have been in the plan (flag to user instead), run builders sequentially when they could run in parallel.

## Handling Mid-Build Problems

See [`references/handling-build-problems.md`](references/handling-build-problems.md) — covers plan ambiguity, file conflicts, test failures, and external dependency blockers.

---

## Rollback Protocol

**Triggers:** drift check shows DIVERGED/MISSING after fixes; 3 failed fix cycles on same criterion; criteria that cannot be verified as written; design assumption invalidated by implementation.

**Rollback targets:** `build → plan` (plan under-specified, re-enter `/team-plan` Step 2 or 4) or `build → design` (design assumption invalidated, re-enter `/team-design` Step 4). Preserve all builder work; pass rollback context forward.

**Execution:** Lead recommends rollback target with evidence. User decides. No unilateral rollback.

See [`references/rollback-protocol.md`](references/rollback-protocol.md) for the full stage transition matrix and artifact handling rules.

---

## Anti-Patterns (Do Not Do These)

- **Don't let builders load project skills.** `/team-plan` already transcribed the patterns into task specs. Extra context bloats builder context and risks contradicting the spec.
- **Don't self-report acceptance criteria.** "Builder says it's done" is not validation. Lead reads the files and runs the tests. Exception: render-check criteria are lead-verified via visual inspection, not builder self-report — see Step 5 checklist.
- **Don't spawn sequential groups before their dependencies complete.** Verify via TaskList that blocking tasks are `completed` before spawning the next builder.
- **Don't skip the drift check.** A build that doesn't run `/team-drift` hasn't been validated against the plan — it's assumed correct, not confirmed.
- **Don't let the lead write code.** If the lead starts writing code, it has lost context isolation and is now operating outside its role.
- **Don't delete the team before all shutdown confirmations.** TeamDelete on an active team leaves agents in an inconsistent state.
- **Don't loop indefinitely on failures.** If a criterion fails 3 times or drift doesn't converge after 3 cycles, escalate to the user. Autonomous loops without termination guards waste tokens and delay resolution.
- **Don't skip context checkpoints.** After each group completion, write `build-state.md`. Context compression during long builds silently erases the lead's working memory. Checkpoints are the recovery mechanism.
- **Don't spawn sequential groups from memory.** Always re-read the decision record and design before constructing the next builder's prompt. The lead's conversation context may have been compressed since the last group.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "The builder said it passed — I'll trust that" | Builder self-report is not validation. Lead reads the files and runs the tests. |
| "The tests are slow, I'll skip running them" | Unrun tests are not verified criteria. Run them — that's the entire point of named test cases in the spec. |
| "I'll skip the pre-build drift check to save time" | If the plan drifts from the design, everything built from it is wrong. Catching it before spawning saves more time than it costs. |
| "The post-build drift check is probably fine, we followed the plan" | "Probably" is not confirmed. Run `/team-drift`. CONFIRMED is the only acceptable outcome. |
| "Context checkpoints slow the build down" | Without checkpoints, context compression silently erases validation results. The recovery cost is higher than the write cost. |
| "All groups can run in parallel — dependencies don't matter here" | Sequential groups exist because they depend on outputs from blocking groups. Spawning early produces builds from incomplete inputs. |
| "I'll fix this one criterion myself instead of sending it back to the builder" | Lead writing code breaks context isolation and role boundaries. Send the fix back to the builder. |
| "The rollback is overkill — I'll patch around the issue" | Patches that contradict the design accumulate. Rollback is the mechanism for surfacing a real constraint the plan missed. |
