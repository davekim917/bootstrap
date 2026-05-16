#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
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

const codexMarketplace = readJson('.agents/plugins/marketplace.json');
const claudeMarketplace = readJson('.claude-plugin/marketplace.json');
const codexManifest = readJson('plugins/workflow-codex/.codex-plugin/plugin.json');
const claudeManifest = readJson('plugins/workflow/.claude-plugin/plugin.json');
const codexCopyPasteEntry = readJson('plugins/workflow-codex/marketplace-entry.json');

const codexEntries = pluginEntries(codexMarketplace);
const claudeEntries = pluginEntries(claudeMarketplace);

const codexWorkflowEntry = codexEntries.find((entry) => entry.name === 'bootstrap-workflow-codex');
if (!codexWorkflowEntry) {
  fail('.agents/plugins/marketplace.json must register bootstrap-workflow-codex');
} else if (normalizeSource(sourcePath(codexWorkflowEntry)) !== './plugins/workflow-codex') {
  fail('bootstrap-workflow-codex must source ./plugins/workflow-codex in .agents/plugins/marketplace.json');
}

for (const entry of codexEntries) {
  const entrySource = normalizeSource(sourcePath(entry));
  if (entry.name === 'bootstrap-workflow' || entrySource === './plugins/workflow') {
    fail('.agents/plugins/marketplace.json must not register the Claude bootstrap-workflow plugin');
  }
}

const claudeWorkflowEntry = claudeEntries.find((entry) => entry.name === 'bootstrap-workflow');
if (!claudeWorkflowEntry) {
  fail('.claude-plugin/marketplace.json must register bootstrap-workflow');
} else if (normalizeSource(sourcePath(claudeWorkflowEntry)) !== './plugins/workflow') {
  fail('bootstrap-workflow must source ./plugins/workflow in .claude-plugin/marketplace.json');
}

for (const entry of claudeEntries) {
  const entrySource = normalizeSource(sourcePath(entry));
  if (entry.name === 'bootstrap-workflow-codex' || entrySource === './plugins/workflow-codex') {
    fail('.claude-plugin/marketplace.json must not register the Codex bootstrap-workflow-codex plugin');
  }
}

if (codexManifest?.name !== 'bootstrap-workflow-codex') {
  fail('plugins/workflow-codex/.codex-plugin/plugin.json name must be bootstrap-workflow-codex');
}

if (normalizeSource(codexManifest?.skills) !== './skills') {
  fail('plugins/workflow-codex/.codex-plugin/plugin.json skills must point at ./skills/');
}

if (codexManifest?.hooks) {
  fail('plugins/workflow-codex/.codex-plugin/plugin.json must not wire Claude hooks into Codex');
}

if (claudeManifest?.name !== 'bootstrap-workflow') {
  fail('plugins/workflow/.claude-plugin/plugin.json name must be bootstrap-workflow');
}

if (exists('plugins/workflow-codex/.claude-plugin')) {
  fail('plugins/workflow-codex must not contain .claude-plugin metadata');
}

if (exists('plugins/workflow/.codex-plugin')) {
  fail('plugins/workflow must not contain .codex-plugin metadata');
}

for (const unexpectedDir of ['agents', 'commands', 'hooks']) {
  if (exists(`plugins/workflow-codex/${unexpectedDir}`)) {
    fail(`plugins/workflow-codex must not include Claude-only ${unexpectedDir}/`);
  }
}

if (
  codexCopyPasteEntry &&
  JSON.stringify(codexCopyPasteEntry, null, 2) !== JSON.stringify(codexWorkflowEntry, null, 2)
) {
  fail('plugins/workflow-codex/marketplace-entry.json must match the .agents marketplace entry');
}

const codexSkillsRoot = path.join(repoRoot, 'plugins/workflow-codex/skills');
const claudeSkillsRoot = path.join(repoRoot, 'plugins/workflow/skills');
const codexSkills = skillNames(codexSkillsRoot);
const claudeSkills = skillNames(claudeSkillsRoot);

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

const codexClaudeMetadata = findFiles(
  path.join(repoRoot, 'plugins/workflow-codex'),
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
