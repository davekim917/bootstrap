import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { invocation, WORKER_CONTEXT } from './frontier-worker.mjs';

const helper = fileURLToPath(new URL('./frontier-worker.mjs', import.meta.url));
const session = '01234567-89ab-4cde-8fab-0123456789ab';

test('both runtimes default medium and explicit effort overrides stay local', () => {
  const parent = { PATH: process.env.PATH, CLAUDE_CODE_EFFORT_LEVEL: 'high' };
  for (const runtime of ['claude', 'codex']) {
    const spec = invocation(['--runtime', runtime, '--cwd', os.tmpdir()], parent);
    assert.match(spec.args.join(' '), /medium/);
    assert.match(spec.args.join(' '), runtime === 'claude' ? /claude-fable-5-1/ : /gpt-6-astra/);
    assert.doesNotMatch(spec.args.join(' '), /yolo|bypass|ignore-user|safe-mode|ephemeral/);
    const low = invocation(['--runtime', runtime, '--cwd', os.tmpdir(), '--effort', 'low', '--resume', session], parent);
    assert.match(low.args.join(' '), /low/);
    assert.ok(low.args.includes(session));
    assert.ok(!low.args.includes('--last'));
    if (runtime === 'claude') assert.equal(low.env.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  }
  assert.equal(parent.CLAUDE_CODE_EFFORT_LEVEL, 'high');
});

test('invalid choices and ambiguous resume fail before launch', () => {
  const base = ['--runtime', 'claude', '--cwd', os.tmpdir()];
  for (const extra of [
    ['--effort', 'ultra'], ['--effort', 'medium; touch /tmp/unwanted'],
    ['--resume', 'last'], ['--resume', '--last'], ['--timeout-seconds', '0'],
    ['--runtime', 'codex'], ['--yolo'], ['--effort'],
  ]) assert.throws(() => invocation([...base, ...extra]));
  assert.throws(() => invocation(['--runtime', 'other', '--cwd', os.tmpdir()]));
});

async function fakeWorker(t, { runtime = 'claude', extra = [], behavior = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-helper-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, runtime), `#!${process.execPath}\nlet prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{${behavior}console.log(JSON.stringify({argv:process.argv.slice(2),effort:process.env.CLAUDE_CODE_EFFORT_LEVEL,prompt,session_id:'${session}'}));});`, { mode: 0o700 });
  const child = spawn(process.execPath, [helper, '--runtime', runtime, '--cwd', dir, ...extra], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  child.stdin.end('A literal prompt with `backticks` and $(not-a-command).');
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, closed, dir };
}

test('foreground launch passes stdin literally, emits session metadata and preserves failure', async t => {
  const { closed } = await fakeWorker(t, { extra: ['--effort', 'low', '--resume', session], behavior: 'process.exitCode=7;' });
  const result = await closed;
  assert.equal(result.code, 7);
  const record = JSON.parse(result.stdout);
  assert.equal(record.effort, 'low');
  assert.equal(record.session_id, session);
  assert.ok(record.argv.includes(session));
  assert.ok(!record.argv.includes(record.prompt));
  assert.equal(record.prompt, WORKER_CONTEXT + 'A literal prompt with `backticks` and $(not-a-command).');
});

test('timeout reports failure instead of leaving the worker running', async t => {
  const { closed } = await fakeWorker(t, { extra: ['--timeout-seconds', '1'], behavior: 'setInterval(()=>{},1000);' });
  const result = await closed;
  assert.equal(result.code, 124);
  assert.match(result.stderr, /timed out/);
});

test('cancellation reaches the attached worker and exits nonzero', async t => {
  const { child, closed } = await fakeWorker(t, { behavior: "process.on('SIGTERM',()=>{console.error('child-stopped');process.exit(0)});setInterval(()=>{},1000);" });
  await new Promise(resolve => child.stdout.once('data', resolve));
  child.kill('SIGTERM');
  const result = await closed;
  assert.equal(result.code, 143);
  assert.match(result.stderr, /child-stopped/);
});

for (const cancellation of ['timeout', 'signal']) {
  test(`${cancellation} stops a descendant even when it ignores TERM and the CLI exits`, async t => {
    const behavior = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync('survived','yes'),1500);setInterval(()=>{},1000)"],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    const { child, closed, dir } = await fakeWorker(t, {
      extra: ['--timeout-seconds', '1'], behavior,
    });
    if (cancellation === 'signal') {
      await new Promise(resolve => child.stdout.once('data', resolve));
      // Let the descendant install its handler before cancelling the whole group.
      await new Promise(resolve => setTimeout(resolve, 100));
      child.kill('SIGTERM');
    }
    const result = await closed;
    assert.equal(result.code, cancellation === 'timeout' ? 124 : 143);
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(fs.existsSync(path.join(dir, 'survived')), false);
  });
}
