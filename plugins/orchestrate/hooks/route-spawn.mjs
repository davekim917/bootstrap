#!/usr/bin/env node
// Claude Code PreToolUse hook on Agent/Task: settle every sub-agent spawn,
// autonomous or via /orchestrate. A model no human named is dropped so the spawn
// inherits its parent's, and the effort the call names stands, within the caps.
// Never blocks, never opens a connection. A named role is never rewritten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(path.join(here, '..', 'skills', 'orchestrate', 'scripts', 'dispatch-lib.mjs'));

try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  const input = event?.tool_input;
  if (!input || typeof input !== 'object' || !['Agent', 'Task'].includes(event.tool_name)) process.exit(0);
  const task = [input.description, input.prompt].filter((s) => typeof s === 'string').join('\n\n');
  // A named role keeps its installed model intent: no rewrite.
  const named = lib.isNamedRole(input.subagent_type);
  const contested = !named && (input.model || input.effort || !lib.isRoleless(input.subagent_type));
  const pins = contested ? lib.humanPins(input, lib.humanTurns(event.transcript_path).at(-1) ?? '') : undefined;
  const updated = lib.rewriteClaudeSpawn(input, pins);
  lib.logDispatch({
    source: 'spawn-hook',
    task: task.slice(0, 2000),
    before: { model: input.model ?? null, effort: input.effort ?? null, subagent_type: input.subagent_type ?? null },
    after: updated ? { model: updated.model ?? null, effort: updated.effort ?? null, subagent_type: updated.subagent_type ?? null } : null,
    ...(named ? { decision: 'named-role' } : {}),
    ...(pins ? { humanPins: pins } : {}),
  });
  if (updated) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } }));
  }
} catch {
  // The spawn proceeds unchanged.
}
