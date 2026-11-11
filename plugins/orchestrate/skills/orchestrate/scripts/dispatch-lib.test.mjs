import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  capEffort,
  humanPins,
  humanTurns,
  rewriteClaudeSpawn,
} from './dispatch-lib.mjs';

test('a spawn with nothing named gains only the default effort', () => {
  assert.deepEqual(rewriteClaudeSpawn({ description: 'd', prompt: 'p' }), { description: 'd', prompt: 'p', effort: 'high' });
  assert.deepEqual(
    rewriteClaudeSpawn({ subagent_type: 'general-purpose', prompt: 'p' }),
    { subagent_type: 'general-purpose', prompt: 'p', effort: 'high' },
  );
});

test('general-purpose counts as roleless', () => {
  const out = rewriteClaudeSpawn({ subagent_type: 'general-purpose', model: 'sonnet', prompt: 'p' });
  assert.deepEqual([out.model, out.subagent_type, out.prompt], [undefined, 'general-purpose', 'p']);
});

test('a shim type alone always leaves with an explicit effort field', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const out = rewriteClaudeSpawn({ subagent_type: `bootstrap-orchestrate:worker-${level}`, prompt: 'p' }, { effort: true });
    assert.deepEqual([out.effort, out.subagent_type], [level, `bootstrap-orchestrate:worker-${level}`]);
  }
});

test('an explicit effort field outranks the shim name, and the shim is renamed to match', () => {
  const out = rewriteClaudeSpawn({ subagent_type: 'bootstrap-orchestrate:worker-low', effort: 'high', prompt: 'p' });
  assert.deepEqual([out.effort, out.subagent_type], ['high', 'bootstrap-orchestrate:worker-high']);
  assert.equal(rewriteClaudeSpawn({ subagent_type: 'bootstrap-orchestrate:worker-high', effort: 'high', prompt: 'p' }), null);
  assert.equal(rewriteClaudeSpawn({ subagent_type: 'general-purpose', effort: 'max', prompt: 'p' }, { effort: true }), null);
});

test('with no model named, an agent-chosen max is capped and a human-chosen max stands', () => {
  const agent = rewriteClaudeSpawn({ subagent_type: 'general-purpose', effort: 'max', prompt: 'p' });
  assert.deepEqual([agent.effort, agent.subagent_type], ['xhigh', 'general-purpose']);
  const shim = rewriteClaudeSpawn({ subagent_type: 'bootstrap-orchestrate:worker-max', prompt: 'p' });
  assert.deepEqual([shim.effort, shim.subagent_type], ['xhigh', 'bootstrap-orchestrate:worker-xhigh']);
  assert.equal(rewriteClaudeSpawn({ subagent_type: 'general-purpose', effort: 'max', prompt: 'p' }, { effort: true }), null);
});

// Named roles: built-in, project/user custom (pinned, `inherit` or no model
// field), and plugin-scoped. A per-call model outranks the role's own model, so
// the hook must leave them as they arrived.
const NAMED_ROLES = ['Explore', 'Plan', 'qa-design-critic', 'qa-smoke-worker', 'qa-adjudicator', 'researcher', 'codex:codex-rescue'];

test('a named role is never rewritten', () => {
  for (const subagent_type of NAMED_ROLES) {
    assert.equal(rewriteClaudeSpawn({ subagent_type, prompt: 'p' }), null, subagent_type);
    assert.equal(rewriteClaudeSpawn({ subagent_type, effort: 'max', prompt: 'p' }), null, subagent_type);
  }
});

test('an explicit tool-call model on a named role is kept as given', () => {
  assert.equal(rewriteClaudeSpawn({ subagent_type: 'qa-smoke-worker', model: 'fable', prompt: 'p' }), null);
});

test('the installed hook leaves every named role untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrate-hook-'));
  const log = path.join(root, 'dispatch-log.jsonl');
  const hook = fileURLToPath(new URL('../../../hooks/route-spawn.mjs', import.meta.url));
  for (const subagent_type of NAMED_ROLES) {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Agent', cwd: root, tool_input: { subagent_type, description: 'd', prompt: 'challenge the evidence' } }),
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH, HOME: root, ORCHESTRATE_DISPATCH_LOG: log },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', subagent_type);
  }
  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.map((e) => [e.before.subagent_type, e.decision, e.after]), NAMED_ROLES.map((t) => [t, 'named-role', null]));
});

