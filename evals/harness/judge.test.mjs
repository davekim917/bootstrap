import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from './judge.mjs';

test('extractJson: bare object', () => {
  assert.deepEqual(extractJson('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
});

test('extractJson: fenced ```json block', () => {
  assert.deepEqual(extractJson('here:\n```json\n{"ok":true}\n```\nthanks'), { ok: true });
});

test('extractJson: prose around a nested object (balanced braces)', () => {
  assert.deepEqual(extractJson('verdict: {"matched":[{"truth_id":"x"}],"n":2} done'), {
    matched: [{ truth_id: 'x' }],
    n: 2,
  });
});

test('extractJson: returns null on no/!invalid JSON', () => {
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{ not valid json'), null);
});
