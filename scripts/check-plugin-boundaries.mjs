#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRetiredAgents } from './retire-bootstrap-agents.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const errors = [];
const warnings = [];
const strictHome = process.argv.includes('--strict-home');

function readJson(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return undefined;
  }
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function readText(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return undefined;
  }
}

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function requireTextTokens(relativePath, tokens, contract) {
  const content = readText(relativePath);
  if (content === undefined) return;
  for (const token of tokens) {
    if (!content.includes(token)) {
      fail(`${relativePath}: ${contract} requires ${JSON.stringify(token)}`);
    }
  }
}

function pluginEntries(marketplace) {
  return Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
}

function sourcePath(entry) {
  const source = entry?.source;
  return typeof source === 'string' ? source : source?.path;
}

function normalizeSource(source) {
  return String(source ?? '').replace(/\/+$/, '');
}

function skillNames(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot).filter((entry) => {
    const skillMd = path.join(skillsRoot, entry, 'SKILL.md');
    return fs.existsSync(skillMd);
  });
}

function findFiles(root, predicate, results = []) {
  if (!fs.existsSync(root)) return results;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (predicate(fullPath, entry)) results.push(fullPath);
    if (entry.isDirectory()) findFiles(fullPath, predicate, results);
  }
  return results;
}

function markdownAnchors(filePath) {
  const anchors = new Set();
  const seen = new Map();
  const text = fs.readFileSync(filePath, 'utf8');
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1]
      .replace(/<[^>]*>/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const duplicateIndex = seen.get(base) ?? 0;
    seen.set(base, duplicateIndex + 1);
    anchors.add(duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`);
  }
  return anchors;
}

function checkSkillMarkdownLinks(skillsRoot) {
  const markdownFiles = findFiles(skillsRoot, (fullPath, entry) =>
    entry.isFile() && fullPath.endsWith('.md'),
  );

  for (const filePath of markdownFiles) {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim();
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      else target = target.split(/\s+["']/)[0];

      if (
        !target
        || target.includes('{{')
        || /^(?:https?:|mailto:|app:)/i.test(target)
        || target.startsWith('/')
      ) continue;

      const [relativeTarget, rawAnchor] = target.split('#', 2);
      const linkedFile = relativeTarget
        ? path.resolve(path.dirname(filePath), decodeURIComponent(relativeTarget))
        : filePath;
      const displayPath = path.relative(repoRoot, filePath);

      if (!fs.existsSync(linkedFile)) {
        fail(`${displayPath}: broken relative link ${target}`);
        continue;
      }

      if (rawAnchor && linkedFile.endsWith('.md')) {
        const anchor = decodeURIComponent(rawAnchor).toLowerCase();
        if (!markdownAnchors(linkedFile).has(anchor)) {
          fail(`${displayPath}: missing markdown anchor #${rawAnchor} in ${path.relative(repoRoot, linkedFile)}`);
        }
      }
    }
  }
}

const codexMarketplace = readJson('.agents/plugins/marketplace.json');
const claudeMarketplace = readJson('.claude-plugin/marketplace.json');
const codexManifest = readJson('plugins/workflow-agents/.codex-plugin/plugin.json');
const claudeManifest = readJson('plugins/workflow/.claude-plugin/plugin.json');
const codexCopyPasteEntry = readJson('plugins/workflow-agents/marketplace-entry.json');
const codexHookManifest = readJson('plugins/workflow-agents/hooks/workflow-hooks.json');

const codexEntries = pluginEntries(codexMarketplace);
const claudeEntries = pluginEntries(claudeMarketplace);

if (codexMarketplace?.name !== claudeMarketplace?.name) {
  fail(
    `.agents/plugins/marketplace.json name must match .claude-plugin/marketplace.json name for Git-backed Codex upgrades (${codexMarketplace?.name} !== ${claudeMarketplace?.name})`,
  );
}

