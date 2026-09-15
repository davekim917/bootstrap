# workflow-agents source-of-truth contract

`plugins/workflow/skills/` is the canonical workflow source.
`plugins/workflow-agents/skills/` is the generated Codex/OpenCode distribution.

`orchestrate` is NOT in this inventory. It ships in its own plugin pair
(`plugins/orchestrate` / `plugins/orchestrate-agents`) so the operator can disable automatic
delegation pressure while these seven skills keep working; see `README.md`. The same generator
drives that pair, and it also generates that pair's copy of `shared/` from the canonical tree
below, because a plugin-relative path cannot cross a plugin boundary on an installed cache.

The user-facing inventory here is exactly:

- `team-plan`
- `team-build`
- `team-review`
- `team-auto`
- `team-debug`
- `team-ship`
- `team-retro`

The generator also mirrors these shared contracts byte-for-byte:

- `shared/workflow-contract.md`
- `shared/cross-model-review.md`
- `shared/references/CODEX-SOURCES.md`
- `shared/references/codex-adversarial-prompt.md`
- `shared/references/codex-review-output.schema.json`

Those same files are mirrored into `plugins/orchestrate/skills/shared/` and
`plugins/orchestrate-agents/skills/shared/`. Every copy is compared byte-for-byte against
`plugins/workflow/skills/shared/` by `evals/harness/parity-lint.mjs` and
`scripts/check-plugin-boundaries.mjs`.

All runtime dispatch belongs in concise runtime sections inside the canonical skill text. The
shared behavior stays runtime-neutral. The generator performs only schema/path substitutions; do
not hand-edit generated skills or add runtime-only workflow files.

After changing a canonical skill or shared contract, run:

```sh
node plugins/workflow-agents/scripts/sync-agent-skills.mjs
node plugins/workflow-agents/scripts/sync-agent-skills.mjs --check
```

`--check` verifies content and rejects unexpected files, so removed stages and obsolete references
cannot survive as generated-tree residue.

## What is generated and what is not

Generated from the Claude tree — regenerate, never hand-edit:

- `skills/**`
- `scripts/frontier-worker.mjs`
- `agents/worker-frontier.toml` (rendered from `plugins/workflow/agents/worker-frontier.md`)
- `hooks/guards/*-core.ts` (vendored by `scripts/vendor-guards.mjs`)

`dispatch-first-core.ts` is not vendored here. The guard it belonged to has been deleted outright:
automatic delegation pressure is off, and a gate that blocks a coordinator from reading source
before dispatching is exactly what an operator working directly must not hit. Do not re-add it.

Hand-maintained, because Codex has no counterpart in the Claude plugin — Claude auto-discovers
`agents/` from the plugin root, and Codex reads roles only from `<CODEX_HOME>/agents/`:

- `hooks/workflow-hooks.json` and `hooks/codex-guard.ts`
- `scripts/install-agent-roles.mjs`, `scripts/session-install-roles.mjs`, `scripts/ownership.mjs`
- `scripts/codex-agent-toml.mjs`, `scripts/sync-agent-skills.mjs`
- `.codex-plugin/plugin.json`, `marketplace-entry.json`, this file
