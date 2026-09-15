#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_AGENT_NAMES, discoverRetiredAgents } from './retire-bootstrap-agents.mjs';
import { WORKER_AGENT } from '../plugins/workflow-agents/scripts/codex-agent-toml.mjs';
import {
  GENERATED_POLICY_BASENAME,
  POLICY_CONSUMER_PLUGINS,
  POLICY_PATH,
} from '../plugins/workflow-agents/scripts/worker-policy.mjs';

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

/** Every `plugins/<name>` directory, repo-relative and sorted. */
function pluginDirs() {
  const pluginsRoot = path.join(repoRoot, 'plugins');
  if (!fs.existsSync(pluginsRoot)) return [];
  return fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `plugins/${entry.name}`)
    .sort();
}

/**
 * Every SessionStart command string a hook manifest registers. Shape is the
 * same for Claude and Codex: hooks.SessionStart[].hooks[].command.
 */
function sessionStartCommands(manifestRelativePath) {
  const manifest = readJson(manifestRelativePath);
  const groups = Array.isArray(manifest?.hooks?.SessionStart) ? manifest.hooks.SessionStart : [];
  return groups.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((hook) => hook?.command)
    .filter((command) => typeof command === 'string');
}

/**
 * A standing directive is delivered by the provider's OWN plugin hook reading
 * the plugin's OWN always-on.md, and by nothing else.
 *
 *  (a) No `.nanoclaw-always-on.md` anywhere. That file was a host-only side
 *      door: NanoClaw read it off disk and injected it into Codex/OpenCode
 *      containers, so those runtimes received a directive their own plugin never
 *      declared — and disabling the plugin did not remove it.
 *  (b) Any plugin that ships always-on.md must wire the SessionStart hook that
 *      cats it, on every side it has a manifest for. Claude resolves
 *      ${CLAUDE_PLUGIN_ROOT}; Codex resolves ${PLUGIN_ROOT} and does not expand
 *      the Claude token, so a Claude-shaped command in a Codex manifest cats an
 *      empty path and the session silently starts with no directive.
 *
 * Only `wwbd` ships a directive today. `bootstrap-orchestrate` deliberately does
 * not — see the orchestrate section below.
 */
