#!/usr/bin/env node
// Claude Code PreToolUse hook on Agent/Task: route every sub-agent spawn —
// autonomous or via /orchestrate — through the dispatch rubric. Fills the model
// (and, for a roleless spawn, the effort) the call left out; never blocks. Any
// classifier failure or abstention uses the bounded Opus/high fallback.
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
  // Only ask when something is missing; an explicit model + shim needs caps alone.
  const needsPick = !input.model || !input.subagent_type || input.subagent_type === 'general-purpose';
  const picked = needsPick
    ? lib.resolveDispatch(await lib.pick(task, 'claude', { timeoutMs: 3000, rubric }), 'claude')
    : null;
  const updated = lib.rewriteClaudeSpawn(input, picked, rubric);
  lib.logDispatch({
    source: 'spawn-hook',
    task: task.slice(0, 2000),
    before: { model: input.model ?? null, subagent_type: input.subagent_type ?? null },
    after: updated ? { model: updated.model ?? null, subagent_type: updated.subagent_type ?? null } : null,
    ...(picked ?? { decision: 'explicit' }),
  });
  if (updated) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } }));
  }
} catch {
  // Fail open: the spawn proceeds unchanged.
}
