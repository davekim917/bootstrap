#!/usr/bin/env node
// Claude Code PreToolUse hook on Agent/Task: route every sub-agent spawn —
// autonomous or via /orchestrate — through the dispatch rubric. Fills the model
// (and, for a roleless spawn, the effort) the call left out; never blocks. A named
// role keeps the model its own definition pins. Any classifier failure or
// abstention adds no model or effort; existing caps remain.
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
  const type = input.subagent_type;
  const named = !lib.isRoleless(type) && !lib.isShim(type);
  // A named role's own definition decides whether its model is open to a pick.
  const role = named && !input.model
    ? lib.roleModelIntent(type, { cwd: typeof event.cwd === 'string' ? event.cwd : process.cwd() })
    : null;
  // Only ask when something the picker may fill is missing: an explicit model +
  // shim needs caps alone, and a role that keeps its installed model needs nothing.
  const needsPick = named ? Boolean(role?.fillable) : !input.model || lib.isRoleless(type);
  const picked = needsPick
    ? lib.resolveDispatch(await lib.pick(task, 'claude', { timeoutMs: 3000, rubric }), 'claude')
    : null;
  const updated = lib.rewriteClaudeSpawn(input, picked, rubric, { roleFillable: Boolean(role?.fillable) });
  lib.logDispatch({
    source: 'spawn-hook',
    task: task.slice(0, 2000),
    before: { model: input.model ?? null, subagent_type: input.subagent_type ?? null },
    after: updated ? { model: updated.model ?? null, subagent_type: updated.subagent_type ?? null } : null,
    ...(role ? { role } : {}),
    ...(picked ?? { decision: role ? 'role-intent' : 'explicit' }),
  });
  if (updated) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } }));
  }
} catch {
  // Fail open: the spawn proceeds unchanged.
}
