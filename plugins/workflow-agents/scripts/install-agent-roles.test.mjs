import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { execFileSync } from 'node:child_process';

import { ROLES_DIR, OWNERSHIP_MARKER, applyPlan, install, managerOf, plan, planOne } from './install-agent-roles.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const NANOCLAW_MARKER = '# managed by nanoclaw codex-sync';

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-agent-roles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roles = path.join(dir, 'roles');
  const codexHome = path.join(dir, 'codex');
  fs.mkdirSync(roles, { recursive: true });
  fs.writeFileSync(path.join(roles, 'worker-frontier.toml'), `${OWNERSHIP_MARKER}\n\nname = "worker-frontier"\n`);
  return { roles, codexHome, agents: path.join(codexHome, 'agents') };
}

test('the shipped roles carry this plugin as their manager', () => {
  const files = fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith('.toml'));
  assert.ok(files.includes('worker-frontier.toml'));
  for (const file of files) {
    assert.equal(managerOf(fs.readFileSync(path.join(ROLES_DIR, file), 'utf8')), OWNERSHIP_MARKER);
  }
});

test('a missing target is created and a second run is a no-op', (t) => {
  const { roles, codexHome, agents } = sandbox(t);
  assert.deepEqual(
    install({ rolesDir: roles, codexHome, apply: true }).items.map((i) => i.action),
    ['create'],
  );
  assert.equal(
    fs.readFileSync(path.join(agents, 'worker-frontier.toml'), 'utf8'),
    fs.readFileSync(path.join(roles, 'worker-frontier.toml'), 'utf8'),
  );
  assert.deepEqual(plan({ rolesDir: roles, codexHome }).items.map((i) => i.action), ['unchanged']);
});

test('our own stale file is updated in place', (t) => {
  const { roles, codexHome, agents } = sandbox(t);
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'worker-frontier.toml'), `${OWNERSHIP_MARKER}\n\nname = "stale"\n`);
  assert.deepEqual(install({ rolesDir: roles, codexHome, apply: true }).items.map((i) => i.action), ['update']);
  assert.match(fs.readFileSync(path.join(agents, 'worker-frontier.toml'), 'utf8'), /worker-frontier/);
});

test("another manager's file is refused and left byte-identical, even with --apply", (t) => {
  const { roles, codexHome, agents } = sandbox(t);
  fs.mkdirSync(agents, { recursive: true });
  const theirs = `${NANOCLAW_MARKER}\n\nname = "worker-frontier"\nmodel = "gpt-5.6-sol"\n`;
  const target = path.join(agents, 'worker-frontier.toml');
  fs.writeFileSync(target, theirs);

  const result = install({ rolesDir: roles, codexHome, apply: true });
  assert.deepEqual(result.items.map((i) => i.action), ['refuse']);
  assert.match(result.items[0].reason, /another manager/);
  assert.match(result.items[0].reason, /nanoclaw codex-sync/);
  assert.equal(fs.readFileSync(target, 'utf8'), theirs, 'refused target must not be written');
});

test('a hand-written file with no marker is refused, not adopted', (t) => {
  const { roles, codexHome, agents } = sandbox(t);
  fs.mkdirSync(agents, { recursive: true });
  const target = path.join(agents, 'worker-frontier.toml');
  fs.writeFileSync(target, 'name = "worker-frontier"\n');

  const result = install({ rolesDir: roles, codexHome, apply: true });
  assert.deepEqual(result.items.map((i) => i.action), ['refuse']);
  assert.match(result.items[0].reason, /hand-written/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'name = "worker-frontier"\n');
});

test('marker detection reads line 1 only and tolerates CRLF', () => {
  assert.equal(managerOf(`${OWNERSHIP_MARKER}\r\nname = "x"\n`), OWNERSHIP_MARKER);
  // A marker further down the file does not make the file managed: a manager
  // writes its marker first, and anything else is someone's hand-written role.
  assert.equal(managerOf(`name = "x"\n${OWNERSHIP_MARKER}\n`), null);
  assert.equal(managerOf('# just a comment\nname = "x"\n'), null);
});

