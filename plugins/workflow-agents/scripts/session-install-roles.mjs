#!/usr/bin/env node
/**
 * SessionStart hook entry: make this plugin's Codex roles dispatchable without
 * a manual step.
 *
 * Why this file exists at all. A Codex plugin can ship skills, MCP servers,
 * browser extensions and hooks — not agents. Codex reads named roles only from
 * `<CODEX_HOME>/agents/<name>.toml`, so `agents/worker-frontier.toml` shipping
 * inside the plugin is inert until something copies it there. Before this hook,
 * the only thing that copied it was `install-agent-roles.mjs --apply`, which
 * nothing invoked: installing the plugin and running `/orchestrate` produced a
 * dispatch to a role that did not exist.
 *
 * Why SessionStart and not the skill text or the PreToolUse guard. Codex fires
 * plugin-declared `SessionStart` hooks before the first turn (verified against
 * codex-cli 0.154.0), which is exactly when the role has to be on disk. The
 * skill preamble would only be an instruction the model may or may not act on,
 * and it arrives inside the dispatch it is meant to enable. The PreToolUse
 * guard runs on the latency path of every tool call and, again, only after a
 * dispatch has already been attempted.
 *
 * The contract this file owes the session:
 *
 *   - Silent on the happy path. Nothing on stdout, nothing on stderr. An
 *     already-current role writes nothing at all — `install` reads the two
 *     files, sees `unchanged`, and returns.
 *   - Always exit 0. A read-only filesystem, an unwritable `agents/` directory,
 *     a role owned by another manager (NanoClaw's `# managed by nanoclaw
 *     codex-sync` owns this exact filename on a NanoClaw host) and an outright
 *     crash all end the same way: the session starts. A hook that can fail a
 *     session is worse than a missing role.
 *   - No weakening of ownership. This is a thin wrapper, not a second
 *     implementation: every write goes through `install-agent-roles.mjs`, which
 *     keeps its marker check, `wx` exclusive create with EEXIST re-check,
 *     same-directory temp + rename, and bounded retry. Refusals are swallowed
 *     here rather than printed — on a NanoClaw host the refusal is the correct
 *     steady state, and reporting it every session would be permanent noise.
 *     `install-agent-roles.mjs` run by hand still reports refusals and exits 1.
 *
 * A non-default `CODEX_HOME` needs no special handling here, and both halves
 * were checked against codex-cli 0.154.0: when it is set, Codex passes it
 * through to the hook's environment (a probe hook printed it back), and when it
 * is not, Codex is itself using `~/.codex`. `install-agent-roles.mjs` resolves
 * exactly that way — `process.env.CODEX_HOME`, else `~/.codex`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { install } from './install-agent-roles.mjs';

export function run() {
  try {
    install({ apply: true });
  } catch {
    // Deliberately swallowed. Nothing this hook can discover is worth a failed
    // session start, and every diagnosable case is reproducible on demand with
    // `node scripts/install-agent-roles.mjs`.
  }
}

// Script-only, like every other module here. Doing the work at import time
// would write to a real CODEX_HOME merely because something loaded the file,
// and the `process.exit(0)` below would take its importer's process down with
// it — silently, at exit code 0. The packaging test imports every shipped
// module, so that is not hypothetical: it would have reported a pass while
// skipping whatever came after.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  run();
  // Explicit: the exit code is the contract with Codex, and it is always 0.
  process.exit(0);
}
