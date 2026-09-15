# orchestrate source-of-truth contract

`plugins/orchestrate/skills/orchestrate/SKILL.md` is the canonical source.
`plugins/orchestrate-agents/skills/orchestrate/SKILL.md` is the generated Codex/OpenCode copy.

This pair is **skills-only** — the same shape as `plugins/concise`. `/orchestrate` is invoke-only:
you reach for it when you want one retained frontier sub-agent to own a task end to end, and
nothing reaches for it on your behalf.

Automatic delegation pressure was turned off fleet-wide, and the two mechanisms that created it
were deleted rather than relocated:

- `always-on.md` and its `SessionStart` hook — the standing directive that told every session to
  load this skill for substantial work.
- `hooks/guards/dispatch-first.ts` + `dispatch-first-core.ts`, registered on `PreToolUse` — the
  guard that warned and then BLOCKED a coordinator that read implementation source or ran checks
  before dispatching.

There is therefore no `hooks/` tree, no `hooks` field in `.claude-plugin/plugin.json` or
`.codex-plugin/plugin.json`, and no `always-on.md` on either side.
`scripts/check-plugin-boundaries.mjs` asserts each of those absences by name, because a file
reappearing here would restore the pressure silently — reading the skill would not reveal it.
`scripts/plugin-enablement.test.mjs` proves the same by resolving the composed session in both
enablement states and RUNNING every hook each one registers: with the plugin enabled, nothing gates
a coordinator's Read and the session receives no standing directive. It is mutation-checked.

`plugins/wwbd` still ships a standing directive, and it is the model for how one is delivered now:
the plugin's own `SessionStart` hook on each side cats the plugin's own `always-on.md`
(`${CLAUDE_PLUGIN_ROOT}` for Claude, `${PLUGIN_ROOT}` for Codex). Nothing outside a plugin delivers
a directive, and no host-specific file does it either.

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
this plugin, or removing the dispatch-first guard, must never remove a worker role or a safety
guard.
