---
name: team-debug
description: Diagnose and fix bugs in Codex with root-cause tracing, evidence from source/logs/tests, and narrow verified changes.
---

# Team Debug

Use this skill when something fails, behaves unexpectedly, or produces conflicting signals.

Read `../shared/codex-workflow-primitives.md` and project instructions first.

## Debug Protocol

1. Reproduce or collect the exact failure signal.
2. Identify the real execution path from entrypoint to failing behavior.
3. Read implementation before naming a root cause.
4. Compare conflicting evidence streams side by side.
5. Patch the smallest source of truth that explains the failure.
6. Add or update a regression test when practical.
7. Verify the original failure path and at least one related edge path.

Do not infer behavior from function names, filenames, or architecture diagrams alone.

## Output

Return:

- Root cause with file references
- Fix summary
- Verification run
- Edge cases checked
- Any remaining uncertainty

If root cause is not proven, say what is known and what evidence is missing.
