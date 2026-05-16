---
name: team-ship
description: Prepare Codex-completed work for handoff, commit, pull request, or release with verified status, risk notes, and exact remaining actions.
---

# Team Ship

Use this skill when work is built and QA has run, or when the user asks to commit, push, open a PR, or prepare release notes.

Read `../shared/codex-workflow-primitives.md`, project instructions, the final diff, and any QA artifact.

## Ship Checklist

1. Confirm `git status --short`.
2. Review the diff for unrelated changes.
3. Confirm tests, builds, or manual checks that passed.
4. Identify unverified risk.
5. Prepare a concise summary of user-visible and technical changes.
6. Commit, push, or open a PR only when the user asked for that operation or the current request clearly includes it.

Do not include memory citations or internal analysis in PR text.

## Output

Return:

- Changed files summary
- Verification evidence
- Edge cases checked
- Known residual risk
- Branch, commit, or PR details if created

If shipping is blocked, state the blocker and the smallest next action.
