#!/usr/bin/env node
// Claude Code PreToolUse hook on Agent/Task: settle every sub-agent spawn,
// autonomous or via /orchestrate. A model no human named is dropped so the spawn
// runs on CLAUDE_CODE_SUBAGENT_MODEL, else its parent's, and the agent and the sub-agent are told which model runs.
// The effort the call names stands, within the cap of the model that will run; a call that names none gets one.
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
  const turn = contested || (!named && !input.effort) ? lib.humanTurns(event.transcript_path).at(-1) ?? '' : '';
  const pins = contested ? lib.humanPins(input, turn) : undefined;
  const parentEffort = typeof event.effort?.level === 'string' ? event.effort.level : undefined;
  const inheritedModel = named ? undefined : lib.inheritedModel(event.transcript_path);
  const updated = lib.rewriteClaudeSpawn(input, pins, { parentEffort, invokedEffort: lib.invokedEffort(turn), inheritedModel });
  const dropped = Boolean(updated && input.model && !('model' in updated));
  const notice = dropped ? lib.droppedModelNotice(input.model, inheritedModel) : undefined;
  lib.logDispatch({
    source: 'spawn-hook',
    task: task.slice(0, 2000),
    before: { model: input.model ?? null, effort: input.effort ?? null, subagent_type: input.subagent_type ?? null },
    after: updated ? { model: updated.model ?? null, effort: updated.effort ?? null, subagent_type: updated.subagent_type ?? null } : null,
    parentEffort: parentEffort ?? null,
    ...(named ? { decision: 'named-role' } : {}),
    ...(pins ? { humanPins: pins } : {}),
    ...(notice ? { notice } : {}),
  });
  if (updated) {
    // The spawning agent hears it through the tool call's context, the sub-agent as its prompt's first line.
    const updatedInput = notice ? { ...updated, prompt: `${notice}\n\n${updated.prompt ?? ''}` } : updated;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput, ...(notice ? { additionalContext: notice } : {}) },
    }));
  }
} catch {
  // The spawn proceeds unchanged.
}
