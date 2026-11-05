import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { helperTranscript, staleHelper } from './revive-lib.mjs';

const MINUTE = 60_000;
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * MINUTE).toISOString();
const usage = (tokens) => ({ input_tokens: 2, cache_read_input_tokens: tokens - 2, cache_creation_input_tokens: 0, output_tokens: 10 });

/** A helper that took its brief and ended on a final answer `minutesAgo` minutes ago. */
const finished = (minutesAgo, tokens = 400_000) => [
  { type: 'user', timestamp: at(minutesAgo + 5), message: { role: 'user', content: 'Review the spec.' } },
  { type: 'assistant', timestamp: at(minutesAgo), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: usage(tokens) } },
];

/** A helper whose last record is a tool call it is still waiting on. */
const working = (minutesAgo) => [
  { type: 'user', timestamp: at(minutesAgo + 5), message: { role: 'user', content: 'Run the build.' } },
  { type: 'assistant', timestamp: at(minutesAgo), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use', usage: usage(90_000) } },
];

/** A session directory laid out as Claude Code writes it: <id>.jsonl beside <id>/subagents/agent-<agentId>.{jsonl,meta.json}. */
function session() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrate-revive-'));
  const main = path.join(root, 'sess.jsonl');
  const sub = path.join(root, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(main, '');
  const add = (agentId, meta, records, mtimeMinutesAgo) => {
    const file = path.join(sub, `agent-${agentId}.jsonl`);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(sub, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    if (mtimeMinutesAgo !== undefined) {
      const t = new Date(Date.now() - mtimeMinutesAgo * MINUTE);
      fs.utimesSync(path.join(sub, `agent-${agentId}.meta.json`), t, t);
    }
    return file;
  };
  const humanSays = (text) => fs.writeFileSync(main, JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  return { root, main, add, humanSays };
}

test('a helper that finished past the one-hour cache is stale; a warm or still-working one is not', () => {
  const s = session();
  assert.deepEqual(staleHelper(s.add('a1', {}, finished(90))), { idleMinutes: 90, contextTokens: 400_000 });
  assert.equal(staleHelper(s.add('a2', {}, finished(10))), undefined);
  assert.equal(staleHelper(s.add('a3', {}, working(180))), undefined);
  const trailing = [...finished(90), { type: 'api-request', timestamp: at(1) }, { type: 'system', timestamp: at(1) }];
  assert.equal(staleHelper(s.add('a4', {}, trailing))?.idleMinutes, 90);
  assert.equal(staleHelper(path.join(s.root, 'missing.jsonl')), undefined);
});

test('a helper is stale only on positive evidence that its last turn ended', () => {
  const s = session();
  const thinkingOnly = [
    finished(200)[0],
    { type: 'assistant', timestamp: at(150), message: { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }], stop_reason: null, usage: usage(300_000) } },
  ];
  assert.equal(staleHelper(s.add('b1', {}, thinkingOnly)), undefined);
  const torn = s.add('b2', {}, finished(90));
  fs.appendFileSync(torn, '{"type":"user","timestamp":"' + at(1) + '","message":{"role":"user","content":"one more');
  assert.equal(staleHelper(torn), undefined);
  const tornEarly = s.add('b3', {}, finished(90));
  fs.appendFileSync(tornEarly, '{"parentUuid":');
  assert.equal(staleHelper(tornEarly), undefined);
});

test('a helper whose last turn is far behind a long tail of records is still read', () => {
  const s = session();
  const big = 'x'.repeat(2_000_000);
  const records = [...finished(90), ...Array.from({ length: 3 }, () => ({ type: 'attachment', timestamp: at(1), blob: big }))];
  assert.equal(staleHelper(s.add('a5', {}, records))?.idleMinutes, 90);
});

test('helperTranscript resolves only the session\'s own helper, by agent id or by its newest name', () => {
  const s = session();
  const byId = s.add('a0123abc', { agentType: 'general-purpose' }, finished(5));
  const older = s.add('a1111111', { name: 'reviewer', agentType: 'reviewer' }, finished(200), 300);
  const newer = s.add('a2222222', { name: 'reviewer', agentType: 'reviewer' }, finished(5), 10);
  assert.equal(helperTranscript(s.main, 'a0123abc'), byId);
  assert.equal(helperTranscript(s.main, 'agent-a0123abc'), byId);
  assert.equal(helperTranscript(s.main, 'reviewer'), newer);
  assert.notEqual(helperTranscript(s.main, 'reviewer'), older);
  assert.equal(helperTranscript(s.main, 'another-session'), undefined);
  assert.equal(helperTranscript(s.main, '../sess'), undefined);
  assert.equal(helperTranscript(undefined, 'reviewer'), undefined);
});

test('the installed guard refuses a message to a stale helper and lets every other message through', () => {
  const s = session();
  s.add('a3333333', { name: 'standing-helper', agentType: 'general-purpose' }, finished(95, 420_000));
  s.add('a4444444', { name: 'owner', agentType: 'bootstrap-orchestrate:worker-high' }, finished(12));
  s.add('a5555555', {}, working(150));
  const hook = fileURLToPath(new URL('../../../hooks/revive-guard.mjs', import.meta.url));
  const send = (to) => {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'SendMessage', transcript_path: s.main, tool_input: { to, message: 'one more question' } }),
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH, HOME: s.root, ORCHESTRATE_DISPATCH_LOG: path.join(s.root, 'log.jsonl') },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };

  s.humanSays('Thanks. Ask it whether the cache test passed.');
  const refused = send('standing-helper');
  assert.equal(refused.permissionDecision, 'deny');
  assert.match(refused.permissionDecisionReason, /standing-helper finished 95 minutes ago/);
  assert.match(refused.permissionDecisionReason, /~420k tokens/);
  assert.match(refused.permissionDecisionReason, /spawn a fresh one-shot helper with a self-contained brief/i);
  assert.equal(send('a3333333')?.permissionDecision, 'deny');

  assert.equal(send('owner'), null);
  assert.equal(send('a5555555'), null);
  assert.equal(send('another-session'), null);

  s.humanSays('Go back to standing-helper and ask it again.');
  assert.equal(send('standing-helper'), null);
  assert.equal(send('a3333333'), null);
  s.humanSays('Resume a3333333 for this.');
  assert.equal(send('standing-helper'), null);
});
