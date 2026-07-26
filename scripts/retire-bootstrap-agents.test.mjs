import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  OWNERSHIP_MARKER,
  discoverRetiredAgents,
  runRetirement,
} from './retire-bootstrap-agents.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-retire-agents-'));
  const home = path.join(root, 'home');
  const stateRoot = path.join(root, 'quarantine');
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, stateRoot };
}

function writeAgent(home, relativePath, { managed = true, body = 'definition' } = {}) {
  const target = path.join(home, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = `${managed ? `${OWNERSHIP_MARKER}\n` : ''}${body}\n`;
  fs.writeFileSync(target, content);
  return { target, content };
}

const fixedNow = () => new Date('2026-07-26T12:34:56.789Z');

test('dry-run reports marker-owned retired agents without deleting or quarantining', (t) => {
  const { home, stateRoot } = fixture(t);
  const { target } = writeAgent(home, '.codex/agents/cpo-advisor.toml');

  const result = runRetirement({ home, stateRoot, now: fixedNow });

  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.targets.map((entry) => entry.source), [target]);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(stateRoot), false);
});

test('--apply quarantines with hash and full home-relative path before deletion', (t) => {
  const { home, stateRoot } = fixture(t);
  const { target, content } = writeAgent(home, '.codex/agents/security-reviewer.toml');

  const result = runRetirement({ home, stateRoot, apply: true, now: fixedNow });
  const quarantineCopy = path.join(
    result.quarantineRoot,
    '.codex',
    'agents',
    'security-reviewer.toml',
  );
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));

  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(quarantineCopy, 'utf8'), content);
  assert.deepEqual(manifest.files, [{
    source: target,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    quarantineRelativePath: path.join('.codex', 'agents', 'security-reviewer.toml'),
  }]);
});

test('re-running after apply is an idempotent no-op', (t) => {
  const { home, stateRoot } = fixture(t);
  writeAgent(home, '.claude/agents/architecture-advisor.md');

  const first = runRetirement({ home, stateRoot, apply: true, now: fixedNow });
  const second = runRetirement({ home, stateRoot, apply: true, now: fixedNow });

  assert.equal(first.removed.length, 1);
  assert.equal(second.removed.length, 0);
  assert.equal(second.quarantineRoot, null);
  assert.equal(fs.readdirSync(stateRoot).length, 1);
});

test('unmanaged retired-name collision and unrelated agents are preserved', (t) => {
  const { home, stateRoot } = fixture(t);
  const unmanaged = writeAgent(home, '.codex/agents/cpo-advisor.toml', { managed: false });
  const managedButNotRetired = writeAgent(home, '.codex/agents/product-advisor.toml');
  const unrelated = [
    'worker',
    'worker-codex',
    'worker-opus',
    'codex-rescue',
    'impeccable-frontend',
  ].map((name) => writeAgent(home, `.codex/agents/${name}.toml`));

  const result = runRetirement({ home, stateRoot, apply: true, now: fixedNow });

  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.unmanagedCollisions.map((entry) => entry.source), [unmanaged.target]);
  assert.equal(fs.existsSync(unmanaged.target), true);
  for (const agent of unrelated) assert.equal(fs.existsSync(agent.target), true);
  assert.equal(fs.existsSync(managedButNotRetired.target), true);
});

test('same basename in multiple active homes has collision-free quarantine paths', (t) => {
  const { home, stateRoot } = fixture(t);
  writeAgent(home, '.codex/agents/cto-advisor.toml', { body: 'default' });
  writeAgent(home, '.codex-client/agents/cto-advisor.toml', { body: 'client' });
  writeAgent(home, '.config/opencode/agent/cto-advisor.md', { body: 'opencode config' });
  writeAgent(home, '.local/share/opencode-kimi/agent/cto-advisor.md', { body: 'opencode data' });

  const result = runRetirement({ home, stateRoot, apply: true, now: fixedNow });

  assert.equal(result.removed.length, 4);
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(new Set(manifest.files.map((entry) => entry.quarantineRelativePath)).size, 4);
  for (const entry of manifest.files) {
    assert.equal(fs.existsSync(path.join(result.quarantineRoot, entry.quarantineRelativePath)), true);
  }
});

test('plugin caches are excluded even when they contain owned retired definitions', (t) => {
  const { home } = fixture(t);
  const cached = writeAgent(
    home,
    '.codex/plugins/cache/vendor/bootstrap/agents/performance-analyzer.toml',
  );
  const legacyCached = writeAgent(
    home,
    '.claude/plugins/cache/vendor/bootstrap/agents/performance-analyzer.md',
  );

  const discovery = discoverRetiredAgents({ home });

  assert.deepEqual(discovery.targets, []);
  assert.equal(fs.existsSync(cached.target), true);
  assert.equal(fs.existsSync(legacyCached.target), true);
});

test('ownership marker must occupy an exact line', (t) => {
  const { home } = fixture(t);
  const suffix = writeAgent(home, '.codex/agents/code-review-specialist.toml', {
    managed: false,
    body: `${OWNERSHIP_MARKER} old`,
  });

  const discovery = discoverRetiredAgents({ home });

  assert.deepEqual(discovery.targets, []);
  assert.deepEqual(discovery.unmanagedCollisions.map((entry) => entry.source), [suffix.target]);
});

test('apply preserves every active target when one changes after quarantine', (t) => {
  const { home, stateRoot } = fixture(t);
  const first = writeAgent(home, '.codex/agents/cpo-advisor.toml', { body: 'original' });
  const second = writeAgent(home, '.codex/agents/cto-advisor.toml', { body: 'unchanged' });

  assert.throws(
    () => runRetirement({
      home,
      stateRoot,
      apply: true,
      now: fixedNow,
      beforeRemove: () => fs.writeFileSync(first.target, `${OWNERSHIP_MARKER}\ncustomized\n`),
    }),
    /Refusing to remove changed target/,
  );

  assert.equal(fs.existsSync(first.target), true);
  assert.equal(fs.existsSync(second.target), true);
  assert.equal(fs.readFileSync(first.target, 'utf8').includes('customized'), true);
  const [quarantineName] = fs.readdirSync(stateRoot);
  assert.equal(fs.existsSync(path.join(stateRoot, quarantineName, 'manifest.json')), true);
});
