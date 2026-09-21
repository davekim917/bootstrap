# Native Codex worker context

Use the spawn tool schema exposed in the current turn. History controls are tool arguments,
not TOML settings. Backend selection can vary with model metadata and feature overrides.

| Native schema | Fresh bounded worker | Explicit user-requested inheritance |
| --- | --- | --- |
| v1 | `fork_context: false` | `fork_context: true` |
| v2 | `fork_turns: "none"` | `fork_turns: "all"` or canonical positive integer string |

Do not mix fields. v1 silently ignores `fork_turns` and defaults fresh; v2 rejects
`fork_context` and defaults to all history when `fork_turns` is omitted. The guard blocks
omitted, null, blank, malformed and mixed controls before spawn. It accepts case/whitespace
around none/all, but deliberately rejects noncanonical numbers such as +3, 007 and 0.
Explicit valid controls pass unchanged. The guard cannot establish human intent from a tool
event, so the instruction requiring a current user request for inheritance remains policy.
It neither changes nor guarantees native model/effort/role behavior. Tagged rust-v0.154.0
source supports numeric partial inheritance and forbids v1 full history with an agent_type
override; those two semantics have not been separately probed on 0.155.1. Keep the same child for later rounds.

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
