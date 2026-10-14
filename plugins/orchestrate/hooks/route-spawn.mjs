#!/usr/bin/env node
// Claude Code PreToolUse hook on Agent/Task: route every sub-agent spawn —
// autonomous or via /orchestrate — through the dispatch rubric. A confident pick
// replaces the model and effort the calling agent named itself; a field a human
// asked for in this session is kept. Never blocks. A named role is never
// rewritten and never costs a picker call. Any classifier failure or abstention
// leaves the call's own choices; existing caps remain.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(path.join(here, '..', 'skills', 'orchestrate', 'scripts', 'dispatch-lib.mjs'));

try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  const input = event?.tool_input;
  if (!input || typeof input !== 'object' || !['Agent', 'Task'].includes(event.tool_name)) process.exit(0);
  const rubric = lib.loadRubric();
  if (rubric.mode !== 'active') process.exit(0);
  const task = [input.description, input.prompt].filter((s) => typeof s === 'string').join('\n\n');
  // A named role keeps its installed model intent: no pick, no rewrite.
  const named = lib.isNamedRole(input.subagent_type);
  const picked = named ? null : lib.resolveDispatch(await lib.pick(task, 'claude', { timeoutMs: 3000, rubric }), 'claude');
  const contested = picked?.decision === 'route' && (input.model || !lib.isRoleless(input.subagent_type));
  const pins = contested ? lib.humanPins(input, lib.humanText(event.transcript_path)) : undefined;
  const updated = lib.rewriteClaudeSpawn(input, picked, rubric, pins);
  lib.logDispatch({
    source: 'spawn-hook',
    task: task.slice(0, 2000),
    before: { model: input.model ?? null, subagent_type: input.subagent_type ?? null },
    after: updated ? { model: updated.model ?? null, subagent_type: updated.subagent_type ?? null } : null,
    ...(picked ?? { decision: 'named-role' }),
    ...(pins ? { humanPins: pins } : {}),
  });
  if (updated) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } }));
  }
} catch {
  // Fail open: the spawn proceeds unchanged.
}
