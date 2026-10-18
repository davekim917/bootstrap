import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  capEffort,
  humanPins,
  humanTurns,
  loadRubric,
  pick,
  requestSystemOne,
  resolveDispatch,
  rewriteClaudeSpawn,
} from './dispatch-lib.mjs';

const rubric = loadRubric();
const route = (model, effort) => ({ decision: 'route', pick: { model, effort } });
const requestBody = (task = 'synthetic transport test') => ({
  model: 'jev-1.13.0',
  state: { task_brief: task },
  questions: { dispatch: { type: 'choice', criteria: { 'workhorse-medium': 'synthetic' } } },
});
const answer = {
  answers: {
    dispatch: {
      choice: 'workhorse-medium',
      confidence: 0.9,
      probabilities: { 'workhorse-medium': 0.9, ask: 0.1 },
    },
  },
};

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) };
}

function fakeSpawn({
  stdout = '', stderr = '', code = 0, delay = 0, hang = false, error = null,
  closeOnKill = true, emitClose = true,
} = {}) {
  const calls = [];
  let killed = false;
  let unrefed = false;
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = '';
    child.stdin = new Writable({ write(chunk, _encoding, done) { input += chunk.toString(); done(); } });
    child.kill = () => {
      killed = true;
      if (closeOnKill) queueMicrotask(() => child.emit('close', null));
      return true;
    };
    child.unref = () => { unrefed = true; };
    calls.push({ command, args, options, child, get input() { return input; } });
    queueMicrotask(() => {
      if (error) child.emit('error', error);
      else if (!hang) setTimeout(() => {
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        if (emitClose) {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', code);
        }
      }, delay);
    });
    return child;
  };
  return { spawnImpl, calls, wasKilled: () => killed, wasUnrefed: () => unrefed };
}

test('a roleless spawn with nothing named gets the picked model and effort shim', () => {
  const out = rewriteClaudeSpawn({ description: 'd', prompt: 'p' }, route('opus', 'high'), rubric);
  assert.equal(out.model, 'opus');
  assert.equal(out.subagent_type, 'bootstrap-orchestrate:worker-high');
  assert.equal(out.prompt, 'p');
});

test('general-purpose counts as roleless', () => {
  const out = rewriteClaudeSpawn({ subagent_type: 'general-purpose', prompt: 'p' }, route('fable', 'low'), rubric);
  assert.deepEqual([out.model, out.subagent_type], ['fable', 'bootstrap-orchestrate:worker-low']);
});

// Named roles: built-in, project/user custom (pinned, `inherit` or no model
// field), and plugin-scoped. A per-call model outranks the role's own model, so
// a confident route must never be written into one.
const NAMED_ROLES = ['Explore', 'Plan', 'qa-design-critic', 'qa-smoke-worker', 'qa-adjudicator', 'researcher', 'codex:codex-rescue'];

test('a named role is never rewritten, even on a confident route', () => {
  for (const subagent_type of NAMED_ROLES) {
    for (const r of [route('opus', 'low'), route('fable', 'high'), route('opus', 'max')]) {
      assert.equal(rewriteClaudeSpawn({ subagent_type, prompt: 'p' }, r, rubric), null, subagent_type);
    }
  }
});

test('an explicit tool-call model on a named role is kept as given', () => {
  assert.equal(rewriteClaudeSpawn({ subagent_type: 'qa-smoke-worker', model: 'fable', prompt: 'p' }, route('opus', 'xhigh'), rubric), null);
});

test('the installed hook leaves every named role untouched and never consults the picker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrate-hook-'));
  const log = path.join(root, 'dispatch-log.jsonl');
  const hook = fileURLToPath(new URL('../../../hooks/route-spawn.mjs', import.meta.url));
  for (const subagent_type of NAMED_ROLES) {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Agent', cwd: root, tool_input: { subagent_type, description: 'd', prompt: 'challenge the evidence' } }),
      encoding: 'utf8',
      timeout: 15000,
      // No transport at all: a picker call here could only fail, and would show as decision "inherit".
      env: { PATH: process.env.PATH, HOME: root, ORCHESTRATE_DISPATCH_LOG: log },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', subagent_type);
  }
  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.map((e) => [e.before.subagent_type, e.decision, e.after]), NAMED_ROLES.map((t) => [t, 'named-role', null]));
});

