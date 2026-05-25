import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalCheck, scoreHardGates, VERDICT } from './score.mjs';
import { emptyTranscript } from './transcript.mjs';

function tx(over = {}) {
  return { ...emptyTranscript(), exitOk: true, ...over };
}

test('evalCheck: tool_called (read) + match', () => {
  const t = tx({ toolCalls: [{ name: 'read', ok: true }] });
  assert.equal(evalCheck({ type: 'tool_called', read: true }, t).pass, true);
  assert.equal(evalCheck({ type: 'tool_called', match: 'read' }, t).pass, true);
  assert.equal(evalCheck({ type: 'tool_called', read: true }, tx({ toolCalls: [{ name: 'write', ok: true }] })).pass, false);
});

test('evalCheck: research_called (also scans toolCalls)', () => {
  assert.equal(evalCheck({ type: 'research_called', tool: 'exa' }, tx({ researchCalls: [{ tool: 'exa', ok: true }] })).pass, true);
  assert.equal(evalCheck({ type: 'research_called', tool: 'exa' }, tx({ toolCalls: [{ name: 'exa.search', ok: true }] })).pass, true);
  assert.equal(evalCheck({ type: 'research_called', tool: 'deepwiki' }, tx()).pass, false);
});

test('evalCheck: subagents_spawned min + parallel, and no_subagents', () => {
  const two = tx({ subagentSpawns: [{ role: 'a', parallel: true }, { role: 'b', parallel: true }] });
  assert.equal(evalCheck({ type: 'subagents_spawned', min: 2, parallel: true }, two).pass, true);
  assert.equal(evalCheck({ type: 'subagents_spawned', min: 3 }, two).pass, false);
  assert.equal(evalCheck({ type: 'no_subagents' }, tx()).pass, true);
  assert.equal(evalCheck({ type: 'no_subagents' }, two).pass, false);
});

test('evalCheck: output_contains / output_matches', () => {
  const t = tx({ finalOutput: 'value is SMOKE_a1b2c3 here' });
  assert.equal(evalCheck({ type: 'output_contains', value: 'SMOKE_a1b2c3' }, t).pass, true);
  assert.equal(evalCheck({ type: 'output_matches', regex: 'SMOKE_[a-z0-9]+' }, t).pass, true);
  assert.equal(evalCheck({ type: 'output_contains', value: 'nope' }, t).pass, false);
});

test('evalCheck throws on unknown check type', () => {
  assert.throws(() => evalCheck({ type: 'bogus' }, tx()), /unknown hard-gate check/);
});

test('scoreHardGates: PASS when all gates pass, FAIL when one fails', () => {
  const t = tx({ toolCalls: [{ name: 'read', ok: true }], finalOutput: 'TOKEN' });
  const rubric = {
    hardGates: [
      { id: 'g1', check: { type: 'tool_called', read: true } },
      { id: 'g2', check: { type: 'output_contains', value: 'TOKEN' } },
    ],
  };
  assert.equal(scoreHardGates(rubric, t).verdict, VERDICT.PASS);
  const rubric2 = { hardGates: [{ id: 'g3', check: { type: 'output_contains', value: 'MISSING' } }] };
  assert.equal(scoreHardGates(rubric2, t).verdict, VERDICT.FAIL);
});

test('scoreHardGates: infra outcomes never become behavioral FAIL', () => {
  assert.equal(scoreHardGates({ hardGates: [] }, tx({ timedOut: true })).verdict, VERDICT.TIMEOUT);
  assert.equal(scoreHardGates({ hardGates: [] }, tx({ exitOk: false })).verdict, VERDICT.TIMEOUT);
});
