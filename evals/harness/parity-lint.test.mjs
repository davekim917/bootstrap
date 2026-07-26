import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EXPECTED_SKILLS,
  evaluateContracts,
  frontmatterFields,
  normalizeWhitespace,
  skillInventory,
} from './parity-lint.mjs';

test('normalizeWhitespace makes multiline command contracts comparable', () => {
  assert.equal(normalizeWhitespace('codex exec \\\n  --ephemeral\n --sandbox read-only'), 'codex exec --ephemeral --sandbox read-only');
});

test('skillInventory includes only directories with a top-level SKILL.md', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-contract-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'team-plan'), { recursive: true });
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'team-plan', 'SKILL.md'), 'body');
  fs.writeFileSync(path.join(root, 'shared', 'contract.md'), 'body');
  assert.deepEqual(skillInventory(root), ['team-plan']);
});

test('frontmatterFields requires a real opening frontmatter block', () => {
  assert.equal(frontmatterFields('body'), null);
  const fields = frontmatterFields('---\nname: team-plan\ndescription: Plan work\n---\nbody');
  assert.equal(fields.get('name'), 'team-plan');
  assert.equal(fields.get('description'), 'Plan work');
});

test('evaluateContracts rejects an extra public skill before other contract checks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-contract-extra-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeRoot = path.join(root, 'claude');
  const agentRoot = path.join(root, 'agent');
  for (const skill of [...EXPECTED_SKILLS, 'team-qa']) {
    for (const family of [claudeRoot, agentRoot]) {
      const directory = path.join(family, skill);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: test\n---\n`,
      );
    }
  }

  const result = evaluateContracts({ claudeRoot, agentRoot });

  assert.equal(result.pass, false);
  assert.equal(result.failures.some((failure) => failure.includes('expected exactly')), true);
  assert.equal(result.failures.some((failure) => failure.includes('retired skill directory remains: team-qa')), true);
});
