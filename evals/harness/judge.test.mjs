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

test('extractJson: braces INSIDE string values do not break matching (the judge-quotes-code case)', () => {
  // judge evidence quoting code with braces — naive brace counting would truncate this
  assert.deepEqual(extractJson('{"evidence":"use tool_choice={\\"type\\":\\"tool\\"} here","n":2}'), {
    evidence: 'use tool_choice={"type":"tool"} here',
    n: 2,
  });
  // a closing/opening brace literally inside a string value
  assert.deepEqual(extractJson('prefix {"a":"a } b { c"} suffix'), { a: 'a } b { c' });
});
