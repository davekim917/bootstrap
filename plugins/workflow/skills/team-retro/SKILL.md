---
name: team-retro
description: >
  Post-ship learning capture. Analyzes workflow artifacts from a completed feature to extract
  stage-by-stage findings, key learnings, and recommended updates to CLAUDE.md and skills.
  Use after /team-ship completes. User-invoked, suggested by /team-ship completion message.
  Do not use mid-workflow or before shipping.
version: 1.0.0
---

# /team-retro — Post-Ship Learning Capture

## What This Skill Does

Analyzes the artifacts from a completed feature's workflow to extract what worked, what was missed, and what should change in the process. Produces a structured retro document with actionable recommendations.

**Output:** `.context/retros/<feature>/retro.md`
**NOT output:** Code changes, skill rewrites, or CLAUDE.md edits (those are recommendations for the user to act on)

## Prerequisites

1. `/team-ship` has completed for this feature
2. `.context/specs/<feature>/` artifacts are accessible (brief.md, design.md, review.md, plan.md)

**If artifacts are missing:** Note what's missing and work with what's available. Partial retros are better than no retros.

## When to Use

- After `/team-ship` completes — suggested by /team-ship's completion message
- User-invoked via `/team-retro`
- Do NOT auto-trigger — the user decides when to reflect

## Process

### Step 1: Gather Artifacts

Read the following (skip any that don't exist):
- `.context/specs/<feature>/brief.md`
- `.context/specs/<feature>/design.md`
- `.context/specs/<feature>/review.md`
- `.context/specs/<feature>/plan.md`
- Drift reports (if any were generated during /team-build)
- `git log --oneline` for the feature branch

Note which artifacts exist and which are missing.

### Step 2: Stage-by-Stage Analysis

For each workflow stage, answer one specific question:

| Stage | Question |
|-------|----------|
| /team-brief | What requirements were missing or wrong that only surfaced later? |
| /team-design | What assumptions were invalidated? What options should have been considered? |
| /team-review | What issues reached build/QA that review should have caught? Were MUST-FIX classifications accurate? |
| /team-plan | What was under-specified enough that builders had to guess? Were task boundaries correct? |
| /team-build | What blockers occurred? How many fix cycles? Were escalations needed? Did drift checks catch real issues? |
| /team-qa | What MUST-FIX items were found? Could they have been caught earlier? Were false positives excessive? |
| /team-drift | (If used) Did pre-build and post-build drift checks catch real fidelity issues? Did they miss any that QA or manual review found? |

For each answer, cite the specific artifact evidence. "Review missed X" must point to the review.md finding list showing X was absent.

### Step 3: Extract Key Learnings

Distill 3-5 key learnings. Format:

> "Next time, [specific action] because [specific evidence from this feature]."

Each learning must be tied to a specific finding from Step 2. No generic advice ("communicate better", "test more").

### Step 4: Flag for Updates

Identify specific updates to project infrastructure:

- **CLAUDE.md:** Which section, what change, why (cite the finding)
- **Workflow skills:** Which skill, which section, what change (cite the finding)
- **Project skills:** Which skill, what's missing or wrong (cite the finding)

Be concrete: "Add to CLAUDE.md § Critical Guardrails: 'Always validate X before Y' — because /team-build Task B3 failed twice due to missing validation (see plan.md Task B3 acceptance criteria)."

### Step 5: Save and Present

Using `references/retro-template.md`, write the retro document.

1. `mkdir -p .context/retros/<feature>/`
2. Write to `.context/retros/<feature>/retro.md`

Present the summary to the user with the save path.

## Anti-Patterns

- **"Everything went great"** is not a retro. If nothing was missed, nothing was learned. Dig deeper.
- **Retroactive justification.** Don't explain why missed things were actually fine. If they were caught late, the process missed them.
- **Generating without evidence.** Every finding must cite a specific artifact. No "I think we should have..." without pointing to what went wrong.
- **Proposing changes without tying to findings.** Every recommendation must link to a specific retro finding. No aspirational improvements.

## Context Discipline

**READ:**
- `.context/specs/<feature>/*` — all workflow artifacts
- Drift reports (if any)
- Git log for the feature branch
- `CLAUDE.md` — to understand what rules exist that may need updating

**DO NOT READ:**
- Implementation artifacts (source code, SQL models, notebooks, pipeline configs, DAG definitions)
- The retro is about the process, not the implementation

**Rationale:** The retro evaluates whether the workflow stages did their jobs. Reading implementation details biases toward implementation critique, which is /team-qa's job — not /team-retro's.

## Model Tier

**Tier:** Opus (current session)
**Rationale:** Learning extraction requires judgment — identifying what matters vs. what's noise, connecting findings to actionable changes, and being honest about process failures.
