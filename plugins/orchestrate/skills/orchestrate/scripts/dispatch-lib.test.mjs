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

test('an explicit model is never replaced; a roleless spawn still gets the effort, capped to that model', () => {
  const out = rewriteClaudeSpawn({ model: 'fable', prompt: 'p' }, route('opus', 'xhigh'), rubric);
  assert.deepEqual([out.model, out.subagent_type], ['fable', 'bootstrap-orchestrate:worker-high']);
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
  const picked = { runtime: 'codex', decision: 'route', pick: { model: 'gpt-6-astra', effort: 'high' }, confidence: 0.99 };
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
  assert.deepEqual([codex.decision, codex.pick.model, codex.pick.effort], ['route', 'gpt-5.6-sol', 'medium']);
});
