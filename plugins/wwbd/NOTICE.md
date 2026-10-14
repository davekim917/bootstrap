# Notice

The signs that a design is wrong, in the `wwbd` skill's "Two failed corrections"
default, are adapted from pstack's `architect` skill.

- Upstream repository: https://github.com/cursor/plugins
- Upstream path: `pstack/skills/architect/SKILL.md` (Phase E, "Scrap when the
  architecture is wrong")
- Upstream commit: `c86f349b102feb91f1966f8a6a60882a4e601b50`
- Copyright (c) 2026 Lauren Tan, licensed under the MIT License. The full
  license text is in [LICENSE-PSTACK](LICENSE-PSTACK), copied from the upstream
  `pstack/LICENSE` at that commit.

## Changes

Four of the upstream tells are kept: the same workaround shape in unrelated
code, types that need escape hatches, the "we need a lock" reflex, and callers
that must know the abstraction's internals. The tells about special-case
branches and deviations from an agreed sketch are left out, since this skill
has no sketch phase. The upstream redesign steps are reduced to one sentence,
without its references to other pstack skills.