function checkAlwaysOnDelivery() {
  const SKIP_DIRS = new Set(['.git', 'node_modules']);
  const strays = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name === '.nanoclaw-always-on.md') {
        strays.push(path.relative(repoRoot, path.join(dir, entry.name)));
      }
    }
  };
  walk(repoRoot);
  for (const stray of strays.sort()) {
    fail(
      `${stray} must not exist. Nothing host-specific belongs in this repo — a plugin's standing ` +
        'directive comes from its own SessionStart hook reading its own always-on.md, so disabling ' +
        'the plugin removes it on every runtime.',
    );
  }

  for (const dir of pluginDirs()) {
    if (!exists(`${dir}/always-on.md`)) continue;
    for (const [manifestDir, token] of [
      ['.claude-plugin', '${CLAUDE_PLUGIN_ROOT}/always-on.md'],
      ['.codex-plugin', '${PLUGIN_ROOT}/always-on.md'],
    ]) {
      const manifestPath = `${dir}/${manifestDir}/plugin.json`;
      if (!exists(manifestPath)) continue;
      const hooksSource = readJson(manifestPath)?.hooks;
      if (typeof hooksSource !== 'string') {
        fail(
          `${manifestPath} ships always-on.md but declares no hooks file — that runtime would ` +
            'never read the directive. Declare "hooks": "./hooks/<file>.json" with a SessionStart hook.',
        );
        continue;
      }
      const hookManifestPath = path.join(dir, hooksSource.replace(/^\.\//, ''));
      if (!exists(hookManifestPath)) {
        fail(`${manifestPath} declares hooks ${hooksSource}, but ${hookManifestPath} does not exist`);
        continue;
      }
      const commands = sessionStartCommands(hookManifestPath);
      if (!commands.some((command) => command.includes(token))) {
        fail(
          `${hookManifestPath} must register a SessionStart command that cats "${token}"; ` +
            'without it that runtime starts with no standing directive while the other has one.',
        );
      }
      if (manifestDir === '.codex-plugin' && commands.some((c) => c.includes('CLAUDE_PLUGIN_ROOT'))) {
        fail(`${hookManifestPath} must not reference Claude-only token CLAUDE_PLUGIN_ROOT`);
      }
    }
  }
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
// wwbd is the one plugin that still ships a standing directive, and it reaches
// BOTH runtimes from its own hooks — the Claude manifest's wwbd-hooks.json and
// the Codex manifest's wwbd-codex-hooks.json (separate files because Codex does
// not expand ${CLAUDE_PLUGIN_ROOT}). checkAlwaysOnDelivery enforces that, and
// enforces that no host-specific delivery file exists anywhere in the repo.
checkAlwaysOnDelivery();

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
if (claudeManifest?.version !== '5.6.0') {
  fail(`bootstrap-workflow release must be version 5.6.0 (found ${claudeManifest?.version})`);
}
if (codexManifest?.version !== '2.6.0') {
  fail(`bootstrap-workflow-agents release must be version 2.6.0 (found ${codexManifest?.version})`);
}
if (orchestrateClaudeManifest?.version !== '1.2.0') {
  fail(`bootstrap-orchestrate release must be version 1.2.0 (found ${orchestrateClaudeManifest?.version})`);
}
if (orchestrateCodexManifest?.version !== '1.2.0') {
  fail(`bootstrap-orchestrate-agents release must be version 1.2.0 (found ${orchestrateCodexManifest?.version})`);
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


// ─── The orchestrate pair: skills-only ────────────────────────────────────────
// Automatic delegation pressure is OFF. `/orchestrate` remains as an INVOKE-ONLY
// skill on both providers, and the two things that made it automatic are gone:
// the `always-on.md` standing directive that told every session to load it, and
// the `dispatch-first` PreToolUse guard that BLOCKED a coordinator from reading
// source or running a check before dispatching.
//
// So the orchestrate pair is now the same shape as `concise` — skills and
// nothing that activates on its own. That shape is the assertion: a hooks file,
// an always-on.md, or a manifest `hooks` field reappearing here would silently
// restore the pressure, and reading the skill would not reveal it. Checked in
// both directions: the skill present here and absent from the workflow pair, the
// activation surface absent everywhere.
{
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

  // 2. NO ACTIVATION SURFACE — the concise-shaped rule. `/orchestrate` is
  //    invoke-only: nothing tells a session to load it and nothing gates a
  //    session that does not. Any of these reappearing restores the automatic
  //    pressure the operator turned off, so name each one explicitly rather than
  //    leaving it to the reader to notice an added file.
  for (const dir of ['plugins/orchestrate', 'plugins/orchestrate-agents']) {
    for (const activationPath of [
      `${dir}/always-on.md`,
      `${dir}/.nanoclaw-always-on.md`,
      `${dir}/hooks`,
    ]) {
      if (exists(activationPath)) {
        fail(`${activationPath} must not exist; ${dir} is invoke-only, with no standing directive and no hooks`);
      }
    }
  }
  if (orchestrateClaudeManifest?.hooks !== undefined) {
    fail('plugins/orchestrate/.claude-plugin/plugin.json must not declare hooks; /orchestrate is invoke-only');
  }
  if (orchestrateCodexManifest?.hooks !== undefined) {
    fail('plugins/orchestrate-agents/.codex-plugin/plugin.json must not declare hooks; /orchestrate is invoke-only');
  }
  if (exists('plugins/workflow/always-on.md')) {
    fail('plugins/workflow/always-on.md must not exist; the orchestrate directive was removed, not relocated');
  }
  if (workflowHookManifest?.hooks?.SessionStart) {
    fail('plugins/workflow/hooks/workflow-hooks.json must not wire SessionStart; its only job was catting the orchestrate directive, which is gone');
  }

  // 3. THE DISPATCH-FIRST GUARD IS GONE — from every tree. It BLOCKED a
  //    coordinator from reading implementation source or running checks before
  //    dispatching; with automatic delegation off, that gate is exactly what an
  //    operator working directly must not hit. A copy left anywhere could still
  //    be wired.
  for (const stale of [
    'plugins/orchestrate/hooks/guards/dispatch-first.ts',
    'plugins/orchestrate/hooks/guards/dispatch-first-core.ts',
    'plugins/workflow/hooks/guards/dispatch-first.ts',
    'plugins/workflow/hooks/guards/dispatch-first-core.ts',
    'plugins/workflow/hooks/guards/dispatch-first-core.test.ts',
    'plugins/workflow/hooks/guards/dispatch-first.test.ts',
    'plugins/workflow-agents/hooks/guards/dispatch-first-core.ts',
  ]) {
    if (exists(stale)) {
      fail(`${stale} must not exist; the dispatch-first guard was removed when automatic delegation pressure was turned off`);
    }
  }
  if (workflowHookText.includes('dispatch-first')) {
    fail('plugins/workflow/hooks/workflow-hooks.json must not register the dispatch-first guard; it would gate direct work');
  }
  for (const skillFile of [
    'plugins/orchestrate/skills/orchestrate/SKILL.md',
    'plugins/orchestrate-agents/skills/orchestrate/SKILL.md',
  ]) {
    const text = readText(skillFile);
    if (text !== undefined && /dispatch-first/.test(text)) {
      fail(`${skillFile} must not reference the dispatch-first guard; it no longer exists`);
    }
  }

  // The guards the workflow plugin KEEPS. Removing the dispatch-first guard must
  // not take a safety guard with it — those protect the operator whether or not
  // they are delegating.
  const RETAINED_WORKFLOW_GUARDS = [
    'guards/block-destructive.ts',
    'guards/file-protection.ts',
    'guards/block-askuser-during-auto.ts',
  ];
  for (const guard of RETAINED_WORKFLOW_GUARDS) {
    if (!workflowHookText.includes(guard)) {
      fail(`plugins/workflow/hooks/workflow-hooks.json must still register ${guard}`);
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
  // frontier-worker.mjs statically imports ./worker-policy.generated.mjs for its
  // model ids and tier efforts. A static import of a file the installed cache
  // does not materialize is a load-time crash, not a missing feature, so every
  // plugin shipping the transport must ship the generated policy beside it. The
  // VALUES are gated by parity-lint (generated == the one policy file); this is
  // the co-location half.
  if (!exists(POLICY_PATH)) {
    fail(`${POLICY_PATH} must stay in the workflow plugin; it is the one source of the worker model/effort policy`);
  }
  for (const plugin of POLICY_CONSUMER_PLUGINS) {
    const generated = `${plugin}/scripts/${GENERATED_POLICY_BASENAME}`;
    if (!exists(generated)) {
      fail(`${generated} must ship; ${plugin}/scripts/frontier-worker.mjs statically imports it and a plugin cannot import across the boundary`);
    }
  }

  // Manifest shape.
  if (orchestrateClaudeManifest?.name !== 'bootstrap-orchestrate') {
    fail('plugins/orchestrate/.claude-plugin/plugin.json name must be bootstrap-orchestrate');
  }
  if (orchestrateCodexManifest?.name !== 'bootstrap-orchestrate-agents') {
    fail('plugins/orchestrate-agents/.codex-plugin/plugin.json name must be bootstrap-orchestrate-agents');
  }
  if (normalizeSource(orchestrateClaudeManifest?.skills) !== './skills') {
    fail('plugins/orchestrate/.claude-plugin/plugin.json skills must point at ./skills/');
  }
  if (normalizeSource(orchestrateCodexManifest?.skills) !== './skills') {
    fail('plugins/orchestrate-agents/.codex-plugin/plugin.json skills must point at ./skills/');
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
  // levels, so `plugins/bootstrap/plugins/wwbd` is found and its
  // `wwbd-hooks.json` loads with no NanoClaw change at all. The orchestrate pair
  // declares no hooks, so there is nothing to load for it either way.
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
