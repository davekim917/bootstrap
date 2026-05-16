---
name: team-auto
description: Run the Codex workflow autonomously across brief, design, review, plan, build, QA, and ship-prep while preserving user decision points for risky or irreversible actions.
---

# Team Auto

Use this skill only when the user explicitly asks for autonomous workflow execution or clearly asks Codex to take the work end to end.

Read `../shared/codex-workflow-primitives.md` and current project instructions before starting.

## Autonomy Boundaries

Proceed without asking when the next step is local, reversible, and inferable from project context. Pause for the user when:

- Product behavior or scope is genuinely ambiguous
- A destructive operation is needed
- External credentials, billing, deployment, or production data are involved
- The next step would publish, merge, or release work without prior approval

## Loop

1. Brief: create or refresh requirements if unclear.
2. Design: choose and document the approach.
3. Review: run adversarial review and accept/reject findings.
4. Plan: produce buildable tasks.
5. Build: implement with subagents only for separable work.
6. QA: run structured validation.
7. Ship prep: summarize, verify, and prepare commit or PR only when requested.
8. Retro: capture reusable lessons when the work was meaningful.

Use artifact paths under `docs/specs/<slug>/` so another Codex session can resume.

## Status Updates

Keep the user informed with concise progress updates. Do not bury blockers. If verification fails, stop and debug rather than pushing forward on a broken state.