const codexWorkflowEntry = codexEntries.find((entry) => entry.name === 'bootstrap-workflow-agents');
if (!codexWorkflowEntry) {
  fail('.agents/plugins/marketplace.json must register bootstrap-workflow-agents');
} else if (normalizeSource(sourcePath(codexWorkflowEntry)) !== './plugins/workflow-agents') {
  fail('bootstrap-workflow-agents must source ./plugins/workflow-agents in .agents/plugins/marketplace.json');
} else if (codexWorkflowEntry.version !== codexManifest?.version) {
  fail(
    `bootstrap-workflow-agents version must match between marketplace and plugin manifest (${codexWorkflowEntry.version} !== ${codexManifest?.version})`,
  );
}

for (const entry of codexEntries) {
  const entrySource = normalizeSource(sourcePath(entry));
  if (entry.name !== 'bootstrap-workflow-agents' || entrySource !== './plugins/workflow-agents') {
    fail(`.agents/plugins/marketplace.json contains unsupported plugin entry ${entry.name ?? '<unnamed>'}`);
  }
}

if (codexEntries.length !== 1) {
  fail(`.agents/plugins/marketplace.json must expose exactly one plugin (found ${codexEntries.length})`);
}

const claudeWorkflowEntry = claudeEntries.find((entry) => entry.name === 'bootstrap-workflow');
if (!claudeWorkflowEntry) {
  fail('.claude-plugin/marketplace.json must register bootstrap-workflow');
} else if (normalizeSource(sourcePath(claudeWorkflowEntry)) !== './plugins/workflow') {
  fail('bootstrap-workflow must source ./plugins/workflow in .claude-plugin/marketplace.json');
} else if (claudeWorkflowEntry.version !== claudeManifest?.version) {
  fail(
    `bootstrap-workflow version must match between marketplace and plugin manifest (${claudeWorkflowEntry.version} !== ${claudeManifest?.version})`,
  );
}

for (const entry of claudeEntries) {
  const entrySource = normalizeSource(sourcePath(entry));
  if (entry.name !== 'bootstrap-workflow' || entrySource !== './plugins/workflow') {
    fail(`.claude-plugin/marketplace.json contains unsupported plugin entry ${entry.name ?? '<unnamed>'}`);
  }
}

if (claudeEntries.length !== 1) {
  fail(`.claude-plugin/marketplace.json must expose exactly one plugin (found ${claudeEntries.length})`);
}

if (codexManifest?.name !== 'bootstrap-workflow-agents') {
  fail('plugins/workflow-agents/.codex-plugin/plugin.json name must be bootstrap-workflow-agents');
}

if (normalizeSource(codexManifest?.skills) !== './skills') {
  fail('plugins/workflow-agents/.codex-plugin/plugin.json skills must point at ./skills/');
}

if (normalizeSource(codexManifest?.hooks) !== './hooks/workflow-hooks.json') {
  fail('plugins/workflow-agents/.codex-plugin/plugin.json hooks must point at ./hooks/workflow-hooks.json');
}

const codexHookManifestPath = path.join(repoRoot, 'plugins/workflow-agents/hooks/workflow-hooks.json');
const codexHookManifestText = fs.existsSync(codexHookManifestPath)
  ? fs.readFileSync(codexHookManifestPath, 'utf8')
  : '';
for (const token of [
  'CLAUDE_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'BOOTSTRAP_WORKFLOW_CODEX_ROOT',
  '.codex/plugins/cache',
  'TeamCreate',
  'AskUserQuestion',
]) {
  if (codexHookManifestText.includes(token)) {
    fail(`plugins/workflow-agents/hooks/workflow-hooks.json must not reference Claude-only token ${token}`);
  }
}

if (!codexHookManifest?.hooks?.PreToolUse) {
  fail('plugins/workflow-agents/hooks/workflow-hooks.json must wire PreToolUse');
}

const codexHookEvents = Object.keys(codexHookManifest?.hooks ?? {});
if (codexHookEvents.some((event) => event !== 'PreToolUse')) {
  fail(`plugins/workflow-agents/hooks/workflow-hooks.json contains non-safety hook events: ${codexHookEvents.join(', ')}`);
}

