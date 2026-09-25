# Notice

The `test-audit` skill in this plugin is adapted from OpenClaw's `test-audit` skill.

- Upstream repository: https://github.com/openclaw/openclaw
- Upstream path: `.agents/skills/test-audit/` (`SKILL.md` and `CAMPAIGN.md`)
- Upstream commit: `80930af448ebabc84174146b56bc106d37fab3b4`
- Copyright (c) 2026 OpenClaw Foundation, licensed under the MIT License. The
  full license text is in [LICENSE-OPENCLAW](LICENSE-OPENCLAW), copied from the
  upstream `LICENSE` at that commit.

## Changes

This is an adapted version, not a copy. It keeps the upstream authoring gate,
junk patterns, retention bar, candidate evidence record, preservation review,
and the rule that a regression test must fail on the pre-fix code. It removes
every upstream-specific command, script, and path so it works in any stack,
and adds stack notes for TypeScript/vitest, Bun, Python/pytest, and dbt. The
goal changes from pruning to completeness: every test in a bounded scope is
classified with evidence, and anything that can't be read with confidence is
unknown rather than safe. Test-only seams that make tests safer, such as
controlled clocks and injected dependencies, are allowed. Containment of
external side effects comes before pruning. A duplicate is deleted only after
the remaining test catches a representative fault, and existing coverage
floors are never lowered. The campaign workflow drops a fixed one-agent-per-lane
split, whole-subsystem single PRs, shrink-only line caps, automatic retention of
deletions when main moves, and acceptance of truncated inventories. In their
place it uses bounded PRs, complete evidence, and fresh decisions whenever main
changes a classified file.