test('a model no human named is dropped so the spawn takes the default model, and the effort stands within the caps', () => {
  const shim = (e) => `bootstrap-orchestrate:worker-${e}`;
  const cases = [
    [{ model: 'opus', subagent_type: shim('high') }, {}, [undefined, 'high', shim('high')]],
    [{ model: 'sonnet', subagent_type: 'general-purpose' }, {}, [undefined, 'high', 'general-purpose']],
    [{ model: 'sonnet', prompt: 'p' }, {}, [undefined, 'high', undefined]],
    [{ model: 'fable', effort: 'xhigh' }, { model: true }, ['fable', 'high', undefined]],
    [{ model: 'sonnet', subagent_type: shim('high') }, { effort: true }, [undefined, 'high', shim('high')]],
    [{ model: 'opus', effort: 'max' }, {}, [undefined, 'xhigh', undefined]],
    [{ model: 'sonnet', effort: 'xhigh' }, {}, [undefined, 'xhigh', undefined]],
    [{ model: 'claude-opus-5-5', effort: 'max' }, { model: true }, ['claude-opus-5-5', 'xhigh', undefined]],
    [{ model: 'opus', subagent_type: shim('high') }, { model: true, effort: true }, ['opus', 'high', shim('high')]],
  ];
  for (const [input, pins, expected] of cases) {
    const out = rewriteClaudeSpawn(input, pins);
    assert.deepEqual([out.model, out.effort, out.subagent_type], expected, JSON.stringify([input, pins]));
    assert.equal('model' in out, expected[0] !== undefined, JSON.stringify(input));
  }
  assert.equal(rewriteClaudeSpawn({ model: 'opus', effort: 'high', subagent_type: shim('high') }, { model: true, effort: true }), null);
  assert.equal(rewriteClaudeSpawn({ model: 'opus', effort: 'max' }, { model: true, effort: true }), null);
});