if (!codexHookManifestText.includes('${PLUGIN_ROOT}/hooks/codex-guard.ts')) {
  fail('plugins/workflow-agents/hooks/workflow-hooks.json must resolve its guard through native ${PLUGIN_ROOT}');
}

if (claudeManifest?.name !== 'bootstrap-workflow') {
  fail('plugins/workflow/.claude-plugin/plugin.json name must be bootstrap-workflow');
}
if (claudeManifest?.version !== '4.0.3') {
  fail(`bootstrap-workflow release must be version 4.0.3 (found ${claudeManifest?.version})`);
}
if (codexManifest?.version !== '1.0.3') {
  fail(`bootstrap-workflow-agents release must be version 1.0.3 (found ${codexManifest?.version})`);
}

if (exists('plugins/workflow-agents/.claude-plugin')) {
  fail('plugins/workflow-agents must not contain .claude-plugin metadata');
}

if (exists('plugins/workflow/.codex-plugin')) {
  fail('plugins/workflow must not contain .codex-plugin metadata');
}

for (const unexpectedDir of ['commands']) {
  if (exists(`plugins/workflow-agents/${unexpectedDir}`)) {
    fail(`plugins/workflow-agents must not include Claude-only ${unexpectedDir}/`);
  }
}

for (const retiredPath of [
  'plugins/domain',
  'plugins/tools',
  'plugins/workflow/agents',
  'plugins/workflow-agents/agents',
  'plugins/workflow/hooks/guards/workflow-artifact-path.ts',
  'plugins/workflow/hooks/guards/workflow-gate-enforcement.ts',
  'plugins/workflow/hooks/guards/workflow-gate-enforcement.test.ts',
]) {
  const retiredRoot = path.join(repoRoot, retiredPath);
  const remainingFiles = findFiles(
    retiredRoot,
    (_fullPath, entry) => entry.isFile() || entry.isSymbolicLink(),
  );
  if (remainingFiles.length > 0) {
    fail(`${retiredPath} is retired; keep the active distribution workflow-only and free of copied agent definitions`);
  }
}

if (exists('plugins/workflow-agents/scripts/sync-codex-agents.mjs')) {
  fail('plugins/workflow-agents/scripts/sync-codex-agents.mjs is retired; plugins must not copy agent definitions into user homes');
}

if (
  codexCopyPasteEntry &&
  JSON.stringify(codexCopyPasteEntry, null, 2) !== JSON.stringify(codexWorkflowEntry, null, 2)
) {
  fail('plugins/workflow-agents/marketplace-entry.json must match the .agents marketplace entry');
}

const codexSkillsRoot = path.join(repoRoot, 'plugins/workflow-agents/skills');
const claudeSkillsRoot = path.join(repoRoot, 'plugins/workflow/skills');
const codexSkills = skillNames(codexSkillsRoot);
const claudeSkills = skillNames(claudeSkillsRoot);

const expectedSkills = [
  'team-auto',
  'team-build',
  'team-debug',
  'team-plan',
  'team-retro',
  'team-review',
  'team-ship',
];
const retiredSkillNames = [
  'best-practice-check',
  'review-swarm',
  'team-brief',
  'team-design',
  'team-drift',
  'team-qa',
  'team-receiving-review-feedback',
  'team-tdd',
  'team-verification-before-completion',
  'workflow-routing',
];
for (const [label, inventory] of [
  ['Claude', claudeSkills],
  ['Codex/OpenCode', codexSkills],
]) {
  const actual = [...inventory].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedSkills)) {
    fail(`${label} plugin must expose exactly seven workflow skills: ${expectedSkills.join(', ')} (found ${actual.join(', ')})`);
  }
}
for (const [label, root] of [
  ['Claude', claudeSkillsRoot],
  ['Codex/OpenCode', codexSkillsRoot],
]) {
  for (const retired of retiredSkillNames) {
    if (fs.existsSync(path.join(root, retired))) {
      fail(`${label} plugin still contains retired skill directory ${retired}`);
    }
  }
}

