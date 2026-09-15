import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  POLICY_PATH,
  applyAgentDefPolicy,
  claudeRunsOnSentence,
  loadWorkerPolicy,
  policyHelpSentence,
  policyProseTokens,
  renderPolicyModule,
  validateWorkerPolicy,
} from './worker-policy.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A structurally valid policy with values deliberately unlike the shipped one. */
const flipped = () => ({
  claude: {
    label: 'Fable 5.1',
    model: 'claude-fable-5-1[1m]',
    modelAliases: ['claude-fable-5-1'],
    effort: 'low',
    escalation: { label: 'Opus 5', model: 'claude-opus-5[1m]', modelAliases: ['claude-opus-5'], effort: 'high' },
  },
  codex: {
    label: 'GPT-6 Astra',
    model: 'gpt-6-astra',
    modelAliases: [],
    effort: 'low',
    escalation: { label: 'GPT-5.6 Sol', model: 'gpt-5.6-sol', modelAliases: [], effort: 'high' },
  },
});

test('the shipped policy file parses and validates', () => {
  const policy = loadWorkerPolicy(REPO);
  assert.equal(typeof policy.claude.model, 'string');
  assert.equal(typeof policy.codex.model, 'string');
});

test('validation rejects the mistakes a hand-edit actually makes', () => {
  const cases = [
    ['missing runtime', (p) => { delete p.codex; }, /codex/],
    ['unknown effort', (p) => { p.claude.effort = 'ludicrous'; }, /effort must be one of/],
    // `ultra` needs an explicit per-dispatch human instruction; as a policy
    // default it would make every dispatch fail that gate instead.
    ['ultra as a default', (p) => { p.codex.effort = 'ultra'; }, /must not be ultra/],
    ['empty model', (p) => { p.claude.model = ''; }, /model must be a non-empty string/],
    ['aliases not an array', (p) => { p.codex.modelAliases = 'gpt-6-astra'; }, /modelAliases must be an array/],
    ['id in two tiers', (p) => { p.claude.escalation.modelAliases = ['claude-fable-5-1[1m]']; }, /more than one tier/],
    ['same model both tiers', (p) => { p.codex.escalation.model = p.codex.model; }, /more than one tier/],
    ['missing escalation', (p) => { delete p.claude.escalation; }, /claude\.escalation must be an object/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const policy = flipped();
    mutate(policy);
    assert.throws(() => validateWorkerPolicy(policy), pattern, name);
  }
  assert.doesNotThrow(() => validateWorkerPolicy(flipped()));
});

test('the rendered module is valid ESM whose defaults follow the policy', async (t) => {
  const dir = fs.mkdtempSync(path.join(REPO, '.worker-policy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'worker-policy.generated.mjs');
  fs.writeFileSync(file, renderPolicyModule(flipped()));
  const mod = await import(`${file}?v=${Date.now()}`);

  assert.equal(mod.MODELS.claude.default, 'claude-fable-5-1[1m]');
  assert.equal(mod.MODELS.codex.default, 'gpt-6-astra');
  // Every id of both tiers is dispatchable; the default is one of them.
  assert.ok(mod.MODELS.claude.allowed.has('claude-opus-5'));
  assert.ok(mod.MODELS.claude.allowed.has('claude-fable-5-1[1m]'));
  assert.ok(!mod.MODELS.claude.allowed.has('claude-sonnet-5'));
  // Tier efforts follow the flip, aliases included.
  assert.equal(mod.defaultEffortFor('claude-fable-5-1'), 'low');
  assert.equal(mod.defaultEffortFor('claude-opus-5[1m]'), 'high');
  assert.equal(mod.defaultEffortFor('gpt-5.6-sol'), 'high');
  // An unvalidated id is a generator bug; guessing `high` would silently
  // dispatch an unknown model at the wrong tier's effort.
  assert.throws(() => mod.defaultEffortFor('claude-sonnet-5'), /No policy effort/);
  assert.match(mod.POLICY_HELP, /Default workers: Fable 5\.1 \/ GPT-6 Astra at low effort\./);
});

test('the agent def rewrite touches only the policy-owned scalars', () => {
  const source = fs.readFileSync(path.join(REPO, 'plugins/workflow/agents/worker-frontier.md'), 'utf8');
  // Applying the shipped policy to the shipped def is a no-op — that is what
  // parity-lint asserts, so assert it holds before testing the flip.
  assert.equal(applyAgentDefPolicy(source, loadWorkerPolicy(REPO)), source);

  const policy = flipped();
  const out = applyAgentDefPolicy(source, policy);
  assert.match(out, /^model: claude-fable-5-1\[1m\]$/m);
  assert.match(out, /^effort: low$/m);
  assert.ok(out.includes(claudeRunsOnSentence(policy)));
  assert.ok(!out.includes('Runs on Opus 5 at high effort.'));
  // The body is hand-authored and must survive untouched.
  assert.equal(out.slice(out.indexOf('\n---', 4)), source.slice(source.indexOf('\n---', 4)));
  // Idempotent: a second pass must not append a second "Runs on" sentence.
  assert.equal(applyAgentDefPolicy(out, policy), out);
});

test('the agent def rewrite throws rather than defaulting on a malformed def', () => {
  const policy = flipped();
  assert.throws(() => applyAgentDefPolicy('no frontmatter\n', policy), /no frontmatter block/);
  assert.throws(() => applyAgentDefPolicy('---\nname: x\n', policy), /unterminated frontmatter/);
  assert.throws(() => applyAgentDefPolicy('---\nname: x\neffort: high\n---\nbody\n', policy), /`model:`/);
});

test('prose tokens reduce labels to the words the contracts actually use', () => {
  const tokens = policyProseTokens(loadWorkerPolicy(REPO));
  assert.deepEqual(tokens.shortLabels, ['Opus', 'Fable', 'Sol', 'Astra']);
  assert.deepEqual([...tokens.efforts].sort(), ['high', 'medium']);
});

test('the help sentence names both tiers and both efforts', () => {
  const help = policyHelpSentence(loadWorkerPolicy(REPO));
  for (const token of ['Opus 5', 'GPT-5.6 Sol', 'Fable 5.1', 'GPT-6 Astra', 'high effort', 'medium effort']) {
    assert.ok(help.includes(token), `${POLICY_PATH} help sentence is missing ${token}: ${help}`);
  }
});
