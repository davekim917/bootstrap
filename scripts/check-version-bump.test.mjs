import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkVersionBumps } from './check-version-bump.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-version-bump.mjs');

function marketplace(entries) {
  return JSON.stringify({ plugins: entries.map(([name, dir, version]) => ({ name, source: `./plugins/${dir}`, version })) });
}
function codexMarketplace(entries) {
  return JSON.stringify({
    plugins: entries.map(([name, dir, version]) => ({ name, source: { source: 'local', path: `./plugins/${dir}` }, version })),
  });
}
function manifest(version) {
  return JSON.stringify({ name: 'x', version });
}

function tree(version, { codex = true } = {}) {
  const files = {
    '.claude-plugin/marketplace.json': marketplace([['sample', 'sample', version]]),
    'plugins/sample/.claude-plugin/plugin.json': manifest(version),
  };
  if (codex) {
    files['.agents/plugins/marketplace.json'] = codexMarketplace([['sample', 'sample', version]]);
    files['plugins/sample/.codex-plugin/plugin.json'] = manifest(version);
  }
  return files;
}

function run(base, head, changedPaths) {
  return checkVersionBumps({
    changedPaths,
    read: (side, file) => (side === 'base' ? base : head)[file] ?? null,
  });
}

test('a hook change without any bump names every surface still at the old version', () => {
  const base = tree('1.0.0');
  const problems = run(base, { ...base }, ['plugins/sample/hooks/guard.ts']);
  assert.equal(problems.length, 4);
  for (const label of [
    'plugins/sample/.claude-plugin/plugin.json',
    'plugins/sample/.codex-plugin/plugin.json',
    '.claude-plugin/marketplace.json entry sample',
    '.agents/plugins/marketplace.json entry sample',
  ]) {
    assert.ok(problems.some((p) => p.includes(label) && p.includes('still 1.0.0')), label);
  }
});

test('a change bumped in every manifest and marketplace entry passes', () => {
  assert.deepEqual(run(tree('1.0.0'), tree('1.0.1'), ['plugins/sample/hooks/guard.ts']), []);
});

test('bumping the manifests but not a marketplace entry fails on that entry only', () => {
  const head = tree('1.0.1');
  head['.agents/plugins/marketplace.json'] = codexMarketplace([['sample', 'sample', '1.0.0']]);
  const problems = run(tree('1.0.0'), head, ['plugins/sample/skills/a/SKILL.md']);
  assert.ok(problems.some((p) => p.includes('.agents/plugins/marketplace.json entry sample') && p.includes('still 1.0.0')));
  assert.ok(problems.some((p) => p.includes('versions disagree')));
  assert.ok(!problems.some((p) => p.includes('.claude-plugin/plugin.json is still')));
});

test('a bump must be a valid, increasing MAJOR.MINOR.PATCH version', () => {
  const changed = ['plugins/sample/hooks/guard.ts'];
  for (const [head, pattern] of [
    ['0.0.1', /goes from 1\.0\.0 to 0\.0\.1; a bump must increase the version/],
    ['banana', /has version "banana", not MAJOR\.MINOR\.PATCH/],
    [undefined, /has version undefined, not MAJOR\.MINOR\.PATCH/],
  ]) {
    const problems = run(tree('1.0.0'), tree(head), changed);
    assert.ok(problems.some((p) => pattern.test(p)), `${head}: ${problems.join(' | ')}`);
  }
  assert.deepEqual(run(tree('1.9.9'), tree('1.10.0'), changed), []);
  assert.deepEqual(run(tree('1.0.0'), tree('2.0.0'), changed), []);
});

test('a brand-new plugin needs no bump', () => {
  const base = { '.claude-plugin/marketplace.json': marketplace([]) };
  assert.deepEqual(run(base, tree('0.1.0', { codex: false }), ['plugins/sample/.claude-plugin/plugin.json']), []);
});

test('changes outside plugins/ and to unlisted plugin dirs need no bump', () => {
  const base = tree('1.0.0');
  assert.deepEqual(run(base, { ...base }, ['scripts/check-parity.mjs', 'plugins/tools/x.mjs']), []);
});

test('the CLI fails a guard edit without a bump in a real repo, passes once bumped, and counts a move out of a plugin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-bump-'));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  const write = (files) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
  };
  try {
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-version-bump.mjs'));
    write({ ...tree('1.0.0'), 'plugins/sample/hooks/guard.ts': 'export {}\n' });
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'pr');
    write({ 'plugins/sample/hooks/guard.ts': 'export const refuse = true;\n' });
    git('commit', '-q', '-am', 'guard change');

    const cli = () => spawnSync('node', ['scripts/check-version-bump.mjs', '--base', 'main'], { cwd: dir, env, encoding: 'utf8' });
    const red = cli();
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, /plugins\/sample changed but plugins\/sample\/\.claude-plugin\/plugin\.json is still 1\.0\.0/);

    write(tree('1.0.1'));
    git('commit', '-q', '-am', 'bump');
    const green = cli();
    assert.equal(green.status, 0, green.stdout + green.stderr);

    // A move out of the plugin is a change to it, even when git reports the move as a rename.
    git('checkout', '-q', '-b', 'move', 'main');
    fs.mkdirSync(path.join(dir, 'outside'));
    git('mv', 'plugins/sample/hooks/guard.ts', 'outside/guard.ts');
    git('commit', '-q', '-m', 'move');
    const moved = spawnSync('node', ['scripts/check-version-bump.mjs', '--base', 'main'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(moved.status, 1, moved.stdout + moved.stderr);
    assert.match(moved.stderr, /plugins\/sample changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
