#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_AGENT_NAMES, discoverRetiredAgents } from './retire-bootstrap-agents.mjs';
import { WORKER_AGENT } from '../plugins/workflow-agents/scripts/codex-agent-toml.mjs';

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
const orchestrateClaudeManifest = readJson('plugins/orchestrate/.claude-plugin/plugin.json');
const orchestrateCodexManifest = readJson('plugins/orchestrate-agents/.codex-plugin/plugin.json');
const wwbdClaudeManifest = readJson('plugins/wwbd/.claude-plugin/plugin.json');
const wwbdCodexManifest = readJson('plugins/wwbd/.codex-plugin/plugin.json');
const conciseClaudeManifest = readJson('plugins/concise/.claude-plugin/plugin.json');
const conciseCodexManifest = readJson('plugins/concise/.codex-plugin/plugin.json');
const codexCopyPasteEntry = readJson('plugins/workflow-agents/marketplace-entry.json');
const orchestrateCopyPasteEntry = readJson('plugins/orchestrate-agents/marketplace-entry.json');
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

// Supported roster: the workflow distribution plus the standalone single-source
// advisory and session-mode plugins. Anything else creeping into a marketplace is drift.
const codexRoster = new Map([
  ['bootstrap-workflow-agents', './plugins/workflow-agents'],
  ['bootstrap-orchestrate-agents', './plugins/orchestrate-agents'],
  ['wwbd', './plugins/wwbd'],
  ['concise', './plugins/concise'],
  ['instruction-audit', './plugins/instruction-audit'],
]);
for (const entry of codexEntries) {
  const entrySource = normalizeSource(sourcePath(entry));
  if (codexRoster.get(entry.name) !== entrySource) {
    fail(`.agents/plugins/marketplace.json contains unsupported plugin entry ${entry.name ?? '<unnamed>'}`);
  }
}

if (codexEntries.length !== codexRoster.size) {
  fail(`.agents/plugins/marketplace.json must expose exactly ${codexRoster.size} plugins (found ${codexEntries.length})`);
}

const codexOrchestrateEntry = codexEntries.find((entry) => entry.name === 'bootstrap-orchestrate-agents');
if (!codexOrchestrateEntry) {
  fail('.agents/plugins/marketplace.json must register bootstrap-orchestrate-agents');
} else if (normalizeSource(sourcePath(codexOrchestrateEntry)) !== './plugins/orchestrate-agents') {
  fail('bootstrap-orchestrate-agents must source ./plugins/orchestrate-agents in .agents/plugins/marketplace.json');
} else if (codexOrchestrateEntry.version !== orchestrateCodexManifest?.version) {
  fail(
    `bootstrap-orchestrate-agents version must match between marketplace and plugin manifest (${codexOrchestrateEntry.version} !== ${orchestrateCodexManifest?.version})`,
  );
}

const codexWwbdEntry = codexEntries.find((entry) => entry.name === 'wwbd');
if (!codexWwbdEntry) {
  fail('.agents/plugins/marketplace.json must register wwbd');
} else if (codexWwbdEntry.version !== wwbdCodexManifest?.version) {
  fail(
    `wwbd version must match between .agents marketplace and .codex-plugin manifest (${codexWwbdEntry.version} !== ${wwbdCodexManifest?.version})`,
  );
}

