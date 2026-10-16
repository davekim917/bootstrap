/**
 * Skill bodies and always-on directives reach every host and container agent, so a model or effort named in
 * prose pins the whole fleet while config says otherwise. Both belong in config or in `model:` / `effort:`
 * frontmatter, which is why those two frontmatter keys are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';

const LEVEL = '(?:minimal|low|medium|high|xhigh|max|ultra)';
const QUOTE = '["\'`]?';

const PATTERNS = [
  { kind: 'model', re: /\b(?:opus|sonnet|haiku|fable|gemini|astra|sol|terra|luna)\b/gi },
  { kind: 'model', re: /\bclaude-\d+(?:[.-]\w+)*/gi },
  { kind: 'model', re: /\bgpt-?\d+(?:[.-]\w+)*/gi },
  { kind: 'model', re: /(?<![\w-])o[1-4](?:-mini|-pro)?\b/gi },
  { kind: 'effort', re: /\bxhigh\b/gi },
  { kind: 'effort', re: new RegExp(`\\b${LEVEL}${QUOTE}(?:-|\\s+)(?:reasoning\\s+)?effort\\b`, 'gi') },
  { kind: 'effort', re: new RegExp(`\\beffort(?:\\s+level)?\\s*[:=]?\\s*${QUOTE}${LEVEL}\\b`, 'gi') },
  { kind: 'effort', re: new RegExp(`(?:--effort|\\b(?:model_)?reasoning_effort)${QUOTE}\\s*(?:[:=]|\\s+to\\s+|\\s)\\s*${QUOTE}${LEVEL}\\b`, 'gi') },
];

/** Per-file exemptions for skills whose subject is models; a listed file with nothing to suppress is stale. */
export const MODEL_NAME_EXEMPTIONS = [
  {
    files: ['plugins/orchestrate/skills/orchestrate/SKILL.md'],
    kinds: ['model', 'effort'],
    reason: '/orchestrate is invoked with the model and effort the user names; parsing and mapping those names is the skill',
  },
  {
    files: [
      'plugins/workflow/skills/shared/cross-model-review.md',
      'plugins/workflow-agents/skills/shared/cross-model-review.md',
    ],
    kinds: ['model', 'effort'],
    reason: 'the second-reviewer CLI invocation is the reviewer\'s config; check-plugin-boundaries requires its --model and effort flags verbatim',
  },
  {
    files: [
      'plugins/workflow/skills/shared/workflow-contract.md',
      'plugins/workflow-agents/skills/shared/workflow-contract.md',
    ],
    kinds: ['model', 'effort'],
    reason: 'the autonomous effort-selection rubric defines the effort vocabulary and the provider defaults it steps from',
  },
];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function promptFiles(root) {
  const pluginsRoot = path.join(root, 'plugins');
  if (!fs.existsSync(pluginsRoot)) return [];
  const files = [];
  for (const plugin of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const dir = path.join(pluginsRoot, plugin.name);
    if (fs.existsSync(path.join(dir, 'always-on.md'))) files.push(path.join(dir, 'always-on.md'));
    walk(path.join(dir, 'skills'), files);
  }
  return files.map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
}

function frontmatterEnd(lines) {
  if (lines[0] !== '---') return 0;
  const close = lines.indexOf('---', 1);
  return close === -1 ? 0 : close + 1;
}

export function findModelNames(root, exemptions = MODEL_NAME_EXEMPTIONS) {
  const hits = [];
  const used = new Set();
  for (const file of promptFiles(root)) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n').split('\n');
    const fmEnd = frontmatterEnd(lines);
    const text = lines.map((line, index) => (index < fmEnd && /^(?:model|effort):/.test(line) ? '' : line)).join('\n');
    for (const { kind, re } of PATTERNS) {
      for (const match of text.matchAll(re)) {
        if (exemptions.some((e) => e.files.includes(file) && e.kinds.includes(kind))) {
          used.add(file);
          continue;
        }
        hits.push({ file, line: text.slice(0, match.index).split('\n').length, kind, text: match[0] });
      }
    }
  }
  const stale = exemptions.flatMap((e) => e.files.filter((file) => !used.has(file)).map((file) => ({ file, reason: e.reason })));
  return { hits, stale };
}