for (const fileName of ['workflow-contract.md', 'cross-model-review.md']) {
  const claudePath = `plugins/workflow/skills/shared/${fileName}`;
  const codexPath = `plugins/workflow-agents/skills/shared/${fileName}`;
  const claudeContent = readText(claudePath);
  const codexContent = readText(codexPath);
  if (claudeContent !== undefined && codexContent !== undefined && claudeContent !== codexContent) {
    fail(`shared/${fileName}: Claude and Codex/OpenCode copies must be byte-identical`);
  }
}

const crossModelTokens = [
  'codex exec',
  '--ignore-user-config',
  '--model gpt-5.6-sol',
  'model_reasoning_effort="high"',
  '--ephemeral',
  '--yolo',
  '3600000',
  '60-minute',
  'claude -p',
  '--model claude-opus-5',
  '--effort high',
  '--safe-mode',
  '--no-session-persistence',
  '--permission-mode plan',
  '--tools ""',
  '--strict-mcp-config',
  '--output-format json',
  'run.md',
  'degraded',
];
for (const contractPath of [
  'plugins/workflow/skills/shared/cross-model-review.md',
  'plugins/workflow-agents/skills/shared/cross-model-review.md',
]) {
  requireTextTokens(contractPath, crossModelTokens, 'the explicit safe cross-model review contract');
  const content = readText(contractPath);
  const forbiddenTokens = [
    '--sandbox',
    '10-minute',
    'danger-full-access',
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
    '--permission-mode bypassPermissions',
  ];
  const forbidden = forbiddenTokens.filter((token) => content?.includes(token));
  if (forbidden.length > 0) {
    fail(`${contractPath}: cross-model review must use the nested-container-compatible --yolo transport and 60-minute ceiling`);
  }
}

for (const root of ['plugins/workflow/skills', 'plugins/workflow-agents/skills']) {
  requireTextTokens(
    `${root}/team-plan/SKILL.md`,
    ['plan.md', 'cross-model', 'before', 'approval'],
    'the mandatory plan review gate',
  );
  requireTextTokens(
    `${root}/team-review/SKILL.md`,
    ['--implementation', 'approved plan', 'implementation diff', 'cross-model', 'run.md'],
    'the mandatory implementation review gate',
  );
  requireTextTokens(
    `${root}/team-auto/SKILL.md`,
    ['never ships', '.team-auto-active', 'run.md'],
    'the bounded auto-runner contract',
  );
}

const retiredStageTokens = retiredSkillNames;
const activeContractFiles = [
  path.join(repoRoot, 'README.md'),
  path.join(repoRoot, '.claude-plugin', 'marketplace.json'),
  path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'),
  path.join(repoRoot, 'plugins', 'workflow', '.claude-plugin', 'plugin.json'),
  path.join(repoRoot, 'plugins', 'workflow-agents', '.codex-plugin', 'plugin.json'),
  ...findFiles(
    path.join(repoRoot, 'plugins', 'workflow', 'skills'),
    (_fullPath, entry) => entry.isFile(),
  ),
  ...findFiles(
    path.join(repoRoot, 'plugins', 'workflow-agents', 'skills'),
    (_fullPath, entry) => entry.isFile(),
  ),
  ...findFiles(
    path.join(repoRoot, 'evals', 'suites'),
    (_fullPath, entry) => entry.isFile(),
  ),
];
for (const filePath of activeContractFiles) {
  const content = fs.readFileSync(filePath, 'utf8');
  for (const token of retiredStageTokens) {
    if (content.includes(token)) {
      fail(`${path.relative(repoRoot, filePath)}: active contract references retired stage ${token}`);
    }
  }
}

checkSkillMarkdownLinks(codexSkillsRoot);
checkSkillMarkdownLinks(claudeSkillsRoot);

for (const skillName of codexSkills) {
  const skillMd = path.join(codexSkillsRoot, skillName, 'SKILL.md');
  const stat = fs.lstatSync(skillMd);
  if (stat.isSymbolicLink()) {
    fail(`Codex skill ${skillName} must use a real top-level SKILL.md, not a symlink`);
  }
}

