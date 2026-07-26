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
