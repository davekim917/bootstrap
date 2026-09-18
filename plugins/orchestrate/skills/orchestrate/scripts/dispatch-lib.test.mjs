import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capEffort, loadRubric, rewriteClaudeSpawn } from './dispatch-lib.mjs';

const rubric = loadRubric();
const route = (model, effort) => ({ decision: 'route', pick: { model, effort } });

test('a roleless spawn with nothing named gets the picked model and effort shim', () => {
  const out = rewriteClaudeSpawn({ description: 'd', prompt: 'p' }, route('opus', 'high'), rubric);
  assert.equal(out.model, 'opus');
  assert.equal(out.subagent_type, 'bootstrap-orchestrate:worker-high');
  assert.equal(out.prompt, 'p');
});

test('general-purpose counts as roleless', () => {
  const out = rewriteClaudeSpawn({ subagent_type: 'general-purpose', prompt: 'p' }, route('fable', 'low'), rubric);
  assert.deepEqual([out.model, out.subagent_type], ['fable', 'bootstrap-orchestrate:worker-low']);
});

test('a role type keeps its role and only gets a model', () => {
  const out = rewriteClaudeSpawn({ subagent_type: 'Explore', prompt: 'p' }, route('opus', 'low'), rubric);
  assert.deepEqual([out.model, out.subagent_type], ['opus', 'Explore']);
});

test('an explicit model is never replaced; a roleless spawn still gets the effort, capped to that model', () => {
  const out = rewriteClaudeSpawn({ model: 'fable', prompt: 'p' }, route('opus', 'xhigh'), rubric);
  assert.deepEqual([out.model, out.subagent_type], ['fable', 'bootstrap-orchestrate:worker-high']);
});

test('an explicit shim above the cap is lowered; within the cap nothing changes', () => {
  const over = rewriteClaudeSpawn({ model: 'fable', subagent_type: 'bootstrap-orchestrate:worker-max' }, null, rubric);
  assert.equal(over.subagent_type, 'bootstrap-orchestrate:worker-high');
  const opusMax = rewriteClaudeSpawn({ model: 'opus', subagent_type: 'bootstrap-orchestrate:worker-max' }, null, rubric);
  assert.equal(opusMax.subagent_type, 'bootstrap-orchestrate:worker-xhigh');
  assert.equal(rewriteClaudeSpawn({ model: 'opus', subagent_type: 'bootstrap-orchestrate:worker-xhigh' }, null, rubric), null);
});

test('no route (ask / unavailable / null) leaves a spawn untouched', () => {
  for (const p of [null, { decision: 'ask', pick: { model: 'opus', effort: 'low' } }, { decision: 'unavailable', pick: null }]) {
    assert.equal(rewriteClaudeSpawn({ prompt: 'p' }, p, rubric), null);
  }
});

test('capEffort lowers only above the cap', () => {
  assert.equal(capEffort('max', 'high'), 'high');
  assert.equal(capEffort('low', 'high'), 'low');
  assert.equal(capEffort('weird', 'high'), 'weird');
});