test('identical content is unchanged regardless of who marked it', () => {
  const desired = `${OWNERSHIP_MARKER}\nname = "x"\n`;
  assert.equal(planOne({ name: 'x.toml', desired, current: desired }).action, 'unchanged');
});

test('an unreadable existing file is refused, never treated as absent', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('running as root: mode 000 is still readable');
    return;
  }
  const { roles, codexHome, agents } = sandbox(t);
  fs.mkdirSync(agents, { recursive: true });
  const target = path.join(agents, 'worker-frontier.toml');
  const theirs = `${NANOCLAW_MARKER}\n\nname = "worker-frontier"\n`;
  fs.writeFileSync(target, theirs);
  fs.chmodSync(target, 0o000);
  t.after(() => {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* already removed with the sandbox */
    }
  });

  const result = install({ rolesDir: roles, codexHome, apply: true });
  assert.deepEqual(result.items.map((i) => i.action), ['refuse']);
  assert.match(result.items[0].reason, /EACCES|cannot be read/);
  fs.chmodSync(target, 0o600);
  assert.equal(fs.readFileSync(target, 'utf8'), theirs, 'an unreadable target must not be truncated');
});

/**
 * The gap between plan and apply is the dangerous one: NanoClaw's
 * syncCodexSubagents writes this exact filename, and first setup is when both
 * managers run. The plan says `create`; by the time we write, the file exists
 * and belongs to someone else.
 */
test('a foreign file appearing between plan and apply is refused, not truncated', (t) => {
  const { roles, codexHome, agents } = sandbox(t);
  const planned = plan({ rolesDir: roles, codexHome });
  assert.deepEqual(planned.items.map((i) => i.action), ['create']);

  // ── the interleaving: the other manager wins the race ──
  fs.mkdirSync(agents, { recursive: true });
  const target = path.join(agents, 'worker-frontier.toml');
  const theirs = `${NANOCLAW_MARKER}\n\nname = "worker-frontier"\nmodel = "gpt-5.6-sol"\n`;
  fs.writeFileSync(target, theirs);

  const applied = applyPlan(planned);
  assert.deepEqual(applied.items.map((i) => i.action), ['refuse']);
  assert.match(applied.items[0].reason, /another manager/);
  assert.equal(fs.readFileSync(target, 'utf8'), theirs, 'the foreign file must survive byte-for-byte');
});

test('our own file appearing between plan and apply is updated, not duplicated', (t) => {
  const { roles, codexHome, agents } = sandbox(t);
  const planned = plan({ rolesDir: roles, codexHome });
  assert.deepEqual(planned.items.map((i) => i.action), ['create']);

  fs.mkdirSync(agents, { recursive: true });
  const target = path.join(agents, 'worker-frontier.toml');
  fs.writeFileSync(target, `${OWNERSHIP_MARKER}\n\nname = "stale"\n`);

  const applied = applyPlan(planned);
  assert.deepEqual(applied.items.map((i) => i.action), ['update']);
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    fs.readFileSync(path.join(roles, 'worker-frontier.toml'), 'utf8'),
  );
});

test('an update leaves no temp file behind, on success or on failure', (t) => {
  const { roles, codexHome, agents } = sandbox(t);
  fs.mkdirSync(agents, { recursive: true });
  const target = path.join(agents, 'worker-frontier.toml');
  const stale = `${OWNERSHIP_MARKER}\n\nname = "stale"\n`;
  fs.writeFileSync(target, stale);

  // Failure: the rename throws after the temp file is written.
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('boom');
  });
  assert.throws(() => install({ rolesDir: roles, codexHome, apply: true }), /boom/);
  assert.deepEqual(
    fs.readdirSync(agents).filter((f) => f.endsWith('.tmp')),
    [],
    'the temp file must be cleaned up when the rename fails',
  );
  assert.equal(fs.readFileSync(target, 'utf8'), stale, 'a failed update must not touch the target');

  // Success: same again with rename restored.
  t.mock.restoreAll();
  assert.deepEqual(install({ rolesDir: roles, codexHome, apply: true }).items.map((i) => i.action), ['update']);
  assert.deepEqual(fs.readdirSync(agents), ['worker-frontier.toml']);
});

