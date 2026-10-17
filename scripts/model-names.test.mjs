import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findModelNames } from './model-names.mjs';

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-names-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

function scan(files, exemptions = []) {
  const root = tree(files);
  try {
    return findModelNames(root, exemptions);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const found = (result) => result.hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`);

test('model and effort names in skill bodies and always-on directives are flagged with file and line', () => {
  const result = scan({
    'plugins/sample/skills/sample/SKILL.md': '---\nname: sample\n---\nDispatch a Sonnet worker.\n',
    'plugins/sample/skills/sample/references/brief.md': 'Run the reviewer at high effort.\n',
    'plugins/sample/always-on.md': 'Prefer gpt-7.2 for reviews.\nRoute plans to Astra, builds to Sol.\n',
    'plugins/other/skills/x/SKILL.md': 'Pass --effort xhigh, or reasoning_effort: medium, or claude-9.1-preview.\n',
    'plugins/other/skills/y/SKILL.md':
      'Run at `high` effort.\nUse low reasoning effort, or ultra effort.\nA wrapped max\neffort, and O3 for review.\n'
      + 'Use **low** effort, or set effort: high, or effort level = max.\n'
      + 'Use GPT 5.6 or Claude 4.\n'
      + 'Use high **effort**, or ***max*** effort, or gpt-oss-120b.\n'
      + 'Use medium reasoning **effort**, or low **reasoning** effort.\n',
  });
  assert.deepEqual(found(result).sort(), [
    'plugins/other/skills/x/SKILL.md:1 effort --effort xhigh',
    'plugins/other/skills/x/SKILL.md:1 effort reasoning_effort: medium',
    'plugins/other/skills/x/SKILL.md:1 effort xhigh',
    'plugins/other/skills/x/SKILL.md:1 model claude-9.1-preview',
    'plugins/other/skills/y/SKILL.md:1 effort high` effort',
    'plugins/other/skills/y/SKILL.md:2 effort low reasoning effort',
    'plugins/other/skills/y/SKILL.md:2 effort ultra effort',
    'plugins/other/skills/y/SKILL.md:3 effort max\neffort',
    'plugins/other/skills/y/SKILL.md:4 model O3',
    'plugins/other/skills/y/SKILL.md:5 effort effort level = max',
    'plugins/other/skills/y/SKILL.md:5 effort effort: high',
    'plugins/other/skills/y/SKILL.md:5 effort low** effort',
    'plugins/other/skills/y/SKILL.md:6 model Claude 4',
    'plugins/other/skills/y/SKILL.md:6 model GPT 5.6',
    'plugins/other/skills/y/SKILL.md:7 effort high **effort',
    'plugins/other/skills/y/SKILL.md:7 effort max*** effort',
    'plugins/other/skills/y/SKILL.md:7 model gpt-oss-120b',
    'plugins/other/skills/y/SKILL.md:8 effort low **reasoning** effort',
    'plugins/other/skills/y/SKILL.md:8 effort medium reasoning **effort',
    'plugins/sample/always-on.md:1 model gpt-7.2',
    'plugins/sample/always-on.md:2 model Astra',
    'plugins/sample/always-on.md:2 model Sol',
    'plugins/sample/skills/sample/SKILL.md:4 model Sonnet',
    'plugins/sample/skills/sample/references/brief.md:1 effort high effort',
  ]);
});

test('placeholders, plain-English effort prose, frontmatter config keys and non-prompt files pass', () => {
  const result = scan({
    'plugins/sample/skills/sample/SKILL.md':
      '---\nname: sample\nmodel: opus\neffort: high\n---\nInvoke with `/sample <model> <effort>` or {effort_level}.\n'
      + 'Do not waste effort on small work. Prefer high-availability setups.\n'
      + 'Pass --effort <effort_level>, or set reasoning_effort to {effort_level}. Compile with -O3.\n'
      + 'Use a low-effort workaround; this should require minimal effort and an effort of high-quality review.\n'
      + 'Keep implementation effort low. Dedicate effort to high priority tasks. Use a high-effort worker.\n'
      + 'Set effort to high. The reasoning effort is high. Use minimal reasoning effort.\n',
    'plugins/crlf/skills/crlf/SKILL.md': '---\r\nname: crlf\r\nmodel: opus\r\neffort: high\r\n---\r\nBody.\r\n',
    'plugins/sample/skills/sample/scripts/rubric.json': '{"claude": "opus", "effort": "high"}\n',
    'plugins/sample/README.md': 'Runs on Opus at high effort.\n',
  });
  assert.deepEqual(found(result), []);
});

test('model: and effort: in a SKILL.md body are prose, not frontmatter config', () => {
  const result = scan({ 'plugins/sample/skills/sample/SKILL.md': '# Sample\nmodel: opus\n' });
  assert.deepEqual(found(result), ['plugins/sample/skills/sample/SKILL.md:2 model opus']);
});

test('an exemption covers only its listed kinds in its listed files, and an exempted file with nothing to suppress is stale', () => {
  const exemptions = [
    { files: ['plugins/sample/skills/sample/SKILL.md', 'plugins/gone/skills/gone/SKILL.md'], kinds: ['model'], reason: 'r' },
  ];
  const result = scan({
    'plugins/sample/skills/sample/SKILL.md': 'Name opus at max effort.\n',
    'plugins/gone/skills/gone/SKILL.md': 'Nothing model-specific here.\n',
    'plugins/third/skills/third/SKILL.md': 'Use haiku.\n',
  }, exemptions);
  assert.deepEqual(found(result).sort(), [
    'plugins/sample/skills/sample/SKILL.md:1 effort max effort',
    'plugins/third/skills/third/SKILL.md:1 model haiku',
  ]);
  assert.deepEqual(result.stale, [{ file: 'plugins/gone/skills/gone/SKILL.md', reason: 'r' }]);
});
