# workflow-agents source-of-truth contract

`plugins/workflow/skills/` is the canonical workflow source.
`plugins/workflow-agents/skills/` is the generated Codex/OpenCode distribution.

`orchestrate` is NOT in this inventory. It ships in its own plugin (`plugins/orchestrate`, one
directory with both manifests) so the operator can disable delegation while these seven skills keep
working; see `README.md`. Nothing about that plugin is generated: it is a skill plus five effort
shims, with no code and no copied contract.

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

The copy here is compared byte-for-byte against `plugins/workflow/skills/shared/` by
`evals/harness/parity-lint.mjs` and `scripts/check-plugin-boundaries.mjs`.

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
- `hooks/guards/*-core.ts` (vendored by `scripts/vendor-guards.mjs`)

There is no `agents/` directory here any more. Codex reads named roles only from
`<CODEX_HOME>/agents/<name>.toml`, so shipping a role meant generating a TOML and copying it into
the user's home from a `SessionStart` hook. `/orchestrate` names a model and an effort per dispatch
instead of naming a role, so the role, its generator, its installer, its `SessionStart` hook and the
`worker-policy.json` that rendered its model all went together. `scripts/check-plugin-boundaries.mjs`
asserts each of them stays gone, and that this plugin declares `PreToolUse` and nothing else.

`dispatch-first-core.ts` is not vendored here. The guard it belonged to has been deleted outright:
automatic delegation pressure is off, and a gate that blocks a coordinator from reading source
before dispatching is exactly what an operator working directly must not hit. Do not re-add it.

Hand-maintained, because the Claude plugin has no counterpart to generate them from:

- `hooks/workflow-hooks.json` and `hooks/codex-guard.ts` — Codex's hook manifest resolves
  `${PLUGIN_ROOT}`, not `${CLAUDE_PLUGIN_ROOT}`, so the two manifests cannot be one file.
- `scripts/ownership.mjs` — the ownership marker, kept only so
  `scripts/retire-bootstrap-agents.mjs` can recognise role files this plugin wrote into users'
  Codex homes before 5.7.0. Nothing writes one now. The string is frozen: rewording it orphans
  every file already carrying it.
- `scripts/sync-agent-skills.mjs` — the generator itself.
- `.codex-plugin/plugin.json`, `marketplace-entry.json`, this file.