test('humanTurns keeps only the turns people wrote', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrate-transcript-'));
  const user = (content, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
  const envelope = (attrs, body) => `<message ${attrs}>${body}</message>`;
  const write = (name, lines) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, lines.join('\n'));
    return file;
  };
  const noise = [
    user([{ type: 'text', text: 'words-e' }], { isMeta: true }),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'words-f' }]),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'words-h' }] } }),
    user('words-i', { isSidechain: true }),
    'not json',
  ];
  const host = { container: false };
  const container = { container: true };

  assert.deepEqual(humanTurns(write('host.jsonl', [user('words-a <task-notification>words-g</task-notification>'), ...noise]), host), ['words-a']);
  for (const prompt of [
    '/orchestrate opus high analyze <message sender="Avery" from="a">this XML</message>',
    '<message data-from="example">payload</message>\n/orchestrate opus high go',
    '<context timezone="UTC" />\n<message id="1" from="chat-team-1" sender="Avery">quoted</message>\n/orchestrate opus high go',
  ]) assert.deepEqual(humanTurns(write('xml.jsonl', [user(prompt)]), host), [prompt]);

  const batched = write('container.jsonl', [
    user('words-a <task-notification>words-g</task-notification>'),
    user([{ type: 'text', text: [
      '<context timezone="UTC" />',
      envelope('id="1" from="chat-team-1" sender="Avery Lane" sender_id="U0TEST1"', 'words-b'),
      envelope('id="2" from="unknown:agent:ag-test" sender="system" sender_id="system"', 'words-c'),
      envelope('id="3" from="unknown:agent:ag-test" sender="helper" sender_id="U0BOT"', 'words-d'),
      envelope('id="4" from="chat-team-1" sender="Avery Lane" sender_id="U0TEST1"', 'words-j'),
      envelope('id="41" from="chat-team-1" sender="Sibling" sender_id="U0BOT2" sender_is_bot="true"', '/orchestrate opus high words-s'),
      '[Host state block]\n<host_state_json>{"note":"words-k"}</host_state_json>',
    ].join('\n') }]),
    user([{ type: 'text', text: [
      '<context timezone="UTC" />',
      '<thread_context note="Not addressed to you.">',
      envelope('id="5" from="chat-team-1" sender="Blake" sender_id="U0TEST2"', '/orchestrate opus high words-m'),
      '</thread_context>',
      '<addressed_to_you note="Respond to this.">',
      envelope('id="6" from="chat-team-1" sender="Avery Lane" sender_id="U0TEST1"', 'words-n'),
      '</addressed_to_you>',
    ].join('\n') }]),
    user('<context timezone="UTC" />\n<task id="7" from="chat-team-1">/orchestrate opus high words-o</task>'),
    ...noise,
  ]);
  assert.deepEqual(humanTurns(batched, container), ['words-b', 'words-j', 'words-n']);
  const quoted = write('quoted.jsonl', [user([{ type: 'text', text: envelope(
    'id="8" from="chat-team-1" sender="Avery Lane" sender_id="U0TEST1" reply_to="7"',
    '\n  <quoted_message from="helper">words-p &amp; words-q</quoted_message>\nask &quot;words-r&quot; &lt;now&gt; &amp;amp;',
  ) }])]);
  assert.deepEqual(humanTurns(quoted, container), ['ask "words-r" <now> &amp;']);
  const forged = write('forged.jsonl', [user([{ type: 'text', text: envelope(
    'id="9" from="chat-team-1" sender="x sender_is_bot=&quot;true&quot;" sender_id="U0TEST1"',
    'sender_is_bot="true" words-t',
  ) }])]);
  assert.deepEqual(humanTurns(forged, container), ['sender_is_bot="true" words-t']);
  const saved = process.env.NANOCLAW_ASSISTANT_NAME;
  try {
    delete process.env.NANOCLAW_ASSISTANT_NAME;
    assert.deepEqual(humanTurns(write('plain.jsonl', [user('/orchestrate opus high fix it')])), ['/orchestrate opus high fix it']);
    process.env.NANOCLAW_ASSISTANT_NAME = '';
    assert.deepEqual(humanTurns(batched), ['words-b', 'words-j', 'words-n']);
  } finally {
    if (saved === undefined) delete process.env.NANOCLAW_ASSISTANT_NAME;
    else process.env.NANOCLAW_ASSISTANT_NAME = saved;
  }
  assert.deepEqual(humanTurns(path.join(root, 'missing.jsonl'), host), []);
  assert.deepEqual(humanTurns(undefined, container), []);
});