test('no override preserves a custom role and its native model inheritance', () => {
  const picked = resolveDispatch({ decision: 'unavailable', pick: null }, 'claude');
  assert.equal(rewriteClaudeSpawn({ subagent_type: 'qa-adjudicator', prompt: 'p' }, picked, rubric), null);
});

test('a confident route replaces what the agent named; a field the human named is kept', () => {
  const shim = (e) => `bootstrap-orchestrate:worker-${e}`;
  const cases = [
    [{ model: 'opus', subagent_type: shim('high') }, route('opus', 'low'), {}, ['opus', shim('low')]],
    [{ model: 'sonnet', subagent_type: 'general-purpose' }, route('opus', 'low'), {}, ['opus', shim('low')]],
    [{ model: 'fable', prompt: 'p' }, route('opus', 'xhigh'), { model: true }, ['fable', shim('high')]],
    [{ model: 'sonnet', subagent_type: shim('high') }, route('opus', 'low'), { effort: true }, ['opus', shim('high')]],
  ];
  for (const [input, r, pins, expected] of cases) {
    const out = rewriteClaudeSpawn(input, r, rubric, pins);
    assert.deepEqual([out.model, out.subagent_type], expected, JSON.stringify([input, pins]));
  }
  assert.equal(rewriteClaudeSpawn({ model: 'opus', subagent_type: shim('high') }, route('opus', 'low'), rubric, { model: true, effort: true }), null);
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

test('humanPins: an invocation pins model and effort; outside one, a sole named family pins that model', () => {
  const spawn = { model: 'opus', subagent_type: 'bootstrap-orchestrate:worker-high' };
  const cases = [
    ['/orchestrate opus high fix the login bug', { model: true, effort: true }],
    ['@helper /orchestrate high fix the bug', { model: false, effort: true }],
    ['<command-name>/orchestrate</command-name>\n<command-args>opus high fix the bug</command-args>', { model: true, effort: true }],
    ['use an Opus subagent at high effort to fix it', { model: true, effort: true }],
    ['use an opus subagent to fix it', { model: true, effort: false }],
    ['/orchestrate fable low fix it', { model: false, effort: false }],
    ['orchestrate high availability testing', { model: false, effort: false }],
    ['compare Opus and Sonnet, then run it at high effort', { model: false, effort: false }],
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
    ['opus is overkill; ask fable', { model: false, effort: false }],
    ["don't use opus here", { model: true, effort: false }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(humanPins(spawn, text), expected, text);
  assert.deepEqual(humanPins({ model: 'sonnet', prompt: 'p' }, '/orchestrate opus high go'), { model: false, effort: false });
});
test('the installed hook replaces an agent-named model and effort unless a human named them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrate-hook-'));
  const preload = path.join(root, 'preload.mjs');
  fs.writeFileSync(preload, `globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(${JSON.stringify({
    answers: { dispatch: { choice: 'workhorse-low', confidence: 0.9, probabilities: { 'workhorse-low': 0.9, ask: 0.1 } } },
  })}) });`);
  const hook = fileURLToPath(new URL('../../../hooks/route-spawn.mjs', import.meta.url));
  let runs = 0;
  const run = (turns) => {
    const transcript = path.join(root, `t-${runs++}.jsonl`);
    fs.writeFileSync(transcript, turns.map((content) => JSON.stringify({ type: 'user', message: { role: 'user', content } })).join('\n') + '\n');
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        tool_name: 'Agent',
        transcript_path: transcript,
        tool_input: { model: 'opus', subagent_type: 'bootstrap-orchestrate:worker-high', description: 'd', prompt: 'rename a variable' },
      }),
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH, HOME: root, TYPESAFE_API_KEY: 'test-key', NODE_OPTIONS: `--import ${preload}`, ORCHESTRATE_DISPATCH_LOG: path.join(root, 'log.jsonl') },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.updatedInput : null;
  };
  const out = run(['please clean this up']);
  assert.deepEqual([out.model, out.subagent_type], ['opus', 'bootstrap-orchestrate:worker-low']);
  assert.equal(run(['/orchestrate opus high clean this up']), null);
  const later = run(['/orchestrate opus high clean this up', 'now look at a different issue']);
  assert.deepEqual([later.model, later.subagent_type], ['opus', 'bootstrap-orchestrate:worker-low']);
});

