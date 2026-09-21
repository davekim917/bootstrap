#!/usr/bin/env node
// Native v1 reports spawn_agent; default v2 reports collaborationspawn_agent.
// codex-rs rust-v0.154.0 tools/registry.rs:799-808, tools/mod.rs:40-54.
// Do not guess the dialect from model/version: require an explicit schema field.
import fs from 'node:fs';

const reason = 'Choose worker context explicitly using the exposed spawn_agent schema: fork_context: false (v1), or fork_turns: "none" (v2), for a new bounded worker. Supply its self-contained brief. Use full/partial inheritance only when the current user explicitly requested it; use the native field, since v1 silently ignores fork_turns. Partial inheritance requires a canonical positive decimal string such as "3". Never mix the two fields. Resume the same child for followups.';
function deny() {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
  } }));
}
try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.tool_name !== 'string') {
    throw new Error('Malformed hook event');
  }
  if (!['spawn_agent', 'collaborationspawn_agent'].includes(event.tool_name)) process.exit(0);
  const input = event.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) { deny(); process.exit(0); }
  const hasContext = Object.hasOwn(input, 'fork_context');
  const hasTurns = Object.hasOwn(input, 'fork_turns');
  if (hasContext === hasTurns) { deny(); process.exit(0); }
  if (hasContext) {
    if (typeof input.fork_context !== 'boolean') deny();
  } else {
    const turns = typeof input.fork_turns === 'string' ? input.fork_turns.trim().toLowerCase() : '';
    // Canonical positive decimal is intentionally narrower than native usize
    // parsing (+3/007); keep native none/all case and whitespace semantics.
    if (!['none', 'all'].includes(turns) && !/^[1-9][0-9]*$/.test(turns)) deny();
    else if (/^[1-9]/.test(turns) && BigInt(turns) > 18446744073709551615n) deny();
  }
} catch {
  // Exit 2 is native Codex's blocking hook error; never echo potentially private input.
  process.stderr.write('Cannot validate worker context: malformed spawn hook input.\n');
  process.exitCode = 2;
}
