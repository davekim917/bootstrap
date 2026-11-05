# Notice

Two passages in this plugin's skills are adapted from pstack, and one from make-native.

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

## make-native

- Upstream repository: https://github.com/Sloydai/make-native
- Upstream path: `skills/make-native/SKILL.md`
- Upstream commit: `f7df61dc1f257cde400f0d2533b774a97a34be3e`
- Copyright (c) 2026 Sloyd, licensed under the MIT License. The full license
  text is in [LICENSE-MAKE-NATIVE](LICENSE-MAKE-NATIVE), copied from the
  upstream `LICENSE` at that commit.
- The **Bolted-on** item in `skills/shared/cross-model-review.md` takes its
  question (would the code look like this had the feature been in the original
  design?) and its list of bolt-on smells, each cut to one line. Upstream is a
  skill that rewrites the code; here they are review prompts, and a finding must
  name the existing helper, type or system to fold into.
