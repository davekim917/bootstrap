# Native Codex worker context

Use the spawn tool schema exposed in the current turn. History controls are tool arguments,
not TOML settings. Backend selection can vary with model metadata and feature overrides.

| Native schema | The only accepted control |
| --- | --- |
| v1 | `fork_context: false` |
| v2 | `fork_turns: "none"` |

Do not mix fields. v1 silently ignores `fork_turns` and defaults fresh; v2 rejects
`fork_context` and defaults to all history when `fork_turns` is omitted. The guard blocks
every spawn that inherits history (`fork_context: true`, `fork_turns: "all"` or a turn count)
as well as omitted, null, blank, malformed and mixed controls. It accepts case and whitespace
around `none`. The fresh control passes unchanged. It neither changes nor guarantees native
model/effort/role behavior. Keep the same child for later rounds.

## Coverage and activation

The deny-only PreToolUse hook matches `spawn_agent` (v1/un-namespaced) and
`collaborationspawn_agent` (v2's default namespace). It does not inspect transcripts,
credentials or model catalogs, rewrite arguments, or grant permission. Other tools are
ignored. Custom v2 namespaces require their own verified matcher; separate thread-fork,
app-server and extension APIs are outside this guard. Followup/resume is not a new spawn.

An installed file is not proof of activation: verify that Codex loads the exact hook as
trusted and that an omitted control is blocked before a child starts, with an explicit
fresh spawn as positive control. Native hook trust failures can skip hooks. Do not bypass
trust or permission controls. Existing sessions may need a normal fresh session to load
new plugin bytes; installation alone is not runtime evidence.

Native behavior is grounded in codex-rs tag rust-v0.154.0:
`core/src/tools/handlers/multi_agents/spawn.rs:224-233`,
`core/src/tools/handlers/multi_agents_v2/spawn.rs:277-328`,
`core/src/config/mod.rs:1544-1570`,
`core/src/tools/spec_plan.rs:1456-1528`, `core/src/tools/mod.rs:40-54`, and
`core/src/tools/registry.rs:799-808`.
[Official hook contract](https://learn.chatgpt.com/docs/hooks) describes the local function
PreToolUse path, deny output and trust requirements. Recheck runtime names on CLI upgrades.
