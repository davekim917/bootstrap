---
name: team-ship
description: >
  Branch lifecycle and shipping. Structured branch completion after /team-qa clears.
  Verifies test suite, checks branch status, presents exactly 4 options (merge locally,
  push PR, keep branch, discard), executes the chosen path. No code changes — git operations only.
version: 1.0.0
---

# /team-ship — Branch Lifecycle and Shipping

## What This Skill Does

Structured branch completion after `/team-qa` clears. Verifies readiness, presents options, executes the chosen shipping path.

**Output:** Branch merged, pushed, kept, or discarded — with confirmation.
**NOT output:** Code changes. Validation. Bug fixes. Those belong in `/team-build` and `/team-qa`.

## Prerequisites

1. `/team-qa` has cleared (all findings fixed or explicitly waived)
2. A feature branch exists (not on main/master)
3. All tests pass

**If prerequisites are not met:** Stop and tell the user what's missing.

## When to Use

- After `/team-qa` clears and the user wants to ship
- User explicitly types `/team-ship`

**Do NOT use:**
- Mid-development (use `/team-build`)
- Before `/team-qa` (run `/team-qa` first)
- Not auto-triggered — the user invokes this explicitly

## Process

### Step 1: Verify Test Suite

Run the full test suite (test command from CLAUDE.md).

<!-- GATE: ship-tests — ALL tests pass before proceeding -->

**Gate:** ALL tests pass. If any test fails, STOP. Report the failures. Do not proceed — go back to `/team-build` or `/team-debug`.

### Step 2: Verify Branch Status

1. Confirm not on main/master branch
2. Check for uncommitted changes — if any exist, STOP and report
3. Check for unpushed commits — report count
4. Check if branch is up to date with remote (if tracking)

<!-- GATE: ship-branch-status — Clean branch, no uncommitted changes -->

Report the status:
```
Branch: [branch-name]
Uncommitted changes: none
Unpushed commits: [N]
Remote tracking: [yes/no] — [up to date / behind by N]
```

### Step 3: Present Options

Present exactly 4 options to the user:

```
How would you like to ship this branch?

1. **Merge locally** — merge into main, delete feature branch
2. **Push for PR** — push branch to remote, create pull request via gh
3. **Keep branch** — do nothing, branch stays as-is
4. **Discard** — delete the feature branch (requires confirmation)
```

Wait for user selection. Do not proceed without explicit choice.

### Step 4: Execute Choice

**Option 1 — Merge locally:**
1. Switch to main: `git checkout main`
2. Pull latest: `git pull`
3. Merge: `git merge [branch-name]`
4. Run tests again after merge
5. Delete feature branch: `git branch -d [branch-name]`
6. Report: "Merged [branch] into main. Feature branch deleted."

**Option 2 — Push for PR:**
1. Push branch: `git push -u origin [branch-name]`
2. Create PR: `gh pr create --title "[title]" --body "[summary]"`
3. Report: "Branch pushed. PR created: [URL]"

**Option 3 — Keep branch:**
1. No action taken
2. Report: "Branch [name] kept as-is. No changes made."

**Option 4 — Discard:**
1. Confirm with user: "This will delete branch [name] and all uncommitted work. Type 'confirm' to proceed."
2. Wait for confirmation — do not proceed without it
3. Switch to main: `git checkout main`
4. Delete branch: `git branch -D [branch-name]`
5. Report: "Branch [name] deleted."

### Step 5: STOP — Confirm Completion

Present a structured summary:

```
---
**Ship complete.**

Action taken: [merge / push PR / keep / discard]
Branch: [branch-name]
Result: [specific outcome — e.g., "merged into main", "PR #42 created", "kept as-is", "deleted"]
Test suite: PASS ([N] tests)
---
```

**Next step (optional):** Run `/team-retro` to capture learnings from this feature's workflow.

The retro analyzes brief → design → review → plan → build → qa → ship artifacts to extract what worked, what was missed, and what should change. It takes 5-10 minutes and produces `docs/retros/<feature>/retro.md`.

## Red Flags

- Never ship with failing tests — no exceptions
- Never delete a branch without explicit user confirmation
- Never force-push without explicit user request and confirmation of consequences
- Never merge into main if the merge produces conflicts without user review
- Never auto-select an option — always wait for user choice

## Anti-Patterns (Do Not Do These)

- **Shipping without tests:** Skipping Step 1 because "tests passed earlier." Run them now.
- **Merging with uncommitted changes:** Uncommitted changes can end up in the merge. Commit or stash first.
- **Skipping /team-qa:** `/team-ship` is not a substitute for `/team-qa`. If `/team-qa` hasn't run, stop and run it.
- **Auto-merge:** Never merge without presenting options. The user decides how to ship.
- **Force-push as default:** Force-push overwrites remote history. Only do it when explicitly requested.

---

## Rollback

- **ship → build:** Pre-ship test suite fails (Step 1 gate). Go back to `/team-build` for targeted fixes.
- **ship → qa:** Post-merge tests fail (tests pass individually but fail after merge). Re-run `/team-qa` on merged files.
- **Merge conflicts:** Do not auto-resolve. Present conflicts to user for decision — conflicts may indicate design issues that need human judgment.

Rollback from /team-ship is rare — it means /team-qa missed something or the merge introduced issues. Log the cause for the `/team-retro`.

---

## Context Discipline

**READ:** CLAUDE.md (test command, branch conventions), git status, git log.
**WRITE:** Nothing — all actions are git operations via Bash.
**DO NOT READ:** Source code, specs, design documents. This skill operates on branches, not code.

## Model Tier

- **Opus** — destructive operations (branch deletion, merge) require careful judgment
- This skill is always invoked directly by the user, never delegated to builders