test('an explicit shim above the cap is lowered; within the cap nothing changes', () => {
  const over = rewriteClaudeSpawn({ model: 'fable', subagent_type: 'bootstrap-orchestrate:worker-max' }, null, rubric);
  assert.equal(over.subagent_type, 'bootstrap-orchestrate:worker-high');
  const opusMax = rewriteClaudeSpawn({ model: 'opus', subagent_type: 'bootstrap-orchestrate:worker-max' }, null, rubric);
  assert.equal(opusMax.subagent_type, 'bootstrap-orchestrate:worker-xhigh');
  assert.equal(rewriteClaudeSpawn({ model: 'opus', subagent_type: 'bootstrap-orchestrate:worker-xhigh' }, null, rubric), null);
});

test('no route (ask / unavailable / null) leaves a spawn untouched', () => {
  for (const p of [null, { decision: 'ask', pick: { model: 'opus', effort: 'low' } }, { decision: 'unavailable', pick: null }]) {
    assert.equal(rewriteClaudeSpawn({ prompt: 'p' }, p, rubric), null);
  }
});

test('a usable Jev route is preserved with classifier provenance', () => {
  const picked = { runtime: 'codex', decision: 'route', pick: { model: 'gpt-6.1-sol', effort: 'high' }, confidence: 0.99 };
  assert.deepEqual(resolveDispatch(picked, 'codex'), { ...picked, provenance: 'jev' });
});

test('unavailable, abstaining, and unusable routes become an actionable native no-override', () => {
  const cases = [
    { decision: 'unavailable', pick: null },
    { decision: 'ask', pick: { option: 'ask', model: 'opus', effort: 'low' } },
    { decision: 'route', pick: { model: '', effort: 'high' } },
    { decision: 'route', pick: { model: 'opus', effort: 'unsupported' } },
  ];
  for (const raw of cases) {
    const claude = resolveDispatch(raw, 'claude');
    const codex = resolveDispatch(raw, 'codex');
    assert.deepEqual([claude.decision, claude.pick, claude.provenance, claude.inheritFrom], [
      'inherit', null, 'native', raw.decision,
    ]);
    assert.deepEqual([codex.decision, codex.pick, codex.provenance, codex.inheritFrom], [
      'inherit', null, 'native', raw.decision,
    ]);
  }
});

test('no override adds no model or effort shim while independent caps remain', () => {
  const picked = resolveDispatch({ decision: 'ask', pick: { option: 'ask' } }, 'claude');
  for (const input of [
    { prompt: 'p' },
    { model: 'fable', prompt: 'p' },
    { subagent_type: 'bootstrap-orchestrate:worker-low', prompt: 'p' },
    { subagent_type: 'qa-adjudicator', prompt: 'p' },
  ]) {
    assert.equal(rewriteClaudeSpawn(input, picked, rubric), null);
  }
  const capped = rewriteClaudeSpawn({
    model: 'fable', subagent_type: 'bootstrap-orchestrate:worker-max', prompt: 'p',
  }, picked, rubric);
  assert.deepEqual([capped.model, capped.subagent_type], [
    'fable', 'bootstrap-orchestrate:worker-high',
  ]);
});

test('capEffort lowers only above the cap', () => {
  assert.equal(capEffort('max', 'high'), 'high');
  assert.equal(capEffort('low', 'high'), 'low');
  assert.equal(capEffort('weird', 'high'), 'weird');
});