const codexConciseEntry = codexEntries.find((entry) => entry.name === 'concise');
if (!codexConciseEntry) {
  fail('.agents/plugins/marketplace.json must register concise');
} else if (codexConciseEntry.version !== conciseCodexManifest?.version) {
  fail(
    `concise version must match between .agents marketplace and .codex-plugin manifest (${codexConciseEntry.version} !== ${conciseCodexManifest?.version})`,
  );
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

const claudeRoster = new Map([
  ['bootstrap-workflow', './plugins/workflow'],
  ['bootstrap-orchestrate', './plugins/orchestrate'],
  ['wwbd', './plugins/wwbd'],
  ['concise', './plugins/concise'],
  ['instruction-audit', './plugins/instruction-audit'],
]);
for (const entry of claudeEntries) {
  const entrySource = normalizeSource(sourcePath(entry));
  if (claudeRoster.get(entry.name) !== entrySource) {
    fail(`.claude-plugin/marketplace.json contains unsupported plugin entry ${entry.name ?? '<unnamed>'}`);
  }
}

if (claudeEntries.length !== claudeRoster.size) {
  fail(`.claude-plugin/marketplace.json must expose exactly ${claudeRoster.size} plugins (found ${claudeEntries.length})`);
}

const claudeOrchestrateEntry = claudeEntries.find((entry) => entry.name === 'bootstrap-orchestrate');
if (!claudeOrchestrateEntry) {
  fail('.claude-plugin/marketplace.json must register bootstrap-orchestrate');
} else if (normalizeSource(sourcePath(claudeOrchestrateEntry)) !== './plugins/orchestrate') {
  fail('bootstrap-orchestrate must source ./plugins/orchestrate in .claude-plugin/marketplace.json');
} else if (claudeOrchestrateEntry.version !== orchestrateClaudeManifest?.version) {
  fail(
    `bootstrap-orchestrate version must match between marketplace and plugin manifest (${claudeOrchestrateEntry.version} !== ${orchestrateClaudeManifest?.version})`,
  );
}

const claudeWwbdEntry = claudeEntries.find((entry) => entry.name === 'wwbd');
if (!claudeWwbdEntry) {
  fail('.claude-plugin/marketplace.json must register wwbd');
} else if (claudeWwbdEntry.version !== wwbdClaudeManifest?.version) {
  fail(
    `wwbd version must match between .claude-plugin marketplace and plugin manifest (${claudeWwbdEntry.version} !== ${wwbdClaudeManifest?.version})`,
  );
}

const claudeConciseEntry = claudeEntries.find((entry) => entry.name === 'concise');
if (!claudeConciseEntry) {
  fail('.claude-plugin/marketplace.json must register concise');
} else if (claudeConciseEntry.version !== conciseClaudeManifest?.version) {
  fail(
    `concise version must match between .claude-plugin marketplace and .claude-plugin manifest (${claudeConciseEntry.version} !== ${conciseClaudeManifest?.version})`,
  );
}

// wwbd is single-source: one directory serves Claude and Codex/OpenCode, so the
// two manifests must agree on identity and both point at the same skills tree.
if (wwbdClaudeManifest?.name !== 'wwbd') {
  fail('plugins/wwbd/.claude-plugin/plugin.json name must be wwbd');
}
if (wwbdCodexManifest?.name !== 'wwbd') {
  fail('plugins/wwbd/.codex-plugin/plugin.json name must be wwbd');
}
if (wwbdClaudeManifest?.version !== wwbdCodexManifest?.version) {
  fail(
    `wwbd Claude and Codex manifests must share one version (${wwbdClaudeManifest?.version} !== ${wwbdCodexManifest?.version})`,
  );
}
if (!exists('plugins/wwbd/skills/wwbd/SKILL.md')) {
  fail('plugins/wwbd must ship skills/wwbd/SKILL.md');
}
if (!exists('plugins/wwbd/always-on.md')) {
  fail('plugins/wwbd must ship always-on.md (the SessionStart nudge)');
}
// Codex/OpenCode containers fire no plugin hooks — a hooks entry there would be
// dead config that looks live. Keep the Codex manifest hook-free.
if (wwbdCodexManifest?.hooks !== undefined) {
  fail('plugins/wwbd/.codex-plugin/plugin.json must not declare hooks (non-Claude providers get the nudge via .nanoclaw-always-on.md)');
}

// The always-on nudge reaches Claude via plugins/<p>/always-on.md and every
// other provider via .nanoclaw-always-on.md, which concatenates the same blocks.
// Nothing made them AGREE, so editing one silently split the fleet: Claude
// sessions on the new directive, container and Codex agents on the old one, with
// no check to notice. Compare the shared blocks byte-for-byte.
for (const [pluginFile, heading] of [
  ['plugins/orchestrate/always-on.md', '# Orchestrate'],
  ['plugins/wwbd/always-on.md', '# WWBD'],
]) {
  if (!exists(pluginFile) || !exists('.nanoclaw-always-on.md')) continue;
  const block = (text) => {
    const start = text.indexOf(heading);
    if (start === -1) return undefined;
    const next = text.indexOf('\n# ', start + 1);
    return text.slice(start, next === -1 ? undefined : next).trim();
  };
  const fromPlugin = block(readText(pluginFile));
  const fromNanoclaw = block(readText('.nanoclaw-always-on.md'));
  if (fromPlugin === undefined) {
    fail(`${pluginFile} must contain a "${heading}" block (the always-on nudge)`);
  } else if (fromNanoclaw === undefined) {
    fail(`.nanoclaw-always-on.md must carry the "${heading}" block so non-Claude providers get the same directive`);
  } else if (fromPlugin !== fromNanoclaw) {
    fail(
      `"${heading}" has drifted between ${pluginFile} and .nanoclaw-always-on.md — ` +
        'Claude and non-Claude agents would receive different standing instructions. Edit both.',
    );
  }
}

// concise is one skills-only plugin directory for Claude and Codex/OpenCode.
// It intentionally has no activation hook or always-on file: invocation turns
// the current conversation mode on, and the skill itself turns it off again.
if (conciseClaudeManifest?.name !== 'concise') {
  fail('plugins/concise/.claude-plugin/plugin.json name must be concise');
}
if (conciseCodexManifest?.name !== 'concise') {
  fail('plugins/concise/.codex-plugin/plugin.json name must be concise');
}
if (conciseClaudeManifest?.version !== conciseCodexManifest?.version) {
  fail(
    `concise Claude and Codex manifests must share one version (${conciseClaudeManifest?.version} !== ${conciseCodexManifest?.version})`,
  );
}
for (const [label, manifest] of [
  ['Claude', conciseClaudeManifest],
  ['Codex', conciseCodexManifest],
]) {
  if (normalizeSource(manifest?.skills) !== './skills') {
    fail(`plugins/concise ${label} manifest skills must point at ./skills/`);
  }
  if (manifest?.hooks !== undefined) {
    fail(`plugins/concise ${label} manifest must not declare hooks; concise is session-invoked only`);
  }
}
if (!exists('plugins/concise/skills/concise/SKILL.md')) {
  fail('plugins/concise must ship the shared skills/concise/SKILL.md');
}
const conciseAgentDefinition = readText('plugins/concise/skills/concise/agents/openai.yaml');
if (
  conciseAgentDefinition !== undefined
  && !/^\s*allow_implicit_invocation:\s*false\s*$/m.test(conciseAgentDefinition)
) {
  fail('plugins/concise/skills/concise/agents/openai.yaml must set allow_implicit_invocation: false');
}
for (const activationPath of [
  'plugins/concise/hooks',
  'plugins/concise/always-on.md',
  'plugins/concise/.nanoclaw-always-on.md',
]) {
  if (exists(activationPath)) {
    fail(`${activationPath} must not exist; concise is session-invoked only`);
  }
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

// SessionStart earns its place: Codex has no plugin-agent mechanism, so the
// shipped `agents/worker-frontier.toml` is inert until something copies it into
// `<CODEX_HOME>/agents/`. The hook is the only thing that runs on a bare
// install with no user action. The allowlist stays closed around these two —
// safety plus role installation — so a third event cannot drift in.
if (!codexHookManifest?.hooks?.SessionStart) {
  fail('plugins/workflow-agents/hooks/workflow-hooks.json must wire SessionStart so the worker role installs itself');
}

const ALLOWED_CODEX_HOOK_EVENTS = ['PreToolUse', 'SessionStart'];
const codexHookEvents = Object.keys(codexHookManifest?.hooks ?? {});
const unexpectedHookEvents = codexHookEvents.filter(
  (event) => !ALLOWED_CODEX_HOOK_EVENTS.includes(event),
);
if (unexpectedHookEvents.length > 0) {
  fail(`plugins/workflow-agents/hooks/workflow-hooks.json contains unexpected hook events: ${unexpectedHookEvents.join(', ')}`);
}

for (const [label, target] of [
  ['guard', '${PLUGIN_ROOT}/hooks/codex-guard.ts'],
  ['role installer', '${PLUGIN_ROOT}/scripts/session-install-roles.mjs'],
]) {
  if (!codexHookManifestText.includes(target)) {
    fail(`plugins/workflow-agents/hooks/workflow-hooks.json must resolve its ${label} through native \${PLUGIN_ROOT}`);
  }
}

// The hook command names a path inside the package; if that file is not
// shipped, every Codex session silently starts without the worker role.
if (!exists('plugins/workflow-agents/scripts/session-install-roles.mjs')) {
  fail('plugins/workflow-agents/scripts/session-install-roles.mjs must ship; the SessionStart hook resolves it inside the package');
}

if (claudeManifest?.name !== 'bootstrap-workflow') {
  fail('plugins/workflow/.claude-plugin/plugin.json name must be bootstrap-workflow');
}
if (claudeManifest?.version !== '5.5.0') {
  fail(`bootstrap-workflow release must be version 5.5.0 (found ${claudeManifest?.version})`);
}
if (codexManifest?.version !== '2.5.0') {
  fail(`bootstrap-workflow-agents release must be version 2.5.0 (found ${codexManifest?.version})`);
}
if (orchestrateClaudeManifest?.version !== '1.0.0') {
  fail(`bootstrap-orchestrate release must be version 1.0.0 (found ${orchestrateClaudeManifest?.version})`);
}
if (orchestrateCodexManifest?.version !== '1.0.0') {
  fail(`bootstrap-orchestrate-agents release must be version 1.0.0 (found ${orchestrateCodexManifest?.version})`);
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

// The agents/ dirs are back, but narrowly. They were emptied in 53e9501, which
// deleted a six-role advisor roster (architecture-advisor, cto-advisor and the
// rest — now RETIRED_AGENT_NAMES); the rule that followed banned the directory
// outright. The ban is replaced, not dropped: each plugin may ship exactly the
// one worker role and nothing else, so the advisor roster still cannot come
// back and no second worker can appear beside `worker-frontier`.
for (const [dir, expected] of [
  ['plugins/workflow/agents', `${WORKER_AGENT}.md`],
  ['plugins/workflow-agents/agents', `${WORKER_AGENT}.toml`],
]) {
  const root = path.join(repoRoot, dir);
  if (!exists(dir)) {
    fail(`${dir} must ship ${expected} so /orchestrate has a worker on a bare install`);
    continue;
  }
  const found = findFiles(root, (_full, entry) => entry.isFile() || entry.isSymbolicLink())
    .map((full) => path.relative(root, full))
    .sort();
  if (found.length !== 1 || found[0] !== expected) {
    fail(`${dir} must contain exactly ${expected}; found ${found.join(', ') || '(nothing)'}`);
  }
  for (const name of found) {
    if (RETIRED_AGENT_NAMES.includes(path.parse(name).name)) {
      fail(`${dir}/${name} is a retired advisor role and must not return`);
    }
  }
}

for (const retiredPath of [
  'plugins/domain',
  'plugins/tools',
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

if (
  orchestrateCopyPasteEntry &&
  JSON.stringify(orchestrateCopyPasteEntry, null, 2) !== JSON.stringify(codexOrchestrateEntry, null, 2)
) {
  fail('plugins/orchestrate-agents/marketplace-entry.json must match the .agents marketplace entry');
}

const codexSkillsRoot = path.join(repoRoot, 'plugins/workflow-agents/skills');
const claudeSkillsRoot = path.join(repoRoot, 'plugins/workflow/skills');
const orchestrateClaudeSkillsRoot = path.join(repoRoot, 'plugins/orchestrate/skills');
const orchestrateCodexSkillsRoot = path.join(repoRoot, 'plugins/orchestrate-agents/skills');
const codexSkills = skillNames(codexSkillsRoot);
const claudeSkills = skillNames(claudeSkillsRoot);

// The split: the workflow pair keeps the seven explicitly-invoked team skills,
// the orchestrate pair owns the one skill that automatic delegation pressure
// runs through. `orchestrate` appearing in a workflow tree would put it back
// where disabling the orchestrate plugin cannot remove it.
const expectedSkills = [
  'team-auto',
  'team-build',
  'team-debug',
  'team-plan',
  'team-retro',
  'team-review',
  'team-ship',
];
const expectedOrchestrateSkills = ['orchestrate'];
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
    fail(`${label} workflow plugin must expose exactly the seven team skills: ${expectedSkills.join(', ')} (found ${actual.join(', ')})`);
  }
}
for (const [label, root] of [
  ['Claude', orchestrateClaudeSkillsRoot],
  ['Codex/OpenCode', orchestrateCodexSkillsRoot],
]) {
  const actual = skillNames(root).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedOrchestrateSkills)) {
    fail(`${label} orchestrate plugin must expose exactly ${expectedOrchestrateSkills.join(', ')} (found ${actual.join(', ') || '(nothing)'})`);
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

// `skills/shared/` is carried by all FOUR plugins, not shared by reference: an
// installed marketplace cache materializes only the plugin's own subtree, so
// `plugins/orchestrate` cannot reach `../workflow/skills/shared/`. Every copy is
// generated from the one canonical tree; this is the gate that fails if one drifts.
const CANONICAL_SHARED_DIR = 'plugins/workflow/skills/shared';
const SHARED_COPY_DIRS = [
  'plugins/workflow-agents/skills/shared',
  'plugins/orchestrate/skills/shared',
  'plugins/orchestrate-agents/skills/shared',
];
for (const fileName of [
  'workflow-contract.md',
  'cross-model-review.md',
  'references/CODEX-SOURCES.md',
  'references/codex-adversarial-prompt.md',
  'references/codex-review-output.schema.json',
]) {
  const canonical = readText(`${CANONICAL_SHARED_DIR}/${fileName}`);
  if (canonical === undefined) continue;
  for (const dir of SHARED_COPY_DIRS) {
    const copy = readText(`${dir}/${fileName}`);
    if (copy === undefined) continue;
    if (copy !== canonical) {
      fail(
        `${dir}/${fileName} has drifted from ${CANONICAL_SHARED_DIR}/${fileName} — ` +
          'every plugin carries its own copy because a relative path cannot cross a plugin ' +
          'boundary on an installed cache. Regenerate: node plugins/workflow-agents/scripts/sync-agent-skills.mjs',
      );
    }
  }
}

// The repo-root copy is what NanoClaw's non-Claude providers read directly off
// disk (src/claude-md-compose.ts); the plugin-relative copy is what the
// installed Claude plugin cache and the SessionStart hook can actually reach
// (the cache only materializes the plugin subtree, not the repo root).
{
  const rootContent = readText('.nanoclaw-always-on.md');
  const orchestrateContent = readText('plugins/orchestrate/always-on.md');
  const wwbdContent = readText('plugins/wwbd/always-on.md');
  if (rootContent !== undefined && orchestrateContent !== undefined && wwbdContent !== undefined) {
    const expected = `${orchestrateContent.trimEnd()}\n\n${wwbdContent.trimEnd()}\n`;
    if (rootContent !== expected) {
      fail('.nanoclaw-always-on.md must be plugins/orchestrate/always-on.md + blank line + plugins/wwbd/always-on.md, byte-exact');
    }
  }
}

const crossModelTokens = [
  'codex exec',
  '--ignore-user-config',
  '--model gpt-6-astra',
  'model_reasoning_effort="medium"',
  '--ephemeral',
  '--yolo',
  '3600000',
  '60-minute',
  'claude -p',
  '--model claude-fable-5-1',
  '--effort medium',
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
    ['plan.md', 'cross-model', 'consequential', 'approval'],
    'the consequential plan review contract',
  );
  requireTextTokens(
    `${root}/team-review/SKILL.md`,
    ['--implementation', 'approved plan', 'implementation diff', 'cross-model', 'run.md'],
    'the consequential implementation review contract',
  );
  requireTextTokens(
    `${root}/team-auto/SKILL.md`,
    ['stops at anything that deploys', '.team-auto-active', 'run.md'],
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
  path.join(repoRoot, 'plugins', 'orchestrate', '.claude-plugin', 'plugin.json'),
  path.join(repoRoot, 'plugins', 'orchestrate-agents', '.codex-plugin', 'plugin.json'),
  ...findFiles(
    path.join(repoRoot, 'plugins', 'workflow', 'skills'),
    (_fullPath, entry) => entry.isFile(),
  ),
  ...findFiles(
    path.join(repoRoot, 'plugins', 'workflow-agents', 'skills'),
    (_fullPath, entry) => entry.isFile(),
  ),
  ...findFiles(
    path.join(repoRoot, 'plugins', 'orchestrate', 'skills'),
    (_fullPath, entry) => entry.isFile(),
  ),
  ...findFiles(
    path.join(repoRoot, 'plugins', 'orchestrate-agents', 'skills'),
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


// ─── The orchestrate split ────────────────────────────────────────────────────
// `/orchestrate` and the automatic pressure to use it live in their own plugin
// pair so the operator can DISABLE automatic delegation and still run
// `/team-build`, `/team-review` and the rest by hand.
//
// THREE things create that pressure, and disabling the plugin only works if ALL
// THREE are inside it. Any one left behind in the workflow pair silently defeats
// the switch: the skill would still be offered, or the standing directive would
// still load, or — worst — the dispatch-first hook would still BLOCK a
// coordinator from reading source before it dispatches, which is precisely the
// thing an operator working directly needs to do. These assertions are the
// machine-checked version of that, in both directions: present here, absent there.
{
  const orchestrateHookManifestPath = 'plugins/orchestrate/hooks/orchestrate-hooks.json';
  const orchestrateHookManifest = readJson(orchestrateHookManifestPath);
  const orchestrateHookText = readText(orchestrateHookManifestPath) ?? '';
  const workflowHookManifest = readJson('plugins/workflow/hooks/workflow-hooks.json');
  const workflowHookText = readText('plugins/workflow/hooks/workflow-hooks.json') ?? '';

  // 1. THE SKILL — in the orchestrate pair, gone from the workflow pair.
  for (const [label, file] of [
    ['Claude', 'plugins/orchestrate/skills/orchestrate/SKILL.md'],
    ['Codex/OpenCode', 'plugins/orchestrate-agents/skills/orchestrate/SKILL.md'],
  ]) {
    if (!exists(file)) fail(`${label} orchestrate plugin must ship ${file}`);
  }
  for (const stale of [
    'plugins/workflow/skills/orchestrate',
    'plugins/workflow-agents/skills/orchestrate',
  ]) {
    if (exists(stale)) {
      fail(`${stale} must not exist; the orchestrate skill moved to the bootstrap-orchestrate pair, and a copy here would still be offered with that plugin disabled`);
    }
  }

  // 2. THE STANDING DIRECTIVE — the SessionStart nudge and its non-Claude twin.
  if (!exists('plugins/orchestrate/always-on.md')) {
    fail('plugins/orchestrate must ship always-on.md (the SessionStart directive that auto-loads orchestrate)');
  }
  if (exists('plugins/workflow/always-on.md')) {
    fail('plugins/workflow/always-on.md must not exist; the orchestrate directive moved to plugins/orchestrate, and a copy here would keep loading with that plugin disabled');
  }
  if (!orchestrateHookManifest?.hooks?.SessionStart) {
    fail(`${orchestrateHookManifestPath} must wire SessionStart so the standing directive loads with the plugin`);
  }
  if (!orchestrateHookText.includes('${CLAUDE_PLUGIN_ROOT}/always-on.md')) {
    fail(`${orchestrateHookManifestPath} SessionStart must read the plugin's own always-on.md`);
  }
  if (workflowHookManifest?.hooks?.SessionStart) {
    fail('plugins/workflow/hooks/workflow-hooks.json must not wire SessionStart; its only job was catting the orchestrate directive, which moved');
  }

  // 3. THE DISPATCH-FIRST GUARD — the one that makes the switch real. It BLOCKS
  //    a coordinator from reading implementation source or running checks before
  //    dispatching, so it must be registered by the orchestrate plugin and by
  //    nothing else.
  for (const file of [
    'plugins/orchestrate/hooks/guards/dispatch-first.ts',
    'plugins/orchestrate/hooks/guards/dispatch-first-core.ts',
    'plugins/orchestrate/hooks/guards/dispatch-first-core.test.ts',
    'plugins/orchestrate/hooks/guards/dispatch-first.test.ts',
    'plugins/orchestrate/hooks/guards/conformance.test.ts',
    'plugins/orchestrate/hooks/run-hook.sh',
    'plugins/orchestrate/hooks/lib/types.ts',
  ]) {
    if (!exists(file)) fail(`plugins/orchestrate must ship ${path.relative('plugins/orchestrate', file)}`);
  }
  for (const stale of [
    'plugins/workflow/hooks/guards/dispatch-first.ts',
    'plugins/workflow/hooks/guards/dispatch-first-core.ts',
    'plugins/workflow/hooks/guards/dispatch-first-core.test.ts',
    'plugins/workflow/hooks/guards/dispatch-first.test.ts',
    'plugins/workflow-agents/hooks/guards/dispatch-first-core.ts',
  ]) {
    if (exists(stale)) {
      fail(`${stale} must not exist; the dispatch-first guard moved to plugins/orchestrate and a copy here could still be wired`);
    }
  }
  if (!orchestrateHookText.includes('guards/dispatch-first.ts')) {
    fail(`${orchestrateHookManifestPath} must register guards/dispatch-first.ts on PreToolUse`);
  }
  if (workflowHookText.includes('dispatch-first')) {
    fail('plugins/workflow/hooks/workflow-hooks.json must not register the dispatch-first guard; it would keep blocking direct work with bootstrap-orchestrate disabled');
  }

  // The guards the workflow plugin KEEPS. Splitting orchestrate out must not take
  // a safety guard with it — those protect the operator whether or not they are
  // delegating.
  const RETAINED_WORKFLOW_GUARDS = [
    'guards/block-destructive.ts',
    'guards/file-protection.ts',
    'guards/block-askuser-during-auto.ts',
  ];
  for (const guard of RETAINED_WORKFLOW_GUARDS) {
    if (!workflowHookText.includes(guard)) {
      fail(`plugins/workflow/hooks/workflow-hooks.json must still register ${guard}`);
    }
    if (orchestrateHookText.includes(guard)) {
      fail(`${orchestrateHookManifestPath} must not register ${guard}; safety guards stay with bootstrap-workflow so disabling orchestrate cannot disable them`);
    }
  }
  if (!exists('plugins/workflow/hooks/guards/opencode-guard.ts')) {
    fail('plugins/workflow/hooks/guards/opencode-guard.ts must stay in the workflow plugin');
  }

  // The worker role and its transport stay with bootstrap-workflow; orchestrate
  // dispatches TO them. The helper is mirrored (not moved) because the skill
  // names it by a plugin-relative path.
  if (!exists('plugins/workflow/scripts/frontier-worker.mjs')) {
    fail('plugins/workflow/scripts/frontier-worker.mjs must stay in the workflow plugin');
  }
  for (const mirror of [
    'plugins/orchestrate/scripts/frontier-worker.mjs',
    'plugins/orchestrate-agents/scripts/frontier-worker.mjs',
  ]) {
    if (!exists(mirror)) {
      fail(`${mirror} must ship; the orchestrate skill names ../../scripts/frontier-worker.mjs, which cannot resolve into another plugin`);
    }
  }

  // Manifest shape.
  if (orchestrateClaudeManifest?.name !== 'bootstrap-orchestrate') {
    fail('plugins/orchestrate/.claude-plugin/plugin.json name must be bootstrap-orchestrate');
  }
  if (orchestrateCodexManifest?.name !== 'bootstrap-orchestrate-agents') {
    fail('plugins/orchestrate-agents/.codex-plugin/plugin.json name must be bootstrap-orchestrate-agents');
  }
  if (normalizeSource(orchestrateClaudeManifest?.hooks) !== './hooks/orchestrate-hooks.json') {
    fail('plugins/orchestrate/.claude-plugin/plugin.json hooks must point at ./hooks/orchestrate-hooks.json');
  }
  if (normalizeSource(orchestrateCodexManifest?.skills) !== './skills') {
    fail('plugins/orchestrate-agents/.codex-plugin/plugin.json skills must point at ./skills/');
  }
  // Codex/OpenCode has no live dispatch-first adapter (codex-guard.ts routes only
  // the destructive/email/file-protection cores), so a hooks entry here would be
  // dead config that looks live — the same rule wwbd is held to.
  if (orchestrateCodexManifest?.hooks !== undefined) {
    fail('plugins/orchestrate-agents/.codex-plugin/plugin.json must not declare hooks; Codex/OpenCode gets the directive via .nanoclaw-always-on.md and has no dispatch-first adapter');
  }
  if (exists('plugins/orchestrate-agents/.claude-plugin')) {
    fail('plugins/orchestrate-agents must not contain .claude-plugin metadata');
  }
  if (exists('plugins/orchestrate/.codex-plugin')) {
    fail('plugins/orchestrate must not contain .codex-plugin metadata');
  }

  // NO `nanoclaw-plugin.json` here, deliberately — do not "fix" this by adding one.
  //
  // That file is NOT how a plugin's hooks reach NanoClaw containers. Container
  // Claude registers plugin hooks by passing each discovered plugin directory as
  // an SDK `plugins:` entry
  // (nanoclaw-v2 container/agent-runner/src/providers/claude.ts:1749-1752, handed
  // to the SDK at :2710; the header at :1727-1731 says that pass-through is what
  // makes the SDK load plugin-declared hooks). `discoverPlugins` walks three
  // levels, so `plugins/bootstrap/plugins/orchestrate` is found and its
  // `orchestrate-hooks.json` loads with no NanoClaw change at all.
  //
  // `nanoclaw-plugin.json`'s `preToolUseGuards` is a DE-DUPLICATION signal with
  // exactly one consumer — `preToolUseGuards.includes('bash-email')` at
  // claude.ts:2627 — which tells the runner to stand down its own built-in Bash
  // email gate because a plugin owns it. Proof that it is not a registration
  // list: plugins/workflow/nanoclaw-plugin.json names only `bash-email`, yet
  // `file-protection` and `block-askuser-during-auto` are live in containers.
  //
  // There is no NanoClaw-side dispatch-first gate to stand down, and the
  // consumer matches that one literal string, so `["dispatch-first"]` here would
  // be inert config that reads as live wiring.
  if (exists('plugins/orchestrate/nanoclaw-plugin.json')) {
    fail('plugins/orchestrate/nanoclaw-plugin.json must not exist; preToolUseGuards is a de-duplication signal for NanoClaw\'s own built-in gates (only "bash-email" is consumed), not how plugin hooks register — see the comment above');
  }
}

checkSkillMarkdownLinks(codexSkillsRoot);
checkSkillMarkdownLinks(orchestrateClaudeSkillsRoot);
checkSkillMarkdownLinks(orchestrateCodexSkillsRoot);
checkSkillMarkdownLinks(path.join(repoRoot, 'plugins/wwbd/skills'));
checkSkillMarkdownLinks(path.join(repoRoot, 'plugins/concise/skills'));
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
