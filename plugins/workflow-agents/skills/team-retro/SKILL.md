---
name: team-retro
description: Capture observed outcomes and one-week workflow measurements when requested.
---

# /team-retro — Capture evidence-backed learning

Read `../shared/workflow-contract.md` first. Run only when the user asks after shipping or a
deliberately stopped workflow.

Read `plan.md` and `run.md` when present, relevant git history, and observed outcome evidence. Produce
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

For the one-week trial, report accepted and stopped task counts, total measured usage per accepted
task (unknown where unavailable), elapsed time, repair rounds, escaped defects and human
interruptions with reasons. Separate observed outcomes from unmeasured savings hypotheses.
