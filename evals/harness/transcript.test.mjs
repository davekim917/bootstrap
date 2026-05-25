import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConformant, emptyTranscript, isReadTool, researchToolKind, isSubagentTool } from './transcript.mjs';

test('emptyTranscript is conformant', () => {
  assert.doesNotThrow(() => assertConformant(emptyTranscript()));
});

test('assertConformant rejects missing keys / bad shapes', () => {
  assert.throws(() => assertConformant({}), /missing key/);
  assert.throws(() => assertConformant({ ...emptyTranscript(), finalOutput: 5 }), /finalOutput must be a string/);
  assert.throws(() => assertConformant({ ...emptyTranscript(), toolCalls: [{ name: 'x' }] }), /toolCall needs/);
  assert.throws(() => assertConformant({ ...emptyTranscript(), researchCalls: [{ tool: 'bing', ok: true }] }), /researchCall.tool invalid/);
});

test('isReadTool matches read-tool names AND shell read commands, not lookalikes', () => {
  for (const n of ['read', 'Read', "/bin/bash -lc 'cat smoke.txt'", 'head file', 'view']) {
    assert.equal(isReadTool(n), true, `expected read: ${n}`);
  }
  for (const n of ['opencode', 'write', 'concatenate', 'edit', 'Bash(git status)']) {
    assert.equal(isReadTool(n), false, `expected NOT read: ${n}`);
  }
});

test('researchToolKind classifies exa/context7/deepwiki', () => {
  assert.equal(researchToolKind('exa.web_search_exa'), 'exa');
  assert.equal(researchToolKind('mcp__exa__web_search'), 'exa');
  assert.equal(researchToolKind('context7.query-docs'), 'context7');
  assert.equal(researchToolKind('resolve-library-id'), 'context7');
  assert.equal(researchToolKind('deepwiki.ask_question'), 'deepwiki');
  assert.equal(researchToolKind('read'), null);
});

test('isSubagentTool matches task/agent but EXCLUDES spawn_task (container cross-agent MCP)', () => {
  assert.equal(isSubagentTool('task'), true);
  assert.equal(isSubagentTool('Task'), true);
  assert.equal(isSubagentTool('delegate'), true);
  assert.equal(isSubagentTool('spawn_task'), false); // intentional exclusion
  assert.equal(isSubagentTool('read'), false);
});
