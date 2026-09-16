#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_AGENT_NAMES, discoverRetiredAgents } from './retire-bootstrap-agents.mjs';

/** The five effort shims the orchestrate plugin dispatches to, one per level. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

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
const orchestrateCodexManifest = readJson('plugins/orchestrate/.codex-plugin/plugin.json');
const wwbdClaudeManifest = readJson('plugins/wwbd/.claude-plugin/plugin.json');
const wwbdCodexManifest = readJson('plugins/wwbd/.codex-plugin/plugin.json');
const conciseClaudeManifest = readJson('plugins/concise/.claude-plugin/plugin.json');
const conciseCodexManifest = readJson('plugins/concise/.codex-plugin/plugin.json');
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

// Supported roster: the workflow distribution plus the standalone single-source
// advisory and session-mode plugins. Anything else creeping into a marketplace is drift.
//
// `bootstrap-orchestrate` sources the SAME directory on both sides now. It was a
// Claude/Codex pair (plugins/orchestrate + plugins/orchestrate-agents) while it
// shipped a generated skill copy and a mirrored helper script; with neither left,
// the two manifests describe one skills-and-agents tree, the `wwbd` shape.
const codexRoster = new Map([
  ['bootstrap-workflow-agents', './plugins/workflow-agents'],
  ['bootstrap-orchestrate', './plugins/orchestrate'],
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

const codexOrchestrateEntry = codexEntries.find((entry) => entry.name === 'bootstrap-orchestrate');
if (!codexOrchestrateEntry) {
  fail('.agents/plugins/marketplace.json must register bootstrap-orchestrate');
} else if (normalizeSource(sourcePath(codexOrchestrateEntry)) !== './plugins/orchestrate') {
  fail('bootstrap-orchestrate must source ./plugins/orchestrate in .agents/plugins/marketplace.json');
} else if (codexOrchestrateEntry.version !== orchestrateCodexManifest?.version) {
  fail(
    `bootstrap-orchestrate version must match between the Codex marketplace and .codex-plugin manifest (${codexOrchestrateEntry.version} !== ${orchestrateCodexManifest?.version})`,
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

// SessionStart is GONE, and the allowlist is now a single event. It existed to
// copy a generated `worker-frontier` role TOML into `<CODEX_HOME>/agents/`,
// because Codex reads named roles only from there and a plugin cannot ship one.
// There is no role to install any more: `/orchestrate` names a model and an
// effort per dispatch instead of naming a role, so the installer, the role and
// the hook that ran it all went together. A SessionStart entry reappearing here
// would run a script into the user's Codex home on every session start, which is
// exactly the surface that was removed — so the closed list is the assertion.
if (codexHookManifest?.hooks?.SessionStart) {
  fail(
    'plugins/workflow-agents/hooks/workflow-hooks.json must not wire SessionStart; its only job was '
      + 'installing the retired worker role into the user\'s Codex home',
  );
}

const ALLOWED_CODEX_HOOK_EVENTS = ['PreToolUse'];
const codexHookEvents = Object.keys(codexHookManifest?.hooks ?? {});
const unexpectedHookEvents = codexHookEvents.filter(
  (event) => !ALLOWED_CODEX_HOOK_EVENTS.includes(event),
);
if (unexpectedHookEvents.length > 0) {
  fail(`plugins/workflow-agents/hooks/workflow-hooks.json contains unexpected hook events: ${unexpectedHookEvents.join(', ')}`);
}

if (!codexHookManifestText.includes('${PLUGIN_ROOT}/hooks/codex-guard.ts')) {
  fail('plugins/workflow-agents/hooks/workflow-hooks.json must resolve its guard through native ${PLUGIN_ROOT}');
}

// The role-install scripts the hook used to name. Each one left in the tree
// could still be wired by hand or by a stale manifest, so name them here rather
// than trusting the hook manifest alone.
for (const retiredScript of [
  'plugins/workflow-agents/scripts/session-install-roles.mjs',
  'plugins/workflow-agents/scripts/install-agent-roles.mjs',
  'plugins/workflow-agents/scripts/codex-agent-toml.mjs',
]) {
  if (exists(retiredScript)) {
    fail(`${retiredScript} is retired; there is no worker role to install into a Codex home`);
  }
}

if (claudeManifest?.name !== 'bootstrap-workflow') {
  fail('plugins/workflow/.claude-plugin/plugin.json name must be bootstrap-workflow');
}
if (claudeManifest?.version !== '5.7.0') {
  fail(`bootstrap-workflow release must be version 5.7.0 (found ${claudeManifest?.version})`);
}
if (codexManifest?.version !== '2.7.0') {
  fail(`bootstrap-workflow-agents release must be version 2.7.0 (found ${codexManifest?.version})`);
}
// One directory, two manifests: the version is pinned on both and they must agree.
if (orchestrateClaudeManifest?.version !== '2.0.0') {
  fail(`bootstrap-orchestrate release must be version 2.0.0 (found ${orchestrateClaudeManifest?.version})`);
}
if (orchestrateCodexManifest?.version !== '2.0.0') {
  fail(`bootstrap-orchestrate .codex-plugin release must be version 2.0.0 (found ${orchestrateCodexManifest?.version})`);
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

// The ONE agents/ directory, and the shape of what is in it.
//
// Two bans are folded together here. The older one: a six-role advisor roster
// (architecture-advisor, cto-advisor and the rest — now RETIRED_AGENT_NAMES) was
// deleted in 53e9501 and must not come back. The newer one: `worker-frontier`,
// the single named worker role that replaced the roster, is gone too, along with
// the model/effort policy file that rendered its frontmatter and the Codex TOML
// twin an install hook copied into the user's home.
//
// What ships instead is five EFFORT SHIMS. They carry no instructions and name
// no model: `model: inherit` means the dispatch picks the model and the shim
// only pins the effort, which is the one thing a Claude Agent call cannot pass
// per-call. So the assertion is the absence of a role: exactly five files, one
// per level, each with `model: inherit`. A shim that pinned a model, or a sixth
// file with a behavioural body, would be a role wearing a shim's name.
{
  const dir = 'plugins/orchestrate/agents';
  const root = path.join(repoRoot, dir);
  const expected = EFFORT_LEVELS.map((level) => `delegate-${level}.md`).sort();
  if (!exists(dir)) {
    fail(`${dir} must ship the five effort shims so /orchestrate can dispatch on a bare install`);
  } else {
    const found = findFiles(root, (_full, entry) => entry.isFile() || entry.isSymbolicLink())
      .map((full) => path.relative(root, full))
      .sort();
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
      fail(`${dir} must contain exactly ${expected.join(', ')}; found ${found.join(', ') || '(nothing)'}`);
    }
    for (const name of found) {
      if (RETIRED_AGENT_NAMES.includes(path.parse(name).name)) {
        fail(`${dir}/${name} is a retired advisor role and must not return`);
      }
      const text = readText(`${dir}/${name}`);
      if (text === undefined) continue;
      if (!/^model:\s*inherit\s*$/m.test(text)) {
        fail(
          `${dir}/${name} must declare \`model: inherit\`; a shim that pins a model turns the effort `
            + 'level back into a role and takes the model choice away from the dispatch',
        );
      }
      const level = path.parse(name).name.replace(/^delegate-/, '');
      if (!new RegExp(`^effort:\\s*${level}\\s*$`, 'm').test(text)) {
        fail(`${dir}/${name} must declare \`effort: ${level}\`; the filename is the level it pins`);
      }
    }
  }
}

for (const retiredPath of [
  'plugins/domain',
  'plugins/tools',
  // The Claude/Codex orchestrate PAIR. One directory serves both runtimes now;
  // a second tree here would be a copy no generator maintains.
  'plugins/orchestrate-agents',
  // The named worker role, on both sides, and the policy file that rendered it.
  'plugins/workflow/agents',
  'plugins/workflow-agents/agents',
  'plugins/workflow/worker-policy.json',
  'plugins/workflow/hooks/guards/workflow-artifact-path.ts',
  'plugins/workflow/hooks/guards/workflow-gate-enforcement.ts',
  'plugins/workflow/hooks/guards/workflow-gate-enforcement.test.ts',
]) {
  const retiredRoot = path.join(repoRoot, retiredPath);
  // The list mixes directories and single files. `findFiles` walks a directory
  // and returns [] for a path that does not exist, but throws ENOTDIR on a
  // regular file — so a retired FILE is checked with a plain existence test.
  const remaining = fs.existsSync(retiredRoot) && fs.statSync(retiredRoot).isFile()
    ? [retiredRoot]
    : findFiles(retiredRoot, (_fullPath, entry) => entry.isFile() || entry.isSymbolicLink());
  if (remaining.length > 0) {
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
const orchestrateSkillsRoot = path.join(repoRoot, 'plugins/orchestrate/skills');
const codexSkills = skillNames(codexSkillsRoot);
const claudeSkills = skillNames(claudeSkillsRoot);

// The split: the workflow pair keeps the seven explicitly-invoked team skills,
// the orchestrate plugin owns the one delegation skill. `orchestrate` appearing
// in a workflow tree would put it back where disabling bootstrap-orchestrate
// cannot remove it.
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
{
  const actual = skillNames(orchestrateSkillsRoot).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedOrchestrateSkills)) {
    fail(`the orchestrate plugin must expose exactly ${expectedOrchestrateSkills.join(', ')} (found ${actual.join(', ') || '(nothing)'})`);
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

// `skills/shared/` is carried by BOTH workflow plugins, not shared by reference:
// an installed marketplace cache materializes only the plugin's own subtree, so
// `plugins/workflow-agents` cannot reach `../workflow/skills/shared/`. The copy is
// generated from the one canonical tree; this is the gate that fails if it drifts.
//
// The orchestrate plugin is no longer a consumer. `/orchestrate` used to open by
// reading this contract, which is why it carried a third and fourth copy; the
// rewritten skill is self-contained, so it ships no `shared/` at all.
const CANONICAL_SHARED_DIR = 'plugins/workflow/skills/shared';
const SHARED_COPY_DIRS = ['plugins/workflow-agents/skills/shared'];
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
  path.join(repoRoot, 'plugins', 'orchestrate', '.codex-plugin', 'plugin.json'),
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
    path.join(repoRoot, 'plugins', 'orchestrate', 'agents'),
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


// ─── The orchestrate plugin: one skill, five effort shims ─────────────────────
// Automatic delegation pressure is OFF. `/orchestrate` is an INVOKE-ONLY skill on
// every runtime, and the two things that made it automatic are gone: the
// `always-on.md` standing directive that told every session to load it, and the
// `dispatch-first` PreToolUse guard that BLOCKED a coordinator from reading
// source or running a check before dispatching.
//
// So the plugin is the same shape as `concise` — content and nothing that
// activates on its own. That shape is the assertion: a hooks file, an
// always-on.md, or a manifest `hooks` field reappearing here would silently
// restore the pressure, and reading the skill would not reveal it. Checked in
// both directions: the skill present here and absent from the workflow pair, the
// activation surface absent everywhere.
{
  const workflowHookManifest = readJson('plugins/workflow/hooks/workflow-hooks.json');
  const workflowHookText = readText('plugins/workflow/hooks/workflow-hooks.json') ?? '';

  // 1. THE SKILL — one copy, in the orchestrate plugin, gone from the workflow
  //    pair. Both manifests point at this same tree, so there is no second copy
  //    to keep in sync and no generator to run.
  if (!exists('plugins/orchestrate/skills/orchestrate/SKILL.md')) {
    fail('the orchestrate plugin must ship plugins/orchestrate/skills/orchestrate/SKILL.md');
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
  for (const activationPath of [
    'plugins/orchestrate/always-on.md',
    'plugins/orchestrate/.nanoclaw-always-on.md',
    'plugins/orchestrate/hooks',
  ]) {
    if (exists(activationPath)) {
      fail(`${activationPath} must not exist; plugins/orchestrate is invoke-only, with no standing directive and no hooks`);
    }
  }
  if (orchestrateClaudeManifest?.hooks !== undefined) {
    fail('plugins/orchestrate/.claude-plugin/plugin.json must not declare hooks; /orchestrate is invoke-only');
  }
  if (orchestrateCodexManifest?.hooks !== undefined) {
    fail('plugins/orchestrate/.codex-plugin/plugin.json must not declare hooks; /orchestrate is invoke-only');
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
  {
    const skillFile = 'plugins/orchestrate/skills/orchestrate/SKILL.md';
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

  // 4. NO HELPER CLI, ANYWHERE. `/orchestrate` used to name
  //    `../../scripts/frontier-worker.mjs`, a Node wrapper that shelled out to
  //    `claude -p` / `codex exec` with a validated model and effort — which meant
  //    every plugin whose skill named it had to carry its own mirror of the
  //    transport AND the generated policy module the transport imported. The
  //    rewritten skill dispatches through the runtime's own sub-agent tool, so
  //    there is no helper to mirror and no policy to render. A copy left in any
  //    plugin is a script the skill no longer names and nothing regenerates.
  for (const plugin of [
    'plugins/workflow',
    'plugins/workflow-agents',
    'plugins/orchestrate',
  ]) {
    for (const basename of ['frontier-worker.mjs', 'worker-policy.generated.mjs', 'worker-policy.mjs']) {
      if (exists(`${plugin}/scripts/${basename}`)) {
        fail(`${plugin}/scripts/${basename} is retired; /orchestrate dispatches through the runtime's own sub-agent tool`);
      }
    }
  }
  // The orchestrate plugin ships no scripts at all: a skill, five effort shims,
  // two manifests. Nothing here needs generating, so nothing here runs.
  if (exists('plugins/orchestrate/scripts')) {
    fail('plugins/orchestrate/scripts must not exist; the plugin is a skill plus five effort shims, with no code');
  }
  // …and no `shared/` either. Its old copy existed because the skill opened by
  // reading the workflow contract across a plugin boundary; the rewritten skill
  // is self-contained.
  if (exists('plugins/orchestrate/skills/shared')) {
    fail('plugins/orchestrate/skills/shared must not exist; the orchestrate skill is self-contained and reads no shared contract');
  }

  // Manifest shape. ONE directory, TWO manifests, one name — the `wwbd` shape.
  // The name must match on both sides or `codex plugin add bootstrap-orchestrate`
  // and `/plugin install bootstrap-orchestrate` would install different things.
  for (const [label, manifestPath, manifest] of [
    ['Claude', 'plugins/orchestrate/.claude-plugin/plugin.json', orchestrateClaudeManifest],
    ['Codex', 'plugins/orchestrate/.codex-plugin/plugin.json', orchestrateCodexManifest],
  ]) {
    if (manifest?.name !== 'bootstrap-orchestrate') {
      fail(`${manifestPath} name must be bootstrap-orchestrate`);
    }
    if (normalizeSource(manifest?.skills) !== './skills') {
      fail(`${manifestPath} skills must point at ./skills/ (${label})`);
    }
  }
  if (orchestrateClaudeManifest?.version !== orchestrateCodexManifest?.version) {
    fail(
      `plugins/orchestrate Claude and Codex manifests must share one version (${orchestrateClaudeManifest?.version} !== ${orchestrateCodexManifest?.version})`,
    );
  }
  // Claude also auto-discovers `agents/` from the plugin root, so the declaration
  // is belt-and-braces — but an explicit one that points at a directory the
  // plugin does not ship fails silently, as a dispatch to a subagent_type that
  // does not resolve.
  {
    const declared = orchestrateClaudeManifest?.agents;
    const roots = Array.isArray(declared) ? declared : [declared];
    if (!roots.includes('./agents')) {
      fail('plugins/orchestrate/.claude-plugin/plugin.json must declare "agents": ["./agents"]');
    }
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
  // `wwbd-hooks.json` loads with no NanoClaw change at all. The orchestrate
  // plugin declares no hooks, so there is nothing to load for it either way.
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
checkSkillMarkdownLinks(orchestrateSkillsRoot);
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
