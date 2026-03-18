# Subagent Build Path (Path B)

## When to Use

Path B applies when ALL of the following are true:
- 3 or fewer task groups in the plan
- No cross-group dependencies (all groups are independent)
- No shared interface contracts between groups

If any condition is false, use Path A (team-coordinated).

## How It Works

Path B executes groups sequentially in the same session using subagents, rather than creating a full team. The lead spawns one subagent per group, waits for completion, validates, then moves to the next.

### Execution Flow

For each task group (in dependency order, or any order if all independent):

**Stage 1: Implementation**
```
Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  prompt: [builder prompt from references/builder-prompt-template.md]
)
```

Wait for completion. Read all files produced.

**Stage 2: Spec Compliance Review**
Re-read the original task spec from the plan for this group.
For each task in the group:
1. Check each acceptance criterion by name — not a general impression.
2. For each `ASSERT:` annotation in the task spec: verify the stated condition holds.
   (ASSERT checks are active only for tasks written in the contracts format.
    Tasks without ASSERT lines fall back to the general criteria check.)
3. Verify each file listed in the spec was created or modified.
4. Verify no unspecified files were created or modified (over-building check).

Report: ✅ all criteria met, or ❌ list of unmet criteria by task + criterion name.
Unmet criteria → spawn a fix subagent (same model, targeted prompt). 3-iteration retry limit.

**Stage 3: Quality Review**
After spec compliance clears:
- Well-structured? Follows CLAUDE.md conventions?
- Obvious performance issues? Hardcoded values?
- Error handling at boundaries?

MUST-FIX → fix subagent. SHOULD-FIX → logged for /team-qa.

### Verification Gates

Same gates as Path A — no relaxation:
- Pre-build drift check (Step 2 in main SKILL.md)
- Per-group validation (all acceptance criteria verified by lead)
- Two-stage review (spec compliance + quality)
- Post-build drift check (Step 7 in main SKILL.md)
- Verification-before-completion protocol

### Retry Limits

Same as Path A:
- 3 failed attempts per acceptance criterion → escalate to user
- 3 drift fix cycles → escalate to user

### Fallback to Path A

If during Path B execution:
- A cross-group issue emerges (file conflict, interface mismatch)
- A group is too complex for a single subagent pass
- Fix iterations exceed limits on multiple groups

Switch to Path A: create the team, register remaining groups as tasks, spawn builders. Work already completed by Path B subagents is preserved.

## Advantages of Path B

- Lower overhead: no team creation, no shutdown protocol, no message passing
- Simpler coordination: lead directly validates each group before moving on
- Better for small builds: 1-3 independent groups don't need team infrastructure

## Advantages of Path A (Why Not Always Use Path B)

- Parallelism: Path A runs independent groups simultaneously
- Isolation: each builder has its own context window
- Scale: Path A handles 4+ groups and complex dependencies
- Coordination: message-based communication for real-time unblocking
