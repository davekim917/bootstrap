# Notice

Two passages in this plugin's skills are adapted from pstack.

- Upstream repository: https://github.com/cursor/plugins
- Upstream paths: `pstack/skills/architect/references/design-red-flags.md` and
  `pstack/skills/architect/references/runner-prompt.md`
- Upstream commit: `c86f349b102feb91f1966f8a6a60882a4e601b50`
- Copyright (c) 2026 Lauren Tan, licensed under the MIT License. The full
  license text is in [LICENSE-PSTACK](LICENSE-PSTACK), copied from the upstream
  `pstack/LICENSE` at that commit.

## Changes

- The **Design** item in `skills/shared/cross-model-review.md` takes the eight
  red flags (split ownership, two ways to do one task, pass-through, shallow
  module, information leakage, temporal decomposition, importable internals,
  hand-synced list), each cut to one line. Upstream screens a candidate design
  with them and treats a flag as a reason to revise or reject it. Here they are
  review prompts, not defects: a finding must name a plausible next change the
  shape makes costly or wrong and the boundary that should change. The rule that
  an importable internal or hand-synced list gets a lint rule or derive-test,
  not a note, is added here and is not upstream.
- `team-plan` takes the "caller's usage first" rule from the runner prompt, in
  one sentence, limited to consequential new or changed APIs.
