# Notice

The `create-verification-skill` and `maintain-verification-skill` skills in
this plugin, and the feature-map example under
`skills/create-verification-skill/references/feature-map-example/`, are adapted
from pstack's skills of the same names.

- Upstream repository: https://github.com/cursor/plugins
- Upstream path: `pstack/skills/create-verification-skill/` and
  `pstack/skills/maintain-verification-skill/`
- Upstream commit: `c86f349b102feb91f1966f8a6a60882a4e601b50`
- Copyright (c) 2026 Lauren Tan, licensed under the MIT License. The full
  license text is in [LICENSE-PSTACK](LICENSE-PSTACK), copied from the
  upstream `pstack/LICENSE` at that commit.

## Changes

This is an adapted version, not a copy. It keeps the upstream interview,
launch/doctor/drive/evidence/cleanup/helpers sections, the feature map and its
four-section entry contract, the prove-it-once rule, and the maintenance pass
with its three live-pass invariants. It removes the Cursor-specific skill path
and the requirement to ship corrections as a pull request. In their place a
generated skill is created private, written where every runtime of the
installing environment can read it (a NanoClaw workgroup tree, or a host's
shared skill directories), and bound to its project by remote URL;
maintenance writes proven corrections and a pass record back to that
location. Moving a skill into the project repository is a separate step taken
only on the user's explicit request, after which upstream's pull-request
route applies to that copy and the private one is retired. Evidence records
the revision, action, result, side effects, mocks and gaps of each run, an
unreachable feature never counts as passed, and an expected result is never
rewritten to match a regression. A stack reference adds dbt/Snowflake (build
against a development target and assert on its data, never production), web
app, CLI and service recipes. Both skills are invoke-only and work on Claude,
Codex and OpenCode.
