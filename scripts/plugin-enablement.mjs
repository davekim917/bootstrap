#!/usr/bin/env node
/**
 * Resolve what a Claude Code session actually SEES for a given set of enabled
 * plugins — the skill listing, the PreToolUse hook commands, and the SessionStart
 * output.
 *
 * Why this exists: `/orchestrate` and the machinery that pushes a session toward
 * it were split into their own plugin so the operator can DISABLE automatic
 * delegation and still work directly. "Disabled" is not a flag inside our code;
 * it is a plugin missing from the enabled set, after which Claude Code composes
 * the session from the remaining plugins' manifests. A grep for a filename
 * cannot tell you whether that composition still gates a Read — only resolving
 * the manifests the way the host does, and then RUNNING what they name, can.
 * `plugin-enablement.test.mjs` does exactly that, in both states.
 *
 * Fidelity, stated plainly: this models the four composition rules the split
 * depends on — skills are the union of each enabled plugin's `skills/` dirs,
 * agents are the union of its `agents/` dirs, PreToolUse hooks are the union of
 * each enabled plugin's `hooks` manifest entries with `${CLAUDE_PLUGIN_ROOT}`
 * bound to that plugin's root, and SessionStart output is the concatenation of
 * those commands' stdout. It does not model Claude Code's settings file, plugin
 * namespacing, or matcher regex dialect beyond `new RegExp`. Those are the host's
 * business; what the split turns on is which commands exist and what they do when
 * run.
 *
 * Usage:
 *   node scripts/plugin-enablement.mjs bootstrap-workflow bootstrap-orchestrate
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every plugin the Claude marketplace offers, by name → absolute plugin root. */
export function claudeMarketplacePlugins(repoRoot = REPO) {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'),
  );
  const entries = new Map();
  for (const entry of marketplace.plugins ?? []) {
    const source = typeof entry.source === 'string' ? entry.source : entry.source?.path;
    entries.set(entry.name, path.resolve(repoRoot, source));
  }
  return entries;
}

function manifest(pluginRoot) {
  const file = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function hooksManifest(pluginRoot) {
  const declared = manifest(pluginRoot)?.hooks;
  if (typeof declared !== 'string') return null;
  const file = path.resolve(pluginRoot, declared);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * The skill names a session is offered: the union over enabled plugins of the
 * directories under each declared skills root that contain a SKILL.md.
 */
export function resolveSkills(pluginRoots) {
  const names = new Set();
  for (const pluginRoot of pluginRoots) {
    const declared = manifest(pluginRoot)?.skills ?? [];
    for (const rel of Array.isArray(declared) ? declared : [declared]) {
      const root = path.resolve(pluginRoot, rel);
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        if (fs.existsSync(path.join(root, entry, 'SKILL.md'))) names.add(entry);
      }
    }
  }
  return [...names].sort();
}

/**
 * The sub-agent names a session can dispatch to: the union over enabled plugins
 * of the `.md` files under each agents root.
 *
 * Roots come from the manifest's `agents` declaration, falling back to the
 * conventional `agents/` directory — Claude Code auto-discovers that one, so a
 * plugin can ship agents without declaring them and the composition must see
 * them either way. Names are the `name:` frontmatter where present, else the
 * basename; the host namespaces them as `<plugin>:<name>`, which this does not
 * model because what the split turns on is whether the definition is offered at
 * all.
 */
export function resolveAgents(pluginRoots) {
  const names = new Set();
  for (const pluginRoot of pluginRoots) {
    const declared = manifest(pluginRoot)?.agents ?? ['./agents'];
    for (const rel of Array.isArray(declared) ? declared : [declared]) {
      const root = path.resolve(pluginRoot, rel);
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        if (!entry.endsWith('.md')) continue;
        const text = fs.readFileSync(path.join(root, entry), 'utf8');
        const declaredName = /^name:[ \t]*(\S.*?)[ \t]*$/m.exec(text.split('\n---')[0] ?? '');
        names.add(declaredName ? declaredName[1] : entry.replace(/\.md$/, ''));
      }
    }
  }
  return [...names].sort();
}

/**
 * Every hook command registered for `event`, as the host would assemble it:
 * `${CLAUDE_PLUGIN_ROOT}` bound to the owning plugin's root.
 */
export function resolveHookCommands(pluginRoots, event) {
  const commands = [];
  for (const pluginRoot of pluginRoots) {
    const hooks = hooksManifest(pluginRoot)?.hooks?.[event] ?? [];
    for (const group of hooks) {
      for (const hook of group.hooks ?? []) {
        if (hook.type !== 'command' || typeof hook.command !== 'string') continue;
        commands.push({
          plugin: path.basename(pluginRoot),
          matcher: group.matcher,
          command: hook.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot),
        });
      }
    }
  }
  return commands;
}

/** The subset of `resolveHookCommands` whose matcher applies to `toolName`. */
export function hooksForTool(pluginRoots, toolName, event = 'PreToolUse') {
  return resolveHookCommands(pluginRoots, event).filter(
    (hook) => !hook.matcher || new RegExp(`^(?:${hook.matcher})$`).test(toolName),
  );
}

/** Run one resolved hook command with `payload` on stdin, as the host does. */
export function runHookCommand(command, payload, env = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  try {
    const stdout = execFileSync('bash', ['-c', command], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      exitCode: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

/** The standing instructions a session receives at SessionStart. */
export function resolveSessionStartText(pluginRoots) {
  return resolveHookCommands(pluginRoots, 'SessionStart')
    .map((hook) => runHookCommand(hook.command, '{}').stdout)
    .join('\n');
}

function main() {
  const available = claudeMarketplacePlugins();
  const names = process.argv.slice(2);
  const enabled = names.length > 0 ? names : [...available.keys()];
  const roots = enabled.map((name) => {
    const root = available.get(name);
    if (!root) throw new Error(`no such plugin in .claude-plugin/marketplace.json: ${name}`);
    return root;
  });

  console.log(`enabled: ${enabled.join(', ')}`);
  console.log(`skills:  ${resolveSkills(roots).join(', ') || '(none)'}`);
  console.log(`agents:  ${resolveAgents(roots).join(', ') || '(none)'}`);
  console.log('PreToolUse hooks:');
  for (const hook of resolveHookCommands(roots, 'PreToolUse')) {
    console.log(`  [${hook.plugin}] matcher=${hook.matcher ?? '*'} ${hook.command}`);
  }
  const sessionStart = resolveSessionStartText(roots).trim();
  console.log(`SessionStart text: ${sessionStart ? `${sessionStart.split('\n')[0]} …` : '(none)'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
