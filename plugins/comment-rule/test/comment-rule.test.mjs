import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkChange, checkFileAgainstHead, countTree } from '../lib/check.mjs';
import { editedFiles, feedbackMessage } from '../lib/feedback.mjs';
import { CommentRuleFeedback } from '../hooks/opencode-comment-rule.mjs';
import { prohibitedForms } from '../lib/forms.mjs';
import { languageOf, scanMany } from '../lib/scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const CLI = path.join(HERE, '..', 'bin', 'comment-rule.mjs');
const HOOK = path.join(HERE, '..', 'hooks', 'post-edit.mjs');

function commentLineNumbers(file, text) {
  const [result] = scanMany([{ file, text, language: languageOf(file, text) }]);
  assert.equal(result.error, undefined, result.error);
  return [...result.lines.keys()].map((line) => line + 1).sort((a, b) => a - b);
}

const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));
for (const [name, lines] of Object.entries(expected)) {
  test(`counts the comment lines of fixture ${name}`, () => {
    const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
    assert.deepEqual(commentLineNumbers(name, text), lines);
  });
}

test('SQL dialects set the extra line markers and backslash escapes', () => {
  const text = "select 1 # hash\nselect 2 // slash\nselect 'can\\'t -- text' -- real\nselect 'C:\\' -- ansi ends at the quote\n";
  const scan = (sqlDialect) => [...scanMany([{ file: 'q.sql', text, language: 'sql', sqlDialect }])[0].lines.keys()];
  assert.deepEqual(scan('ansi'), [2, 3]);
  assert.deepEqual(scan('snowflake'), [1, 2]);
  assert.deepEqual(scan('mysql'), [0, 2]);
  const bigquery = "select '''it's fine''' as v\n-- real\nselect \"\"\"a \\\"\"\" -- b\"\"\" as w\n";
  assert.deepEqual([...scanMany([{ file: 'b.sql', text: bigquery, language: 'sql', sqlDialect: 'bigquery' }])[0].lines.keys()], [1]);
  const mysql = 'select value--1 as adjusted\nselect 1 --\tspaced\nselect 2 --\n';
  assert.deepEqual([...scanMany([{ file: 'm.sql', text: mysql, language: 'sql', sqlDialect: 'mysql' }])[0].lines.keys()], [1, 2]);
});

test('a Python file the interpreter cannot parse is an error, never a partial count', () => {
  const [result] = scanMany([{ file: 'bad.py', text: '# note\ndef f(:\n    """doc"""\n', language: 'python' }]);
  assert.match(result.error, /unparsable/);
});

test('an unknown file type is not counted', () => {
  assert.equal(languageOf('notes.md', '# heading'), null);
  assert.equal(languageOf('config.yaml', '# comment'), null);
  assert.equal(languageOf('Makefile', '# comment'), null);
});

const CONTEXT = { ownOwner: 'acme', ticketPrefixes: ['ABC'] };

test('flags file:line citations', () => {
  for (const text of [
    '// see src/router.ts:42',
    '# handled in lib/check.mjs:10 already',
    '-- copied from models/orders.sql:7',
    '// Dockerfile:12 pins this',
    '// https://github.com/acme/app/blob/main/src/a.ts#L10',
  ]) {
    assert.ok(prohibitedForms(text, CONTEXT).includes('file-line-citation'), text);
  }
  for (const text of ['// listens on localhost:8080', '// image:1.3.14', '// at 12:30 UTC', '// ratio 16:9', '// see https://example.com:8443/a.ts']) {
    assert.ok(!prohibitedForms(text, CONTEXT).includes('file-line-citation'), text);
  }
});

test('flags PR, issue and ticket history', () => {
  for (const text of [
    '// fixed in PR #1234',
    '# see issue 57',
    '-- GH-812 regression',
    '// upstream owner/repo#99 changed this',
    '// bare reference #2241',
    '// ABC-123: follow-up',
    '// https://github.com/acme/app/pull/77',
  ]) {
    assert.ok(prohibitedForms(text, CONTEXT).includes('history-reference'), text);
  }
  for (const text of [
    '// argument #1 is the path',
    '// PKCS #11 token',
    '// color: #123',
    '// UTF-8 and SHA-256',
    '// https://github.com/other-org/lib/issues/12 documents the quirk',
    '#region setup',
  ]) {
    assert.ok(!prohibitedForms(text, CONTEXT).includes('history-reference'), text);
  }
});

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

const created = [];
test.after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepo(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-rule-'));
  created.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.hooksPath', '/dev/null');
  write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'change');
  return repo;
}

