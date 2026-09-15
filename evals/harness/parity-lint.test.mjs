import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EXPECTED_ORCHESTRATE_SKILLS,
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

test('evaluateContracts rejects orchestrate reappearing in a workflow tree', (t) => {
  // The whole point of the split: with `orchestrate` back in the workflow pair,
  // disabling bootstrap-orchestrate would not remove the skill.
  const roots = copiedContracts(t);
  assert.equal(evaluateContracts(roots).pass, true);
  for (const root of [roots.claudeRoot, roots.agentRoot]) {
    const directory = path.join(root, 'orchestrate');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'SKILL.md'),
      '---\nname: orchestrate\ndescription: test\n---\n',
    );
  }
  const result = evaluateContracts(roots);
  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some((failure) => failure.includes('expected exactly') && failure.includes('orchestrate')),
    result.failures.join('\n'),
  );
});

test('evaluateContracts rejects an orchestrate plugin missing the shared contract', (t) => {
  // A cross-plugin `../shared/workflow-contract.md` would resolve in this
  // checkout and be absent on an installed cache. The gate has to notice the
  // absence, not just compare bytes when the file happens to be there.
  const roots = copiedContracts(t);
  fs.rmSync(path.join(roots.orchestrateClaudeRoot, 'shared', 'workflow-contract.md'));
  const result = evaluateContracts(roots);
  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some((failure) =>
      failure.includes('Claude/orchestrate') && failure.includes('workflow-contract.md')),
    result.failures.join('\n'),
  );
});

test('evaluateContracts rejects a drifted orchestrate copy of the shared contract', (t) => {
  const roots = copiedContracts(t);
  const target = path.join(roots.orchestrateAgentRoot, 'shared', 'workflow-contract.md');
  fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8')}\nan extra local rule\n`);
  const result = evaluateContracts(roots);
  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some((failure) => failure.includes('byte-identical to the canonical copy')),
    result.failures.join('\n'),
  );
});

test('evaluateContracts rejects an orchestrate plugin with no frontier-worker mirror', (t) => {
  const roots = copiedContracts(t);
  fs.rmSync(path.join(roots.orchestrateClaudeRoot, '..', 'scripts', 'frontier-worker.mjs'));
  const result = evaluateContracts(roots);
  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some((failure) => failure.includes('frontier-worker.mjs is missing')),
    result.failures.join('\n'),
  );
});

/**
 * Build a four-root fixture mirroring the real layout: two workflow trees with
 * the seven team skills and the canonical `shared/`, and two orchestrate trees
 * with `orchestrate/` plus their own copy of `shared/` and a plugin-local
 * `scripts/frontier-worker.mjs` beside the skills root.
 */
function copiedContracts(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-contract-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflowSource = new URL('../../plugins/workflow/skills/', import.meta.url);
  const orchestrateSource = new URL('../../plugins/orchestrate/skills/', import.meta.url);
  const helperSource = new URL('../../plugins/workflow/scripts/frontier-worker.mjs', import.meta.url);

  const claudeRoot = path.join(root, 'claude', 'skills');
  const agentRoot = path.join(root, 'agent', 'skills');
  const orchestrateClaudeRoot = path.join(root, 'orchestrate-claude', 'skills');
  const orchestrateAgentRoot = path.join(root, 'orchestrate-agent', 'skills');

  for (const target of [claudeRoot, agentRoot]) {
    fs.cpSync(workflowSource, target, { recursive: true });
  }
  for (const target of [orchestrateClaudeRoot, orchestrateAgentRoot]) {
    fs.cpSync(orchestrateSource, target, { recursive: true });
    const scripts = path.join(target, '..', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.cpSync(helperSource, path.join(scripts, 'frontier-worker.mjs'));
  }
  return { claudeRoot, agentRoot, orchestrateClaudeRoot, orchestrateAgentRoot };
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
  for (const root of [roots.orchestrateClaudeRoot, roots.orchestrateAgentRoot]) {
    fs.appendFileSync(path.join(root, 'orchestrate/SKILL.md'), '\nUse worker-fast before worker-frontier.\n');
  }
  const result = evaluateContracts(roots);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((failure) => failure.includes('retired worker policy worker-fast')));
});

test('EXPECTED_SKILLS and EXPECTED_ORCHESTRATE_SKILLS are disjoint', () => {
  const overlap = EXPECTED_SKILLS.filter((skill) => EXPECTED_ORCHESTRATE_SKILLS.includes(skill));
  assert.deepEqual(overlap, []);
});
