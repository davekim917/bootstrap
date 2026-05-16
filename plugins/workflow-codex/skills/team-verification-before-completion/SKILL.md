---
name: team-verification-before-completion
description: Enforce evidence-based Codex completion claims by checking tests, builds, logs, diffs, edge cases, and unverified risk before saying work is done.
---

# Team Verification Before Completion

Use this skill before claiming any non-trivial task is complete.

Read `../shared/codex-workflow-primitives.md` if you need the shared completion protocol.

## Gate

Before saying "done", "fixed", "updated", "working", or equivalent:

1. Inspect the final diff or artifact.
2. Run the most relevant available automated checks.
3. Check at least one non-happy-path case when behavior changed.
4. Confirm no unrelated user changes were reverted.
5. Identify any verification you could not run.

## Completion Statement

Include:

- What changed
- What was verified, with commands or inspections
- Edge cases checked
- What remains unverified

If no verification was possible, do not soften it. Say exactly why.