function write(repo, files) {
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(repo, file);
    if (text === null) {
      fs.rmSync(target);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

function commit(repo, files) {
  write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change');
}

test('net growth across the changed files fails; a balanced change passes', () => {
  const repo = makeRepo({ 'a.ts': '// one\nexport const a = 1;\n', 'b.py': '# two\nb = 2\n' });
  commit(repo, { 'a.ts': '// one\n// added\nexport const a = 1;\n' });
  let result = checkChange({ repo, base: 'main', head: 'HEAD' });
  assert.equal(result.status, 'fail');
  assert.equal(result.net, 1);
  assert.deepEqual(result.files[0].new_comment_lines, [{ line: 2, text: '// added' }]);
  commit(repo, { 'b.py': 'b = 2\n' });
  result = checkChange({ repo, base: 'main', head: 'HEAD' });
  assert.equal(result.status, 'pass');
  assert.equal(result.net, 0);
});

test('an added prohibited form fails even when the count shrinks; untouched history is not flagged', () => {
  const repo = makeRepo({ 'q.sql': '-- old note from PR #4321\n-- two\n-- three\nselect 1;\n' });
  commit(repo, { 'q.sql': '-- old note from PR #4321\n-- see models/x.sql:9\nselect 1;\n' });
  const result = checkChange({ repo, base: 'main', head: 'HEAD' });
  assert.equal(result.net, -1);
  assert.equal(result.status, 'fail');
  assert.deepEqual(
    result.files[0].findings.map(({ line, rule }) => [line, rule]),
    [[2, 'file-line-citation']],
  );
});

test('the working tree is the default head', () => {
  const repo = makeRepo({ 'run.sh': '#!/bin/sh\necho hi\n' });
  write(repo, { 'run.sh': '#!/bin/sh\n# new\necho hi\n' });
  const result = checkChange({ repo, base: 'main' });
  assert.equal(result.head, 'WORKTREE');
  assert.equal(result.net, 1);
});

test('frozen files never earn credit, excluded files never count, and the base config governs', () => {
  const repo = makeRepo({
    '.comment-rule.json': JSON.stringify({ frozen: ['migrations/*.sql'], exclude: ['generated/**'] }),
    'migrations/001.sql': '-- a\n-- b\nselect 1;\n',
    'src/x.ts': 'export const x = 1;\n',
  });
  commit(repo, {
    'migrations/001.sql': 'select 1;\n',
    'migrations/002.sql': '-- new migration note\nselect 2;\n',
    'generated/api.ts': '// generated\n// generated\nexport {};\n',
    'vendor/lib.ts': '// vendored\nexport {};\n',
    '.comment-rule.json': JSON.stringify({ frozen: ['migrations/*.sql'], exclude: ['generated/**', 'vendor/**'] }),
  });
  const result = checkChange({ repo, base: 'main', head: 'HEAD' });
  assert.deepEqual(
    result.files.map((file) => [file.path, file.net]),
    [
      ['migrations/002.sql', 1],
      ['vendor/lib.ts', 1],
    ],
  );
  assert.equal(result.status, 'fail');
});

test('the config comes from the base tip, even when it landed after the branch point, never from the head', () => {
  const repo = makeRepo({ 'src/x.ts': 'export const x = 1;\n' });
  git(repo, 'checkout', '-q', 'main');
  commit(repo, { '.comment-rule.json': JSON.stringify({ exclude: ['generated/**'] }) });
  git(repo, 'checkout', '-q', 'change');
  commit(repo, {
    'generated/api.ts': '// generated\nexport {};\n',
    'src/y.ts': '// narration\nexport {};\n',
    '.comment-rule.json': JSON.stringify({ exclude: ['generated/**', 'src/**'] }),
  });
  const result = checkChange({ repo, base: 'main', head: 'HEAD' });
  assert.deepEqual(result.files.map((file) => [file.path, file.net]), [['src/y.ts', 1]]);
});

test('a Python helper that never answers makes check exit 2 instead of hanging', () => {
  const repo = makeRepo({ 'a.py': 'a = 1\n' });
  commit(repo, { 'a.py': '# note\na = 1\n' });
  const hang = path.join(repo, 'hang.sh');
  fs.writeFileSync(hang, "#!/bin/sh\ntrap '' TERM\nexec sleep 600\n", { mode: 0o755 });
  const started = Date.now();
  const run = spawnSync(process.execPath, [CLI, 'check', '--repo', repo, '--base', 'main', '--head', 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env, COMMENT_RULE_PYTHON: hang, COMMENT_RULE_PYTHON_TIMEOUT_MS: '1000' },
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /could not check a\.py: python3 unavailable: no result within 1000 ms/);
  assert.ok(Date.now() - started < 10_000);
});

test('a rename compares the file with its old self', () => {
  const repo = makeRepo({ 'old/name.py': '"""Doc."""\n# note\nx = 1\ny = 2\nz = 3\n' });
  fs.mkdirSync(path.join(repo, 'new'));
  git(repo, 'mv', 'old/name.py', 'new/name.py');
  git(repo, 'commit', '-q', '-m', 'rename');
  const result = checkChange({ repo, base: 'main', head: 'HEAD' });
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.files.map((file) => [file.path, file.old_path, file.net]), [['new/name.py', 'old/name.py', 0]]);
});

test('a rename across languages scans each side with its own parser', () => {
  const repo = makeRepo({ 'a.sh': '# original\nx=1\n' });
  git(repo, 'mv', 'a.sh', 'a.py');
  git(repo, 'commit', '-q', '-m', 'rename');
  const result = checkChange({ repo, base: 'main', head: 'HEAD' });
  assert.equal(result.status, 'pass');
  assert.equal(result.net, 0);
});

test('an unreadable changed file is an error, never deletion credit', { skip: process.getuid?.() === 0 }, () => {
  const repo = makeRepo({ 'run.sh': '#!/bin/sh\n# one\necho hi\n' });
  write(repo, { 'run.sh': '#!/bin/sh\n# one\n# two\necho hi\n' });
  fs.chmodSync(path.join(repo, 'run.sh'), 0o000);
  try {
    assert.throws(() => checkChange({ repo, base: 'main' }), /EACCES/);
  } finally {
    fs.chmodSync(path.join(repo, 'run.sh'), 0o644);
  }
});

test('a submodule update and a directory replaced by a file are not read as source', () => {
  const repo = makeRepo({ 'd/a.ts': '// a\nexport {};\n' });
  const sha = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${sha},vendor/lib`);
  git(repo, 'commit', '-q', '-m', 'add gitlink');
  git(repo, 'update-index', '--cacheinfo', `160000,${git(repo, 'rev-parse', 'HEAD').trim()},vendor/lib`);
  git(repo, 'commit', '-q', '-m', 'move gitlink');
  assert.equal(checkChange({ repo, base: 'main', head: 'HEAD' }).status, 'pass');
  fs.rmSync(path.join(repo, 'd'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'd'), 'now a file\n');
  assert.deepEqual(countTree(repo).errors, []);
});

test('the CLI prints JSON and exits 1 on a failing change, 2 when it cannot check', () => {
  const repo = makeRepo({ 'a.js': 'const a = 1;\n' });
  commit(repo, { 'a.js': '// narration\nconst a = 1;\n' });
  const fail = spawnSync(process.execPath, [CLI, 'check', '--repo', repo, '--base', 'main', '--head', 'HEAD', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(fail.status, 1, fail.stderr);
  assert.equal(JSON.parse(fail.stdout).net, 1);
  const missing = spawnSync(process.execPath, [CLI, 'check', '--repo', repo, '--base', 'no-such-ref'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
});

test('--own-typescript never loads TypeScript from the checked repository', () => {
  const repo = makeRepo({ 'a.ts': 'export const a = 1;\n' });
  commit(repo, {
    'node_modules/typescript/index.js': 'module.exports = { createSourceFile() {} };\n',
    'a.ts': '// narration\nexport const a = 1;\n',
  });
  const run = (...flags) =>
    spawnSync(process.execPath, [CLI, 'check', '--repo', repo, '--base', 'main', '--head', 'HEAD', ...flags], { encoding: 'utf8' });
  const fromRepo = run();
  assert.equal(fromRepo.status, 2, fromRepo.stdout);
  assert.match(fromRepo.stdout, /could not check a\.ts/);
  const own = run('--own-typescript');
  assert.equal(own.status, 1, own.stdout);
  assert.match(own.stdout, /net \+1/);

  const nested = path.join(repo, 'checker');
  for (const dir of ['bin', 'lib']) fs.cpSync(path.join(HERE, '..', dir), path.join(nested, dir), { recursive: true });
  const installed = path.join(HERE, '..', 'node_modules');
  const fromNested = spawnSync(
    process.execPath,
    [path.join(nested, 'bin', 'comment-rule.mjs'), 'check', '--repo', repo, '--base', 'main', '--head', 'HEAD', '--own-typescript'],
    { encoding: 'utf8', env: { ...process.env, NODE_PATH: installed } },
  );
  assert.equal(fromNested.status, 1, fromNested.stdout);
});

test('an untracked file is new: every comment line in it is growth', () => {
  const repo = makeRepo({ 'keep.ts': 'export {};\n' });
  write(repo, { 'fresh.ts': '// a\n// b\nexport const f = 1;\n' });
  const result = checkFileAgainstHead(path.join(repo, 'fresh.ts'));
  assert.equal(result.net, 2);
  assert.equal(checkFileAgainstHead(path.join(repo, 'README.md')), null);
});

test('edited files come from Claude, OpenCode and apply_patch inputs', () => {
  const cwd = '/work/repo';
  assert.deepEqual(editedFiles({ file_path: '/work/repo/a.ts', old_string: 'x' }, cwd), ['/work/repo/a.ts']);
  assert.deepEqual(editedFiles({ filePath: 'b.py' }, cwd), ['/work/repo/b.py']);
  const patch = '*** Begin Patch\n*** Update File: src/c.sql\n@@\n-x\n+y\n*** Add File: notes.md\n+hi\n*** Update File: d.sh\n*** Move to: e.sh\n*** End Patch';
  assert.deepEqual(editedFiles({ command: patch }, cwd), ['/work/repo/src/c.sql', '/work/repo/d.sh', '/work/repo/e.sh']);
});

test('feedback names each new comment line once per session and never a shrinking file', () => {
  const grown = {
    key: '/r/a.ts',
    path: 'a.ts',
    base: 1,
    head: 3,
    net: 2,
    new_comment_lines: [
      { line: 2, text: '// b' },
      { line: 3, text: '// c' },
    ],
    findings: [],
  };
  const reported = new Map();
  const first = feedbackMessage([grown], reported);
  assert.match(first, /a\.ts: 3 comment lines, 2 more than HEAD/);
  assert.match(first, / {2}2: \/\/ b\n {2}3: \/\/ c/);
  assert.equal(feedbackMessage([grown], reported), null);
  const shrunk = { ...grown, key: '/r/b.ts', path: 'b.ts', net: -1 };
  assert.equal(feedbackMessage([shrunk], new Map()), null);
});

test('the post-edit hook returns additionalContext for a grown file and stays silent otherwise', () => {
  const repo = makeRepo({ 'a.ts': 'export const a = 1;\n', 'doc.md': 'x\n' });
  write(repo, { 'a.ts': '// see PR #5150 for why\nexport const a = 1;\n' });
  const run = (input) =>
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, TMPDIR: repo } });
  const grown = run({ session_id: 's1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.ts') } });
  assert.equal(grown.status, 0);
  const output = JSON.parse(grown.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PostToolUse');
  assert.match(output.additionalContext, /a\.ts: 1 comment lines, 1 more than HEAD/);
  assert.match(output.additionalContext, /a\.ts:1 history reference/);
  const codex = run({
    session_id: 's2',
    cwd: repo,
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: a.ts\n*** End Patch' },
  });
  assert.match(JSON.parse(codex.stdout).hookSpecificOutput.additionalContext, /a\.ts/);
  const markdown = run({ session_id: 's1', cwd: repo, tool_name: 'Write', tool_input: { file_path: path.join(repo, 'doc.md') } });
  assert.equal(markdown.stdout, '');
  const garbage = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});

test('the OpenCode module appends feedback once per session and never throws', async () => {
  const repo = makeRepo({ 'keep.ts': 'export {};\n' });
  write(repo, { 'q.ts': '// narration\nexport const q = 1;\n' });
  const hooks = await CommentRuleFeedback({ directory: repo });
  const edit = async (sessionID, args, tool = 'edit') => {
    const output = { title: '', output: 'done', metadata: {} };
    await hooks['tool.execute.after']({ tool, sessionID, callID: 'c', args }, output);
    return output.output;
  };
  assert.match(await edit('s1', { filePath: 'q.ts' }), /q\.ts: 1 comment lines, 1 more than HEAD/);
  assert.equal(await edit('s1', { filePath: 'q.ts' }), 'done');
  assert.match(await edit('s2', { patchText: '*** Begin Patch\n*** Update File: q.ts\n*** End Patch' }, 'apply_patch'), /q\.ts/);
  assert.equal(await edit('s3', null), 'done');
  assert.equal(await edit('s3', { filePath: 'q.ts' }, 'read'), 'done');
});

test('check counts the lines a change adds and those that hold nothing but comment', () => {
  const repo = makeRepo({
    'a.ts': 'export const a = 1;\n',
    'old.py': 'a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\ng = 7\nh = 8\n',
    'gone.sh': '# bye\necho bye\n',
  });
  commit(repo, {
    'a.ts': '// one\n/*\n\n * two\n */\nexport const a = 1;\nexport const b = 2; // trailing\n\n/* x */ export const c = 3;\n',
    'old.py': null,
    'new.py': 'a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\ng = 7\nh = 8\n"""Doc."""\n# note\ni = 9\n',
    'gone.sh': null,
  });
  const result = checkChange({ repo, base: 'main', head: 'HEAD' });
  const counts = Object.fromEntries(result.files.map((file) => [file.path, [file.added_lines, file.added_comment_lines]]));
  assert.deepEqual(counts, { 'a.ts': [8, 5], 'new.py': [3, 2], 'gone.sh': [0, 0] });
  assert.equal(result.files.find((file) => file.path === 'new.py').old_path, 'old.py');
});