/**
 * The packaging boundary, exercised for real. A marketplace install
 * materializes ONLY `plugins/workflow-agents/`, so running the installer from a
 * copy of just that directory proves every runtime import resolves inside the
 * package. An import reaching up into the repo (as `../../../scripts/...` did)
 * dies here with ERR_MODULE_NOT_FOUND while passing every in-checkout test.
 */
test('the installer runs from a copy of the plugin directory alone', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-only-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packaged = path.join(dir, 'workflow-agents');
  fs.cpSync(PLUGIN_ROOT, packaged, { recursive: true });
  assert.ok(!fs.existsSync(path.join(dir, 'scripts')), 'the repo-level scripts/ is not part of the package');

  const codexHome = path.join(dir, 'codex');
  const script = path.join(packaged, 'scripts', 'install-agent-roles.mjs');

  const dryRun = execFileSync(process.execPath, [script, '--codex-home', codexHome], { encoding: 'utf8' });
  assert.match(dryRun, /create\s+worker-frontier\.toml/);
  assert.ok(!fs.existsSync(path.join(codexHome, 'agents', 'worker-frontier.toml')), 'dry run must not write');

  execFileSync(process.execPath, [script, '--apply', '--codex-home', codexHome], { encoding: 'utf8' });
  assert.equal(
    fs.readFileSync(path.join(codexHome, 'agents', 'worker-frontier.toml'), 'utf8'),
    fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', 'worker-frontier.toml'), 'utf8'),
  );
});

/**
 * The boundary again, for every shipped module rather than one entry point's
 * import graph. Running the installer only proves what the installer reaches;
 * `codex-agent-toml.mjs` escaped the package while that test stayed green,
 * because nothing at runtime imports it. A module that cannot be imported after
 * a marketplace install is a trap whether or not today's code path hits it.
 */
test('no module shipped in the plugin imports outside the plugin', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-imports-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packaged = path.join(dir, 'workflow-agents');
  fs.cpSync(PLUGIN_ROOT, packaged, { recursive: true });

  const modules = fs
    .readdirSync(packaged, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs'))
    .map((e) => path.join(e.parentPath, e.name));
  assert.ok(modules.length >= 3, `expected the plugin to ship modules; found ${modules.length}`);

  for (const file of modules) {
    const rel = path.relative(packaged, file);
    for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(/^import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
      const resolved = path.resolve(path.dirname(file), spec);
      assert.ok(
        resolved === packaged || resolved.startsWith(`${packaged}${path.sep}`),
        `${rel} imports ${spec}, which resolves outside the packaged plugin`,
      );
    }

    // Resolution is not enough — the target must actually load from the copy,
    // AND loading it must leave its importer alive. Importing in-process hid
    // that second half: `session-install-roles.mjs` called `process.exit(0)` at
    // top level, so importing it here ended the test runner at exit code 0 and
    // every later assertion was reported as a pass it never ran. A module that
    // does its work (or exits) on import is a trap for anything that loads it,
    // so the import happens in a child that has to survive and say so.
    const probe = `await import(${JSON.stringify(`file://${file}`)}); process.stdout.write('alive');`;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      // Point CODEX_HOME into the sandbox: if a module ever does run its work
      // on import, it writes here instead of the developer's real Codex home.
      env: { ...process.env, CODEX_HOME: path.join(dir, 'codex-home-sentinel') },
    });
    assert.equal(stdout, 'alive', `importing ${rel} must not run work or terminate its importer`);
  }
});
