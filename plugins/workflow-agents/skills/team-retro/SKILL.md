---
name: team-retro
description: >
  Optional short post-ship learning capture. Uses plan.md, run.md, git, and outcome evidence to
  identify a few specific process or project improvements; never auto-triggers or edits policy.
---

# /team-retro — Capture evidence-backed learning

Read `../shared/workflow-contract.md` first. Run only when the user asks after shipping or a
deliberately stopped workflow.

Read `plan.md`, `run.md`, relevant git history, and observed outcome evidence. Produce
`docs/retros/<feature>/retro.md` containing:

1. the intended outcome and actual result;
2. what worked, with evidence;
3. what caused rework, escaped review, or added needless ceremony, with evidence;
4. up to five specific learnings in the form “Next time, do X because Y occurred”;
5. narrowly scoped recommendations for project instructions, workflow skills, tests, or tooling.

Distinguish product/code failures from workflow-created obstruction. Do not recommend more process
unless repetition, scale, risk, or failure impact demonstrates that it pays for itself. Do not edit
skills, policy, or project instructions during the retro; present recommendations for a separate
decision.