test('host transport sends the request through OneCLI stdin and returns a validated answer', async () => {
  const envelope = JSON.stringify({ orchestrateOnecli: 1, ok: true, status: 200, body: JSON.stringify(answer) });
  const fake = fakeSpawn({ stdout: `onecli diagnostic\n${envelope}\n` });
  const out = await requestSystemOne(requestBody(), {
    env: { HTTPS_PROXY: 'http://unused.invalid', NODE_USE_ENV_PROXY: '0' },
    spawnImpl: fake.spawnImpl,
    existsSync: () => false,
    timeoutMs: 1000,
  });
  assert.deepEqual(out, answer);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.command, 'onecli');
  assert.deepEqual(call.args.slice(0, 2), ['run', '--']);
  assert.equal(call.args.some((arg) => arg.includes('synthetic transport test')), false);
  assert.equal(call.options.env.ORCHESTRATE_ONECLI_TRANSPORT, '1');
  const wire = JSON.parse(call.input);
  assert.equal(wire.body.state.task_brief, 'synthetic transport test');
  assert.equal(Number.isInteger(wire.deadline), true);
  assert.equal(wire.timeoutMs, undefined);
});

test('the real helper and parent parser agree on the stdin/envelope wire contract', async () => {
  const helperPreload = fileURLToPath(new URL('./dispatch-fetch-preload.fixture.mjs', import.meta.url));
  const spawnImpl = (command, args, options) => {
    assert.equal(command, 'onecli');
    assert.deepEqual(args.slice(0, 3), ['run', '--', process.execPath]);
    return spawn(process.execPath, ['--import', helperPreload, args[3], args[4]], options);
  };
  const out = await requestSystemOne(requestBody('synthetic helper wire task'), {
    env: {}, spawnImpl, existsSync: () => false, timeoutMs: 15000,
  });
  assert.deepEqual(out, answer);
});

test('an inherited API key stays on the direct path without spawning OneCLI', async () => {
  let options;
  const out = await requestSystemOne(requestBody(), {
    env: { TYPESAFE_API_KEY: 'test-only-key' },
    fetchImpl: async (_url, value) => { options = value; return response(answer); },
    spawnImpl: () => { throw new Error('must not spawn'); },
  });
  assert.deepEqual(out, answer);
  assert.equal(options.headers.Authorization, 'Bearer test-only-key');
});

test('an inherited native HTTPS proxy stays scoped and avoids the host OneCLI agent', async () => {
  let called = 0;
  const out = await requestSystemOne(requestBody(), {
    env: { HTTPS_PROXY: 'http://test.invalid', NODE_USE_ENV_PROXY: '1' },
    fetchImpl: async () => { called++; return response(answer); },
    spawnImpl: () => { throw new Error('must not spawn'); },
  });
  assert.deepEqual(out, answer);
  assert.equal(called, 1);
});

test('the OneCLI helper marker prevents recursive wrapping', async () => {
  let called = 0;
  await requestSystemOne(requestBody(), {
    env: { ORCHESTRATE_ONECLI_TRANSPORT: '1' },
    fetchImpl: async () => { called++; return response(answer); },
    spawnImpl: () => { throw new Error('must not spawn'); },
  });
  assert.equal(called, 1);
});

test('an unscoped fleet container cannot borrow the host default OneCLI identity', async () => {
  for (const options of [
    { env: {}, existsSync: (marker) => marker === '/.dockerenv' },
    { env: { NANOCLAW_ASSISTANT_NAME: 'synthetic-agent' }, existsSync: () => false },
  ]) {
    await assert.rejects(
      requestSystemOne(requestBody(), {
        ...options,
        spawnImpl: () => { throw new Error('must not spawn'); },
      }),
      { message: 'OneCLI host transport unavailable in container' },
    );
  }
});

test('invalid request payloads are rejected before any network or subprocess call', async () => {
  let spawned = 0;
  await assert.rejects(
    requestSystemOne({ model: 'different-model' }, {
      env: {},
      existsSync: () => false,
      spawnImpl: () => { spawned++; throw new Error('must not spawn'); },
    }),
    { message: 'invalid TypeSafe request' },
  );
  assert.equal(spawned, 0);
});

