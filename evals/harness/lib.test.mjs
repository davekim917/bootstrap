import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// resolveSkillDir must resolve STRICTLY within the requested family — no cross-family
// fallback. A silent fallback would let a Claude baseline (prefer='workflow') evaluate the
// port instead of the original, masking a parity regression. BOOTSTRAP_PLUGINS_DIR is read
// at module-eval time, so import lib.mjs fresh (cache-busted) AFTER setting it.
test('resolveSkillDir: strict to requested family — no cross-family fallback (anti-masking)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
  const mk = (fam, name) => {
    const d = path.join(root, fam, 'skills', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), '# x');
    return d;
  };
  const portOnly = mk('workflow-agents', 'only-in-port');
  const bothW = mk('workflow', 'in-both');
  const bothC = mk('workflow-agents', 'in-both');
  process.env.BOOTSTRAP_PLUGINS_DIR = root;
  try {
    const { resolveSkillDir } = await import('./lib.mjs?strict=' + Date.now());
    // The masking hazard: a baseline asking for the ORIGINAL must NOT silently get the port.
    assert.equal(resolveSkillDir('only-in-port', 'workflow'), null, 'baseline must not fall back to the port');
    assert.equal(resolveSkillDir('only-in-port', 'workflow-agents'), portOnly, 'port resolves in its own family');
    assert.equal(resolveSkillDir('in-both', 'workflow'), bothW, 'baseline resolves the original');
    assert.equal(resolveSkillDir('in-both', 'workflow-agents'), bothC, 'port resolves the augmented copy');
    assert.equal(resolveSkillDir('does-not-exist', 'workflow-agents'), null, 'truly-missing skill ⇒ null');
  } finally {
    delete process.env.BOOTSTRAP_PLUGINS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
