#!/usr/bin/env node
// Native v1 reports spawn_agent; default v2 reports collaborationspawn_agent.
// codex-rs rust-v0.154.0 tools/registry.rs:799-808, tools/mod.rs:40-54.
// Do not guess the dialect from model/version: require an explicit schema field.
import fs from 'node:fs';

const reason = 'Spawn a fresh-context worker using the exposed spawn_agent schema: fork_context: false (v1), or fork_turns: "none" (v2). Workers never inherit this conversation: put everything they need in a self-contained brief. Never mix the two fields. Resume the same child for followups.';
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
  const fresh = hasContext
    ? input.fork_context === false
    : typeof input.fork_turns === 'string' && input.fork_turns.trim().toLowerCase() === 'none';
  if (!fresh) deny();
} catch {
  // Exit 2 is native Codex's blocking hook error; never echo potentially private input.
  process.stderr.write('Cannot validate worker context: malformed spawn hook input.\n');
  process.exitCode = 2;
}