test('a timeout settles and releases the OneCLI subprocess even when close never arrives', async () => {
  const fake = fakeSpawn({ hang: true, closeOnKill: false });
  let watchdog;
  await assert.rejects(
    Promise.race([
      requestSystemOne(requestBody(), {
        env: {}, spawnImpl: fake.spawnImpl, existsSync: () => false, timeoutMs: 15,
      }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('test watchdog fired')), 100); }),
    ]).finally(() => clearTimeout(watchdog)),
    /TypeSafe request timed out/,
  );
  assert.equal(fake.wasKilled(), true);
  assert.equal(fake.wasUnrefed(), true);
  assert.equal(fake.calls[0].child.stdin.destroyed, true);
  assert.equal(fake.calls[0].child.stdout.destroyed, true);
  assert.equal(fake.calls[0].child.stderr.destroyed, true);
});

test('oversized output settles immediately with the correct reason even when close never arrives', async () => {
  const fake = fakeSpawn({
    stdout: 'x'.repeat(1024 * 1024 + 1), closeOnKill: false, emitClose: false,
  });
  let watchdog;
  await assert.rejects(
    Promise.race([
      requestSystemOne(requestBody(), {
        env: {}, spawnImpl: fake.spawnImpl, existsSync: () => false, timeoutMs: 1000,
      }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('test watchdog fired')), 100); }),
    ]).finally(() => clearTimeout(watchdog)),
    { message: 'invalid OneCLI transport response' },
  );
  assert.equal(fake.wasKilled(), true);
  assert.equal(fake.wasUnrefed(), true);
  assert.equal(fake.calls[0].child.stdin.destroyed, true);
  assert.equal(fake.calls[0].child.stdout.destroyed, true);
  assert.equal(fake.calls[0].child.stderr.destroyed, true);
});

test('an absent OneCLI binary fails closed to picker-unavailable without diagnostics', async () => {
  const fake = fakeSpawn({ error: Object.assign(new Error('sensitive path'), { code: 'ENOENT' }) });
  await assert.rejects(
    requestSystemOne(requestBody(), { env: {}, spawnImpl: fake.spawnImpl, existsSync: () => false }),
    { message: 'OneCLI transport unavailable' },
  );
});

test('transport failure remains a fail-open unavailable picker decision', async () => {
  const out = await pick('synthetic fail-open task', 'codex', {
    rubric,
    requestImpl: async () => { throw new Error('OneCLI transport unavailable'); },
  });
  assert.equal(out.decision, 'unavailable');
  assert.equal(out.pick, null);
  assert.equal(out.reason, 'OneCLI transport unavailable');
});

test('gateway denial never retries as a direct unauthenticated request', async () => {
  const envelope = JSON.stringify({ orchestrateOnecli: 1, ok: false, status: 403, body: 'do not expose' });
  const fake = fakeSpawn({ stdout: `${envelope}\n`, stderr: 'proxy details must stay discarded' });
  let directCalls = 0;
  await assert.rejects(
    requestSystemOne(requestBody(), {
      env: {},
      spawnImpl: fake.spawnImpl,
      existsSync: () => false,
      fetchImpl: async () => { directCalls++; return response(answer); },
    }),
    /TypeSafe HTTP 403/,
  );
  assert.equal(directCalls, 0);
});

test('malformed or failed wrapper output becomes a generic unavailable reason', async () => {
  for (const config of [
    { stdout: '{not-json}\n' },
    { stdout: `${JSON.stringify({ orchestrateOnecli: 1, ok: true, status: '200', body: '{}' })}\n` },
    { stdout: '', stderr: 'private diagnostic', code: 1 },
  ]) {
    const fake = fakeSpawn(config);
    await assert.rejects(
      requestSystemOne(requestBody(), { env: {}, spawnImpl: fake.spawnImpl, existsSync: () => false }),
      (err) => !err.message.includes('private diagnostic') && !err.message.includes('not-json'),
    );
  }
});

test('the same successful picker response resolves runtime-specific Claude and Codex routes', async () => {
  const requestImpl = async () => answer;
  const claude = await pick('implement a synthetic transport repair', 'claude', { rubric, requestImpl });
  const codex = await pick('implement a synthetic transport repair', 'codex', { rubric, requestImpl });
  assert.deepEqual([claude.decision, claude.pick.model, claude.pick.effort], ['route', 'opus', 'medium']);
  assert.deepEqual([codex.decision, codex.pick.model, codex.pick.effort], ['route', 'gpt-6.1-sol', 'medium']);
});
