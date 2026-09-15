# workflow-agents source-of-truth contract

`plugins/workflow/skills/` is the canonical workflow source.
`plugins/workflow-agents/skills/` is the generated Codex/OpenCode distribution.

The user-facing inventory is exactly:

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

Hand-maintained, because Codex has no counterpart in the Claude plugin — Claude auto-discovers
`agents/` from the plugin root, and Codex reads roles only from `<CODEX_HOME>/agents/`:

- `hooks/workflow-hooks.json` and `hooks/codex-guard.ts`
- `scripts/install-agent-roles.mjs`, `scripts/session-install-roles.mjs`, `scripts/ownership.mjs`
- `scripts/codex-agent-toml.mjs`, `scripts/sync-agent-skills.mjs`
- `.codex-plugin/plugin.json`, `marketplace-entry.json`, this file