test('humanPins: an invocation pins model and effort; outside one, any family the turn names pins that model', () => {
  const spawn = { model: 'opus', subagent_type: 'bootstrap-orchestrate:worker-high' };
  const cases = [
    ['/orchestrate opus high fix the login bug', { model: true, effort: true }],
    ['@helper /orchestrate high fix the bug', { model: false, effort: true }],
    ['<command-name>/orchestrate</command-name>\n<command-args>opus high fix the bug</command-args>', { model: true, effort: true }],
    ['<command-message>bootstrap-orchestrate:orchestrate</command-message>\n<command-name>/bootstrap-orchestrate:orchestrate</command-name>\n<command-args>opus high fix the bug</command-args>', { model: true, effort: true }],
    ['<command-name>/other-plugin:orchestrate</command-name>\n<command-args>opus high fix the bug</command-args>', { model: true, effort: false }],
    ['use an Opus subagent at high effort to fix it', { model: true, effort: true }],
    ['use an opus subagent to fix it', { model: true, effort: false }],
    ['/orchestrate fable low fix it', { model: false, effort: false }],
    ['orchestrate high availability testing', { model: false, effort: false }],
    ['compare Opus and Sonnet, then run it at high effort', { model: true, effort: false }],
    ['the earlier attempt failed at high effort, try again', { model: false, effort: false }],
    ['', { model: false, effort: false }],
    ['/orchestrate opus high first task\n/orchestrate second task', { model: false, effort: false }],
    ['/orchestrate opus high first task\nuse an opus subagent to do the second', { model: true, effort: false }],
    ['do not use an opus subagent at high effort', { model: false, effort: false }],
    ["I don't want you to use an opus subagent at high effort", { model: false, effort: false }],
    ['No problem, use an opus subagent at high effort', { model: true, effort: true }],
    ["I don't mind; use an opus subagent at high effort", { model: true, effort: true }],
    ['do not, under any circumstances, use an opus subagent at high effort', { model: false, effort: false }],
    ['Do not touch the database, but use an opus subagent at high effort to fix the UI', { model: true, effort: true }],
    ['You cannot use an opus subagent at high effort', { model: false, effort: false }],
    ['use an opus subagent at high effort for task A. Do not use an opus subagent at high effort for this one', { model: false, effort: false }],
    ['use an opus subagent at high.', { model: true, effort: true }],
    ['/orchestrate opus high, then report back', { model: true, effort: true }],
    ['/orchestrate claude-opus-5 high do it', { model: true, effort: true }],
    ['this is not working\n/orchestrate opus high fix it', { model: true, effort: true }],
    ['/orchestrate opus high-priority bug', { model: true, effort: false }],
    ['/orchestrate opus-related cleanup', { model: false, effort: false }],
    ['/orchestrate opus.js cleanup', { model: false, effort: false }],
    ['/orchestrate opus high.priority cleanup', { model: true, effort: false }],
    ['/orchestrate opus high!) now', { model: true, effort: true }],
    ['/orchestrate opus high', { model: true, effort: true }],
    ['use a claude-opus-5 subagent at high to do it', { model: true, effort: true }],
    ["Did we do our own sub agent review of the PR? I'd like opus to take a look as well.", { model: true, effort: false }],
    ["get claude-opus-5's take on this", { model: true, effort: false }],
    ['get claude-opus-5\u2019s take on this', { model: true, effort: false }],
    ['have Opus review it at high effort', { model: true, effort: false }],
    ["I'd like fable to take a look", { model: false, effort: false }],
    ['opus is overkill; ask fable', { model: true, effort: false }],
    ["don't use opus here", { model: true, effort: false }],
    ['/orchestrate have opus review it', { model: true, effort: false }],
    ['/orchestrate high have opus review it', { model: true, effort: true }],
    ['/orchestrate high compare opus and sonnet', { model: true, effort: true }],
    ['ask `opus` to review it', { model: true, effort: false }],
    ['ask "opus" to review it', { model: true, effort: false }],
    ['*opus* please', { model: true, effort: false }],
    ['_opus_ please', { model: true, effort: false }],
    ['opus\u2026 when you can', { model: true, effort: false }],
    ['opus\u2014now', { model: true, effort: false }],
    ['opus.js is broken', { model: false, effort: false }],
    ['don\u2019t use an opus subagent at high', { model: false, effort: false }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(humanPins(spawn, text), expected, text);
  assert.deepEqual(humanPins({ model: 'opus', effort: 'high' }, '/orchestrate opus high go'), { model: true, effort: true });
  assert.deepEqual(humanPins({ effort: 'high', subagent_type: 'bootstrap-orchestrate:worker-low' }, '/orchestrate opus high go'), { model: false, effort: true });
  assert.deepEqual(humanPins({ effort: 'low', subagent_type: 'bootstrap-orchestrate:worker-high' }, '/orchestrate opus high go'), { model: false, effort: false });
  assert.deepEqual(humanPins({ model: 'sonnet', prompt: 'p' }, '/orchestrate opus high go'), { model: false, effort: false });
  for (const text of ['compare Opus/Sonnet', 'compare Opus,Sonnet', 'compare _opus_ and sonnet']) {
    for (const model of ['opus', 'sonnet']) assert.deepEqual(humanPins({ model }, text), { model: true, effort: false }, `${model}: ${text}`);
  }
});
test('the installed hook drops an agent-named model unless a human named it, and keeps the effort the agent asked for', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrate-hook-'));
  const hook = fileURLToPath(new URL('../../../hooks/route-spawn.mjs', import.meta.url));
  let runs = 0;
  const run = (turns, toolInput = { model: 'opus', subagent_type: 'bootstrap-orchestrate:worker-high' }) => {
    const transcript = path.join(root, `t-${runs++}.jsonl`);
    fs.writeFileSync(transcript, turns.map((content) => JSON.stringify({ type: 'user', message: { role: 'user', content } })).join('\n') + '\n');
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        tool_name: 'Agent',
        transcript_path: transcript,
        tool_input: { ...toolInput, description: 'd', prompt: 'rename a variable' },
      }),
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH, HOME: root, ORCHESTRATE_DISPATCH_LOG: path.join(root, 'log.jsonl') },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.updatedInput : null;
  };
  const out = run(['please clean this up']);
  assert.deepEqual([out.model, out.effort, out.subagent_type], [undefined, 'high', 'bootstrap-orchestrate:worker-high']);
  assert.equal('model' in out, false);
  const pinned = run(['/orchestrate opus high clean this up']);
  assert.deepEqual([pinned.model, pinned.effort, pinned.subagent_type], ['opus', 'high', 'bootstrap-orchestrate:worker-high']);
  const namedSonnet = { model: 'sonnet', subagent_type: 'bootstrap-orchestrate:worker-high' };
  const stillPinned = run(['/orchestrate sonnet high clean this up'], namedSonnet);
  assert.deepEqual([stillPinned.model, stillPinned.effort], ['sonnet', 'high']);
  const later = run(['/orchestrate sonnet high clean this up', 'now look at a different issue'], namedSonnet);
  assert.deepEqual([later.model, later.effort, later.subagent_type], [undefined, 'high', 'bootstrap-orchestrate:worker-high']);
  const roleless = { subagent_type: 'general-purpose', effort: 'high' };
  assert.equal(run(['/orchestrate high clean this up'], roleless), null);
  assert.equal(run(['please clean this up'], roleless), null);
  assert.equal(run(['use xhigh effort for this'], { subagent_type: 'general-purpose', effort: 'xhigh' }), null);
  assert.equal(run(['please clean this up'], { subagent_type: 'general-purpose' }).effort, 'high');
  const compared = run(['compare Opus and Sonnet on this'], { model: 'sonnet', subagent_type: 'general-purpose' });
  assert.deepEqual([compared.model, compared.effort], ['sonnet', 'high']);
});

