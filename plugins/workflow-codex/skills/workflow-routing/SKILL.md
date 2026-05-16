---
name: workflow-routing
description: Route a Codex request to the right bootstrap workflow skill when the user asks for team workflow help, feature delivery, planning, review, QA, drift checks, shipping, or autonomous execution.
---

# Workflow Routing

Use this skill when the user asks for workflow guidance but does not name a specific team skill.

Read `../shared/codex-workflow-primitives.md` when you need shared Codex conventions.

## Route

- Fuzzy idea or unclear ask: use `team-brief`.
- Need architecture, UX, product, or technical design: use `team-design`.
- Need adversarial critique before planning or building: use `team-review`.
- Need a buildable task list: use `team-plan`.
- Need implementation: use `team-build`.
- Need validation of a diff or finished implementation: use `team-qa`.
- Need branch, commit, PR, or release prep: use `team-ship`.
- Need test-first implementation: use `team-tdd`.
- Need root-cause debugging: use `team-debug`.
- Need compare artifacts for drift: use `team-drift`.
- Need process learning after work: use `team-retro`.
- Need to process review comments: use `team-receiving-review-feedback`.
- Need an evidence gate before a completion claim: use `team-verification-before-completion`.
- Need end-to-end autonomous delivery: use `team-auto`.

When multiple routes apply, start at the earliest missing artifact in this order:

`brief -> design -> review -> plan -> build -> qa -> ship`

For small, clear fixes, skip directly to `team-build` or `team-debug`.
