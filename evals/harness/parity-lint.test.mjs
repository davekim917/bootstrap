import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, covered, tokenLeaks, headingText, hasFrontmatter } from './parity-lint.mjs';

test('headingText strips leading ## and trims', () => {
  assert.equal(headingText('### Step 3: Spawn Reviewers'), 'Step 3: Spawn Reviewers');
  assert.equal(headingText('## What This Skill Does'), 'What This Skill Does');
});

test('norm lowercases, strips formatting + trailing punctuation, collapses space', () => {
  assert.equal(norm('Anti-Patterns (Do Not Do These)'), 'anti-patterns (do not do these)');
  assert.equal(norm('**Rationalization Resistance**'), 'rationalization resistance');
  assert.equal(norm('Selective Mode (`--scope-only`):'), 'selective mode (--scope-only)');
});

test('covered: exact, prefix either direction (parenthetical suffix tolerance)', () => {
  const codex = ['anti-patterns (do not do these)', 'context discipline'];
  assert.equal(covered('anti-patterns (do not do these)', codex), true); // exact
  assert.equal(covered('anti-patterns', codex), true); // claude shorter, codex extends
  assert.equal(covered('context discipline (keep it lean)', codex), true); // claude longer, codex prefix
  assert.equal(covered('rationalization resistance', codex), false); // genuinely absent
});

test('tokenLeaks: Claude tokens INSIDE "## Dispatch by Runtime" are confined (no leak)', () => {
  // The review-swarm shape: tokens live under Dispatch by Runtime → Claude (reference).
  const md = [
    '## Context Discipline',
    'Keep the lead context lean.',
    '## Dispatch by Runtime',
    '### Codex',
    'Use native delegation.',
    '### Claude (reference — for parity, not used on this runtime)',
    'On Claude this uses `TeamCreate` + `Agent(subagent_type=…)` and `SendMessage` + `TeamDelete`.',
    '## Resource Files',
    'See references/.',
  ].join('\n');
  assert.deepEqual(tokenLeaks(md), []);
});

test('tokenLeaks: Claude tokens in the runtime-neutral BODY are flagged (the team-qa/team-build gutting)', () => {
  const md = [
    '## QA Pipeline',
    'Dispatch validators with subagent_type = `general-purpose`.',
    'On Claude: parallel `Agent(...)` calls in one block.',
    '## Output',
  ].join('\n');
  const leaks = tokenLeaks(md);
  assert.equal(leaks.length, 2);
  assert.deepEqual(leaks.map((l) => l.token).sort(), ['Agent(', 'subagent_type']);
});

test('tokenLeaks: .claude/ paths are flagged in the body, allowed in the Claude-reference region', () => {
  const leakBody = ['## Process', 'Write the design to `.claude/tmp/review-input.md`.'].join('\n');
  const leaks = tokenLeaks(leakBody);
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].token, '.claude');
  const confined = ['## Dispatch by Runtime', '### Claude (reference)', 'On Claude, write to .claude/tmp/.'].join('\n');
  assert.deepEqual(tokenLeaks(confined), []);
});

test('tokenLeaks: a non-dispatch ## heading after Dispatch closes the confinement region', () => {
  const md = [
    '## Dispatch by Runtime',
    '### Claude (reference)',
    'uses TeamCreate',
    '## Anti-Patterns', // closes the region
    'Do not call SendMessage here in the body.', // now a leak
  ].join('\n');
  const leaks = tokenLeaks(md);
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].token, 'SendMessage');
});

test('hasFrontmatter: needs name/version/description (the missing-version gutting signal)', () => {
  assert.equal(hasFrontmatter('---\nname: x\nversion: 1.0\ndescription: y\n---\nbody').ok, true);
  assert.deepEqual(hasFrontmatter('---\nname: x\ndescription: y\n---\nbody').missing, ['version']);
  assert.equal(hasFrontmatter('no frontmatter at all').ok, false);
});
