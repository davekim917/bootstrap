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

/**
 * Build a fixture mirroring the real layout: two workflow trees with the seven
 * team skills and their copy of `shared/`, plus the ONE orchestrate tree — its
 * skill and, beside it, the five effort shims. The orchestrate plugin carries no
 * `shared/` and no scripts, so neither is staged here; a fixture that staged them
 * would let a gate pass against a layout that does not ship.
 */
function copiedContracts(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-contract-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflowSource = new URL('../../plugins/workflow/skills/', import.meta.url);
  const orchestrateSource = new URL('../../plugins/orchestrate/skills/', import.meta.url);
  const shimSource = new URL('../../plugins/orchestrate/agents/', import.meta.url);

  const claudeRoot = path.join(root, 'claude', 'skills');
  const agentRoot = path.join(root, 'agent', 'skills');
  const orchestrateRoot = path.join(root, 'orchestrate', 'skills');
  const orchestrateAgentsRoot = path.join(root, 'orchestrate', 'agents');

  for (const target of [claudeRoot, agentRoot]) {
    fs.cpSync(workflowSource, target, { recursive: true });
  }
  fs.cpSync(orchestrateSource, orchestrateRoot, { recursive: true });
  fs.cpSync(shimSource, orchestrateAgentsRoot, { recursive: true });
  return { claudeRoot, agentRoot, orchestrateRoot, orchestrateAgentsRoot };
}

/** The roots that carry `shared/` — the only ones a contract mutation can target. */
const sharedRootsOf = (roots) => [roots.claudeRoot, roots.agentRoot];

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
    for (const root of sharedRootsOf(roots)) {
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

test('contract gate rejects a named worker role reappearing in the orchestrate skill', (t) => {
  // `/orchestrate` names a model and an effort per dispatch. A skill that names a
  // ROLE instead has taken that choice back, and the five shims stop being shims.
  const roots = copiedContracts(t);
  assert.equal(evaluateContracts(roots).pass, true);
  fs.appendFileSync(path.join(roots.orchestrateRoot, 'orchestrate/SKILL.md'), '\nUse worker-fast before worker-frontier.\n');
  const result = evaluateContracts(roots);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((failure) => failure.includes('retired worker policy worker-fast')), result.failures.join('\n'));
  assert.ok(result.failures.some((failure) => failure.includes('retired worker policy worker-frontier')), result.failures.join('\n'));
});

test('contract gate rejects an effort shim that pins a model', (t) => {
  // The shim exists ONLY to pin an effort Claude's Agent tool cannot pass
  // per-call. A `model:` here would silently override what the dispatch asked
  // for — the caller would name a model and get a different one, with nothing
  // reporting the substitution.
  const roots = copiedContracts(t);
  assert.equal(evaluateContracts(roots).pass, true);
  const shim = path.join(roots.orchestrateAgentsRoot, 'worker-high.md');
  fs.writeFileSync(shim, fs.readFileSync(shim, 'utf8').replace('model: inherit', 'model: claude-opus-5'));
  const result = evaluateContracts(roots);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((failure) => failure.includes('model must be `inherit`')), result.failures.join('\n'));
});

test('contract gate rejects an effort shim that grows instructions', (t) => {
  const roots = copiedContracts(t);
  const shim = path.join(roots.orchestrateAgentsRoot, 'worker-medium.md');
  fs.appendFileSync(shim, '\nAlways write tests first.\nRead docs/review-notes.md before editing.\n');
  const result = evaluateContracts(roots);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((failure) => failure.includes('body must stay at most two lines')), result.failures.join('\n'));
});

test('contract gate rejects a missing effort level', (t) => {
  const roots = copiedContracts(t);
  fs.rmSync(path.join(roots.orchestrateAgentsRoot, 'worker-max.md'));
  const result = evaluateContracts(roots);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((failure) => failure.includes('worker-max.md')), result.failures.join('\n'));
});

test('EXPECTED_SKILLS and EXPECTED_ORCHESTRATE_SKILLS are disjoint', () => {
  const overlap = EXPECTED_SKILLS.filter((skill) => EXPECTED_ORCHESTRATE_SKILLS.includes(skill));
  assert.deepEqual(overlap, []);
});
