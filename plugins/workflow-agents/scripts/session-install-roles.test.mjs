/**
 * The bare-machine test for the SessionStart role installer.
 *
 * What went wrong last time: a test mirrored the code's own shape and nobody
 * exercised a real install, so a broken path shipped green. Everything here is
 * therefore driven from artifacts rather than from constants this file chooses:
 *
 *   - the command text comes out of `hooks/workflow-hooks.json`, so renaming
 *     the script without updating the manifest fails here;
 *   - the plugin is copied to a temp directory ALONE, exactly as a marketplace
 *     install materializes it, so any import or path reaching into the repo
 *     dies here;
 *   - `CODEX_HOME` points at an empty directory, so the assertion is about a
 *     role file that did not exist a moment ago;
 *   - the assertion reads the installed file's bytes and its `model` line,
 *     not whether some function was called.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { execFileSync } from 'node:child_process';

import { OWNERSHIP_MARKER } from './ownership.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NANOCLAW_MARKER = '# managed by nanoclaw codex-sync';
const ROLE = 'worker-frontier.toml';

/** The exact command Codex will run, with `${PLUGIN_ROOT}` pointed at `root`. */
function sessionStartCommand(root) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'hooks', 'workflow-hooks.json'), 'utf8'),
  );
  const entries = manifest.hooks?.SessionStart ?? [];
  const commands = entries
    .flatMap((entry) => entry.hooks ?? [])
    .filter((hook) => hook.type === 'command')
    .map((hook) => hook.command);
  assert.equal(commands.length, 1, 'expected exactly one SessionStart command in the hook manifest');
  return commands[0].replaceAll('${PLUGIN_ROOT}', root);
}

/** A copy of ONLY `plugins/workflow-agents/`, plus an empty CODEX_HOME. */
function bareMachine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-install-roles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packaged = path.join(dir, 'workflow-agents');
  fs.cpSync(PLUGIN_ROOT, packaged, { recursive: true });
  assert.ok(!fs.existsSync(path.join(dir, 'scripts')), 'the repo-level scripts/ is not part of the package');

  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(codexHome);
  assert.deepEqual(fs.readdirSync(codexHome), [], 'CODEX_HOME must start empty');
  return { dir, packaged, codexHome, role: path.join(codexHome, 'agents', ROLE) };
}

/** Run the hook the way Codex does: its command string, through a shell. */
function fireSessionStart({ packaged, codexHome }) {
  const result = execFileSync('bash', ['-c', sessionStartCommand(packaged)], {
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'test', permission_mode: 'default', transcript_path: null }),
  });
  return result;
}

test('a bare install puts a usable worker-frontier role in an empty CODEX_HOME', (t) => {
  const machine = bareMachine(t);

  const stdout = fireSessionStart(machine);
  assert.equal(stdout, '', 'the happy path must be silent on stdout');

  const installed = fs.readFileSync(machine.role, 'utf8');

  // The content, not the call. A role Codex cannot dispatch is not an install.
  assert.equal(installed.split('\n', 1)[0], OWNERSHIP_MARKER);
  assert.match(installed, /^name = "worker-frontier"$/m);
  assert.match(installed, /^model = "gpt-5\.6-sol"$/m);
  assert.match(installed, /^description = "/m);
  assert.match(installed, /^developer_instructions = """$/m);

  // And it is the shipped role verbatim, so a generator change cannot silently
  // install something else.
  assert.equal(installed, fs.readFileSync(path.join(machine.packaged, 'agents', ROLE), 'utf8'));
});

test('a second session start writes nothing at all', (t) => {
  const machine = bareMachine(t);
  fireSessionStart(machine);

  const before = fs.statSync(machine.role);
  const content = fs.readFileSync(machine.role, 'utf8');

  const stdout = fireSessionStart(machine);
  assert.equal(stdout, '', 'the no-op path must be silent too');

  const after = fs.statSync(machine.role);
  // An update swaps a fresh file in by rename, so a rewrite changes the inode.
  assert.equal(after.ino, before.ino, 'a no-op run must not replace the file');
  assert.equal(after.mtimeMs, before.mtimeMs, 'a no-op run must not touch the file');
  assert.equal(fs.readFileSync(machine.role, 'utf8'), content);
});

test("another manager's role is refused silently, byte-for-byte, and the session still starts", (t) => {
  const machine = bareMachine(t);
  fs.mkdirSync(path.dirname(machine.role), { recursive: true });
  const theirs = `${NANOCLAW_MARKER}\n\nname = "worker-frontier"\nmodel = "gpt-5.6-sol"\n`;
  fs.writeFileSync(machine.role, theirs);
  const before = fs.statSync(machine.role);

  const stdout = fireSessionStart(machine); // throws on a non-zero exit
  assert.equal(stdout, '');
  assert.equal(fs.readFileSync(machine.role, 'utf8'), theirs, 'a foreign role must survive untouched');
  assert.equal(fs.statSync(machine.role).ino, before.ino);
});

test('a hand-written role with no marker is refused, not adopted', (t) => {
  const machine = bareMachine(t);
  fs.mkdirSync(path.dirname(machine.role), { recursive: true });
  const theirs = 'name = "worker-frontier"\nmodel = "gpt-5.6-sol"\n';
  fs.writeFileSync(machine.role, theirs);

  fireSessionStart(machine);
  assert.equal(fs.readFileSync(machine.role, 'utf8'), theirs);
});

test('an unwritable role directory ends the hook at exit 0, silently', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('running as root: a read-only directory is still writable');
    return;
  }
  const machine = bareMachine(t);
  fs.chmodSync(machine.codexHome, 0o500);
  t.after(() => {
    try {
      fs.chmodSync(machine.codexHome, 0o700);
    } catch {
      /* already removed with the sandbox */
    }
  });

  const stdout = fireSessionStart(machine);
  assert.equal(stdout, '', 'an unwritable home must not make the hook talk');
  assert.ok(!fs.existsSync(machine.role));
});

test('the hook manifest and the shipped script agree', (t) => {
  const machine = bareMachine(t);
  const command = sessionStartCommand(machine.packaged);
  const scriptPath = command.match(/"([^"]+\.mjs)"/)?.[1];
  assert.ok(scriptPath, `SessionStart command names no .mjs entry point: ${command}`);
  assert.ok(fs.existsSync(scriptPath), `${scriptPath} is not shipped in the package`);
  assert.ok(
    scriptPath.startsWith(`${machine.packaged}${path.sep}`),
    'the SessionStart entry point must resolve inside the plugin package',
  );
});