const sharedSkillNames = codexSkills.filter((skillName) => claudeSkills.includes(skillName));
if (sharedSkillNames.length === 0) {
  warn('No shared workflow skill names found between Claude and Codex; expected same user-facing names');
}

const repoAgentsSkillsRoot = path.join(repoRoot, '.agents/skills');
const repoShadowSkills = sharedSkillNames.filter((skillName) =>
  fs.existsSync(path.join(repoAgentsSkillsRoot, skillName, 'SKILL.md')),
);
if (repoShadowSkills.length > 0) {
  fail(`repo-local .agents/skills shadows plugin workflow skills: ${repoShadowSkills.join(', ')}`);
}

const homeAgentsSkillsRoot = path.join(os.homedir(), '.agents/skills');
const homeShadowSkills = sharedSkillNames.filter((skillName) =>
  fs.existsSync(path.join(homeAgentsSkillsRoot, skillName, 'SKILL.md')),
);
if (homeShadowSkills.length > 0) {
  const managed = homeShadowSkills.filter((skillName) =>
    fs.existsSync(path.join(homeAgentsSkillsRoot, skillName, '.nanoclaw-managed')),
  );
  const unmanaged = homeShadowSkills.filter((skillName) => !managed.includes(skillName));
  const message =
    `global ~/.agents/skills contains workflow skill names that may shadow plugin installs: ${homeShadowSkills.join(', ')}`;
  if (strictHome) {
    fail(message);
  } else {
    warn(message);
  }
  if (managed.length > 0) {
    warn(`managed NanoClaw mirrors should be removed by the next sync: ${managed.join(', ')}`);
  }
  if (unmanaged.length > 0) {
    warn(`unmanaged global skill dirs require manual review before removal: ${unmanaged.join(', ')}`);
  }
}

const retiredGlobalSkills = [
  'agentic-systems',
  'analytics',
  'analytics-engineering',
  'cortex-code',
  'data-engineering',
  'data-science',
  'financial-analytics',
  'llm-engineering',
  'software-engineering',
].filter((skillName) => fs.existsSync(path.join(homeAgentsSkillsRoot, skillName, 'SKILL.md')));

if (retiredGlobalSkills.length > 0) {
  const message = `global ~/.agents/skills still contains retired bootstrap skill copies: ${retiredGlobalSkills.join(', ')}`;
  if (strictHome) fail(message);
  else warn(message);
}

const retiredAgentDiscovery = discoverRetiredAgents();
if (retiredAgentDiscovery.targets.length > 0) {
  const message =
    `active runtime homes still contain marker-owned retired Bootstrap agents: ${
      retiredAgentDiscovery.targets.map((entry) => entry.source).join(', ')
    }`;
  if (strictHome) fail(message);
  else warn(message);
}
if (retiredAgentDiscovery.unmanagedCollisions.length > 0) {
  warn(
    `retired agent basenames without the Bootstrap marker were preserved: ${
      retiredAgentDiscovery.unmanagedCollisions.map((entry) => entry.source).join(', ')
    }`,
  );
}

const codexClaudeMetadata = findFiles(
  path.join(repoRoot, 'plugins/workflow-agents'),
  (fullPath, entry) => entry.isDirectory() && entry.name === '.claude-plugin',
);
if (codexClaudeMetadata.length > 0) {
  fail(`Codex plugin contains Claude metadata: ${codexClaudeMetadata.map((p) => path.relative(repoRoot, p)).join(', ')}`);
}

if (errors.length > 0) {
  console.error('Plugin boundary check failed:');
  for (const error of errors) console.error(`- ${error}`);
  if (warnings.length > 0) {
    console.error('\nWarnings:');
    for (const warning of warnings) console.error(`- ${warning}`);
  }
  process.exit(1);
}

console.log('Plugin boundary check passed.');
if (warnings.length > 0) {
  console.log('\nWarnings:');
  for (const warning of warnings) console.log(`- ${warning}`);
}