test('an explicit effort above the cap is lowered; within the cap it is kept', () => {
  const over = rewriteClaudeSpawn({ model: 'fable', subagent_type: 'bootstrap-orchestrate:worker-max' }, { model: true });
  assert.deepEqual([over.effort, over.subagent_type], ['high', 'bootstrap-orchestrate:worker-high']);
  const opusMax = rewriteClaudeSpawn({ model: 'opus', subagent_type: 'bootstrap-orchestrate:worker-max' }, { model: true });
  assert.deepEqual([opusMax.effort, opusMax.subagent_type], ['xhigh', 'bootstrap-orchestrate:worker-xhigh']);
  const opusParam = rewriteClaudeSpawn({ model: 'opus', effort: 'max' }, { model: true });
  assert.deepEqual([opusParam.effort, opusParam.subagent_type], ['xhigh', undefined]);
  assert.equal(rewriteClaudeSpawn({ model: 'opus', effort: 'xhigh', subagent_type: 'bootstrap-orchestrate:worker-xhigh' }, { model: true }), null);
});

test('capEffort lowers only above the cap', () => {
  assert.equal(capEffort('max', 'high'), 'high');
  assert.equal(capEffort('low', 'high'), 'low');
  assert.equal(capEffort('weird', 'high'), 'weird');
});

