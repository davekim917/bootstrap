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
  assert.equal(normalizeWhitespace('codex exec \\\n  --ephemeral\n --yolo'), 'codex exec --ephemeral --yolo');
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

function copiedContracts(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-contract-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = new URL('../../plugins/workflow/skills/', import.meta.url);
  const claudeRoot = path.join(root, 'claude');
  const agentRoot = path.join(root, 'agent');
  fs.cpSync(source, claudeRoot, { recursive: true });
  fs.cpSync(source, agentRoot, { recursive: true });
  return { claudeRoot, agentRoot };
}

for (const [name, file, from, to, expected] of [
  ['author-based diversity', 'shared/cross-model-review.md', 'artifact author, not the coordinator', 'coordinator only', 'artifact author'],
  ['runtime reviewer effort', 'shared/cross-model-review.md', '--effort medium', '--effort high', '--effort medium'],
  ['evidence invalidation', 'shared/workflow-contract.md', 'Invalidate affected evidence', 'Retain every result', 'Invalidate affected evidence'],
  ['productive repair budget', 'shared/workflow-contract.md', 'maximum of 3 corrective rounds', 'maximum of 1 corrective round', '3 corrective rounds'],
  ['scope continuity', 'shared/workflow-contract.md', 'Factual corrections and test-detail refinements do not reset authorization', 'Every edit requires new approval', 'do not reset authorization'],
]) {
  test(`contract gate rejects loss of ${name} even with identical runtime copies`, (t) => {
    const roots = copiedContracts(t);
    assert.equal(evaluateContracts(roots).pass, true);
    for (const root of Object.values(roots)) {
      const target = path.join(root, file);
      const original = fs.readFileSync(target, 'utf8');
      assert.ok(original.includes(from));
      fs.writeFileSync(target, original.replaceAll(from, to));
    }
    const result = evaluateContracts(roots);
    assert.equal(result.pass, false);
    assert.ok(result.failures.some((failure) => failure.includes(expected)), result.failures.join('\n'));
  });
}

test('contract gate rejects a reintroduced cheap worker ladder in both copies', (t) => {
  const roots = copiedContracts(t);
  for (const root of Object.values(roots)) {
    fs.appendFileSync(path.join(root, 'orchestrate/SKILL.md'), '\nUse worker-fast before worker-frontier.\n');
  }
  const result = evaluateContracts(roots);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((failure) => failure.includes('retired worker policy worker-fast')));
});
