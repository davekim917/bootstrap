# Notice

Parts of the `anderton` skill are adapted from pstack's skills.

- Upstream repository: https://github.com/cursor/plugins
- Upstream paths: `pstack/skills/correct/SKILL.md` (the order of fixes in
  section 4 of `SKILL.md`), `pstack/skills/architect/SKILL.md` (the design red
  flags in `references/good-code.md`), and the `pstack/skills/principle-*`
  skills named in `references/sources.md`
- Upstream commit: `1b6d44ff26d4e242f4e8f68c391e6d2f7ca16def`
- Copyright (c) 2026 Lauren Tan, licensed under the MIT License. The full
  license text is in [LICENSE-PSTACK](LICENSE-PSTACK), copied from the upstream
  `pstack/LICENSE` at that commit.

## Changes

The opening of `references/good-code.md` keeps the upstream `correct` skill's
description of the contributor (an agent that sees only the files it opened)
nearly word for word. The ladder of fixes (make it impossible, make the
compiler reject it, make CI reject it, test it, then write a rule) and the
requirement to prove a new check against the real past mistake are restated in
this skill's words, without the upstream rule table. The engineering bar in
`references/good-code.md` condenses the named principles into one page and adds
a backend-foundation section drawn from the other sources listed there.