/** Runs the installed hook on one spawn after one human turn and a reply from `parent`; returns its hookSpecificOutput. */
function spawnHookRunner() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrate-hook-'));
  const hook = fileURLToPath(new URL('../../../hooks/route-spawn.mjs', import.meta.url));
  let runs = 0;
  const run = (human, toolInput, { parent = 'claude-opus-5-5', env = {}, parentEffort } = {}) => {
    const transcript = path.join(root, `t-${runs++}.jsonl`);
    const records = [{ type: 'user', message: { role: 'user', content: human } }];
    if (parent) records.push({ type: 'assistant', message: { role: 'assistant', model: parent, content: [{ type: 'text', text: 'ok' }] } });
    fs.writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        tool_name: 'Agent',
        transcript_path: transcript,
        ...(parentEffort ? { effort: { level: parentEffort } } : {}),
        tool_input: { subagent_type: 'general-purpose', description: 'review the spec', prompt: 'Read brief.md.', ...toolInput },
      }),
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH, HOME: root, ORCHESTRATE_DISPATCH_LOG: path.join(root, 'log.jsonl'), ...env },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  return run;
}

test('the installed hook tells the agent and the sub-agent when it drops the model the agent asked for', () => {
  const run = spawnHookRunner();
  const notice =
    'Model note: this sub-agent was requested on fable, and that was dropped, so it runs on claude-opus-5-5. ' +
    'Only a model a person names in their latest message applies. ' +
    'Name claude-opus-5-5, not fable, in anything that says which model did this work.';

  const dropped = run('Thanks, now get it reviewed.', { model: 'fable' });
  assert.equal(dropped.additionalContext, notice);
  assert.equal(dropped.updatedInput.prompt, `${notice}\n\nRead brief.md.`);
  assert.equal('model' in dropped.updatedInput, false);

  const override = run('Thanks, now get it reviewed.', { model: 'fable' }, { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5' } });
  assert.match(override.additionalContext, /so it runs on claude-sonnet-5-5\. .* Name claude-sonnet-5-5, not fable,/);

  const unknown = run('Thanks, now get it reviewed.', { model: 'fable' }, { parent: null });
  assert.equal(
    unknown.additionalContext,
    "Model note: this sub-agent was requested on fable, and that was dropped, so it runs on this session's own model. " +
      "Only a model a person names in their latest message applies. Don't name fable in anything that says which model did this work.",
  );

});

test('the installed hook adds no model note when a person named the model or no model was asked for', () => {
  const run = spawnHookRunner();
  const kept = run('Use a fable subagent to review it.', { model: 'fable' });
  assert.deepEqual([kept.updatedInput.model, kept.updatedInput.prompt, 'additionalContext' in kept], ['fable', 'Read brief.md.', false]);
  const named = run('Use a fable subagent to review it.', { model: 'fable', effort: 'xhigh' });
  assert.deepEqual([named.updatedInput.model, named.updatedInput.effort, named.updatedInput.prompt], ['fable', 'high', 'Read brief.md.']);
  assert.equal('additionalContext' in named, false);

  const effortOnly = run('Thanks, now get it reviewed.', { effort: 'max' });
  assert.deepEqual([effortOnly.updatedInput.effort, effortOnly.updatedInput.prompt], ['xhigh', 'Read brief.md.']);
  assert.equal('additionalContext' in effortOnly, false);
});

test('a roleless spawn that names no effort runs at high, or at the parent level when that is lower', () => {
  const effortUnder = (parentEffort) =>
    rewriteClaudeSpawn({ subagent_type: 'general-purpose', prompt: 'p' }, {}, { parentEffort })?.effort;
  assert.deepEqual(
    ['max', 'xhigh', 'high', 'medium', 'low', undefined].map(effortUnder),
    ['high', 'high', 'high', 'medium', 'low', 'high'],
  );
});

test('the effort a person named in their latest invocation fills a spawn that names none, uncapped', () => {
  const invoked = rewriteClaudeSpawn({ subagent_type: 'general-purpose', prompt: 'p' }, {}, { parentEffort: 'xhigh', invokedEffort: 'max' });
  assert.equal(invoked?.effort, 'max');
  const fable = rewriteClaudeSpawn({ model: 'fable', prompt: 'p' }, { model: true }, { invokedEffort: 'xhigh' });
  assert.deepEqual([fable?.model, fable?.effort], ['fable', 'xhigh']);
  const called = rewriteClaudeSpawn({ subagent_type: 'general-purpose', effort: 'low', prompt: 'p' }, {}, { invokedEffort: 'xhigh' });
  assert.equal(called, null);
});

test('the installed hook gives a spawn with no effort the default, keeps a level the person named, and caps an agent\'s own', () => {
  const run = spawnHookRunner();
  const xhighParent = { parentEffort: 'xhigh' };
  const effortOf = (out) => out?.updatedInput?.effort;

  assert.equal(effortOf(run('Thanks, now get it reviewed.', {}, xhighParent)), 'high');
  assert.equal(effortOf(run('Thanks, now get it reviewed.', {}, { parentEffort: 'medium' })), 'medium');
  assert.equal(effortOf(run('Thanks, now get it reviewed.', {})), 'high');

  assert.equal(run('/orchestrate xhigh review the spec', { effort: 'xhigh' }, xhighParent), null);
  assert.equal(effortOf(run('/orchestrate xhigh review the spec', {}, xhighParent)), 'xhigh');
  assert.equal(effortOf(run('/orchestrate max review the spec', {}, xhighParent)), 'max');

  assert.equal(effortOf(run('Thanks, now get it reviewed.', { effort: 'max' }, xhighParent)), 'xhigh');
  assert.equal(effortOf(run('Use a fable subagent at xhigh to review it.', { model: 'fable' }, xhighParent)), 'xhigh');
  assert.equal(run('Thanks, now get it reviewed.', { subagent_type: 'Explore' }, xhighParent), null);
});

const capRun = () => {
  const run = spawnHookRunner();
  return (turn, toolInput, opts) => {
    const out = run(turn, toolInput, opts);
    return out && { effort: out.updatedInput.effort, type: out.updatedInput.subagent_type };
  };
};
const onVariable = (model) => ({ parent: 'claude-sonnet-5-5', env: { CLAUDE_CODE_SUBAGENT_MODEL: model } });

test('an agent\'s own effort is capped for the install default sub-agent model', () => {
  const run = capRun();
  const own = 'Thanks, now get it reviewed.';
  assert.equal(run(own, { effort: 'max' }, onVariable('fable')).effort, 'high');
  assert.equal(run(own, { subagent_type: 'bootstrap-orchestrate:worker-max' }, onVariable('fable')).type, 'bootstrap-orchestrate:worker-high');
  assert.equal(run(own, { effort: 'max' }, onVariable('opus[1m]')).effort, 'xhigh');
  assert.equal(run(own, { effort: 'max' }, onVariable('claude-opus-5-5[1m]')).effort, 'xhigh');
});

test('with no install default, an agent\'s own effort is capped for its parent model', () => {
  const run = capRun();
  const own = 'Thanks, now get it reviewed.';
  assert.equal(run(own, { effort: 'max' }, { parent: 'claude-fable-5-2' }).effort, 'high');
  assert.equal(run(own, { effort: 'max' }, { parent: 'claude-opus-5-5' }).effort, 'xhigh');
  assert.equal(run(own, { model: 'opus', effort: 'max' }, { parent: 'claude-fable-5-2' }).effort, 'high');
});

test('a level a person chose is not capped, whichever model runs; a named role is never rewritten', () => {
  const run = capRun();
  const invoked = '/orchestrate max review the spec';
  assert.equal(run('/orchestrate opus max review the spec', { model: 'opus' }, onVariable('fable')).effort, 'max');
  for (const opts of [onVariable('opus[1m]'), onVariable('fable'), { parent: 'claude-opus-5-5' }, { parent: 'claude-fable-5-2' }]) {
    assert.equal(run(invoked, {}, opts).effort, 'max', JSON.stringify(opts));
  }
  assert.equal(run(invoked, { subagent_type: 'Explore', effort: 'max' }, onVariable('fable')), null);
  assert.equal(run('Thanks, now get it reviewed.', { subagent_type: 'qa-smoke-worker', effort: 'max' }, { parent: 'claude-fable-5-2' }), null);
});
