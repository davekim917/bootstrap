# orchestrate source-of-truth contract

`plugins/orchestrate/skills/orchestrate/SKILL.md` is the canonical source.
`plugins/orchestrate-agents/skills/orchestrate/SKILL.md` is the generated Codex/OpenCode copy.

This pair exists so **automatic delegation pressure can be disabled on its own**. Three things
create that pressure, and all three ship here:

1. `skills/orchestrate/SKILL.md` — the skill itself.
2. `always-on.md` — the standing directive, delivered to Claude by this plugin's `SessionStart`
   hook and to every other provider through the repo-root `.nanoclaw-always-on.md`, which
   `scripts/check-plugin-boundaries.mjs` regenerates as this file plus `plugins/wwbd/always-on.md`.
3. `hooks/guards/dispatch-first.ts` + `dispatch-first-core.ts`, registered on `PreToolUse` in
   `hooks/orchestrate-hooks.json` — the guard that warns and then blocks a coordinator that reads
   implementation source or runs checks before dispatching.

Disable the plugin and none of the three reach the session. `scripts/plugin-enablement.test.mjs`
proves that by resolving the composed session in both states and RUNNING the hooks each one
registers; it is mutation-checked, so putting any of the three back in `bootstrap-workflow` fails.

## Generated here — regenerate, never hand-edit

- `skills/shared/**` — copied from the canonical `plugins/workflow/skills/shared/`. `/orchestrate`
  opens with "Read `../shared/workflow-contract.md` first", and that contract is shared with the
  seven `team-*` skills. A relative path cannot leave a plugin: an installed marketplace cache
  materializes only the plugin's own subtree, so pointing at `plugins/workflow` would resolve in a
  checkout and be missing on every real install — silently, degrading the skill to whatever the
  model remembers. Each plugin carries its own copy instead, and the byte-identity gates in
  `evals/harness/parity-lint.mjs` and `scripts/check-plugin-boundaries.mjs` pay the drift cost.
- `scripts/frontier-worker.mjs` — copied from `plugins/workflow/scripts/frontier-worker.mjs` for
  the same reason: the skill names it as `../../scripts/frontier-worker.mjs`.

```sh
node plugins/workflow-agents/scripts/sync-agent-skills.mjs
node plugins/workflow-agents/scripts/sync-agent-skills.mjs --check
```

## Stays in bootstrap-workflow

The seven `team-*` skills, the canonical `skills/shared/`, `agents/worker-frontier.md` and its
generated Codex TOML, and every safety guard (`block-destructive`, `file-protection`, `email-gate`,
`block-askuser-during-auto`, `opencode-guard`). `/orchestrate` dispatches to that worker; disabling
this plugin must never remove a worker role or a safety guard.
