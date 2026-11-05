#!/usr/bin/env node
// Claude Code PreToolUse hook on SendMessage: refuse to revive a stale helper.
// A message to one of this session's own sub-agents that finished past the
// prompt-cache window is denied with a note to spawn a fresh one-shot helper,
// unless the person named that helper in their latest message. Everything else
// (a warm or working helper, a peer session) passes. Fails open.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'skills', 'orchestrate', 'scripts');
const revive = await import(path.join(scripts, 'revive-lib.mjs'));
const dispatch = await import(path.join(scripts, 'dispatch-lib.mjs'));

try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  const to = event?.tool_input?.to;
  if (event?.tool_name !== 'SendMessage' || typeof to !== 'string') process.exit(0);
  const file = revive.helperTranscript(event.transcript_path, to);
  const stale = file ? revive.staleHelper(file) : undefined;
  if (!stale) process.exit(0);
  const latest = dispatch.humanTurns(event.transcript_path).at(-1) ?? '';
  const said = latest.toLowerCase();
  const named = [to, ...revive.helperAliases(file)].some((alias) => said.includes(alias.toLowerCase()));
  dispatch.logDispatch({ source: 'revive-guard', to, ...stale, decision: named ? 'person-named' : 'refused' });
  if (named) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: revive.staleHelperNotice(to, stale),
    },
  }));
} catch {
  // The message goes through unchanged.
}
