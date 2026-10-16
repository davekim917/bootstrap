#!/usr/bin/env node
/**
 * Version-bump gate: a change under plugins/<p>/ must bump that plugin's version in every manifest it ships
 * (.claude-plugin/plugin.json, .codex-plugin/plugin.json) and in every marketplace entry that points at it.
 * Installs and the Codex marketplace key off the plugin-level version, so an unbumped change sits on main and
 * reaches no machine that installs from the marketplace.
 *
 * Usage: node scripts/check-version-bump.mjs --base <git ref>   (CI passes the pull request's base)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKETPLACES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];
const MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];

function entrySource(entry) {
  const raw = typeof entry.source === 'string' ? entry.source : entry.source?.path;
  if (typeof raw !== 'string') return null;
  const match = /^\.\/plugins\/([^/]+)\/?$/.exec(raw);
  return match ? match[1] : null;
}

function semver(version) {
  const m = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
  return m ? m.slice(1).map(Number) : null;
}

function greater(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function parse(text, label) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

/**
 * `read(side, file)` returns a file's text on side 'base' or 'head', or null when absent there.
 * Returns the list of problems; empty means the change is publishable.
 */
export function checkVersionBumps({ changedPaths, read }) {
  const problems = [];
  const changedPlugins = new Set();
  for (const file of changedPaths) {
    const match = /^plugins\/([^/]+)\//.exec(file);
    if (match) changedPlugins.add(match[1]);
  }

  const versions = (side) => {
    const found = new Map();
    for (const marketplace of MARKETPLACES) {
      const doc = parse(read(side, marketplace), `${side}:${marketplace}`);
      for (const entry of doc?.plugins ?? []) {
        const plugin = entrySource(entry);
        if (plugin) found.set(`${marketplace}#${entry.name}`, { plugin, version: entry.version });
      }
    }
    return found;
  };
  const baseEntries = versions('base');
  const headEntries = versions('head');

  for (const plugin of [...changedPlugins].sort()) {
    const surfaces = [];
    for (const manifest of MANIFESTS) {
      const file = `plugins/${plugin}/${manifest}`;
      const head = parse(read('head', file), `head:${file}`);
      if (!head) continue;
      const base = parse(read('base', file), `base:${file}`);
      surfaces.push({ label: file, base: base?.version, head: head.version, existedAtBase: base !== null });
    }
    for (const [key, entry] of headEntries) {
      if (entry.plugin !== plugin) continue;
      const base = baseEntries.get(key);
      surfaces.push({
        label: key.replace('#', ' entry '),
        base: base?.version,
        head: entry.version,
        existedAtBase: base !== undefined,
      });
    }
    if (surfaces.length === 0) continue;
    if (!surfaces.some((surface) => surface.existedAtBase)) continue;

    const headVersions = new Set(surfaces.map((surface) => surface.head));
    if (headVersions.size > 1) {
      problems.push(
        `plugins/${plugin}: versions disagree (${surfaces.map((s) => `${s.label}=${s.head}`).join(', ')}); set one version everywhere`,
      );
    }
    for (const surface of surfaces) {
      const head = semver(surface.head);
      if (!head) {
        problems.push(`plugins/${plugin}: ${surface.label} has version ${JSON.stringify(surface.head)}, not MAJOR.MINOR.PATCH`);
        continue;
      }
      if (!surface.existedAtBase) continue;
      if (surface.base === surface.head) {
        problems.push(
          `plugins/${plugin} changed but ${surface.label} is still ${surface.head}; bump the plugin version in every manifest and marketplace entry`,
        );
        continue;
      }
      const base = semver(surface.base);
      if (base && !greater(head, base)) {
        problems.push(`plugins/${plugin}: ${surface.label} goes from ${surface.base} to ${surface.head}; a bump must increase the version`);
      }
    }
  }
  return problems;
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readAt(repo, ref, file) {
  try {
    return git(repo, ['show', `${ref}:${file}`]);
  } catch {
    return null;
  }
}

function main(argv) {
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : undefined;
  if (!base) {
    console.error('usage: check-version-bump.mjs --base <git ref>');
    return 2;
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const mergeBase = git(repo, ['merge-base', base, 'HEAD']).trim();
  const changedPaths = git(repo, ['diff', '--name-only', '--no-renames', mergeBase, 'HEAD']).split('\n').filter(Boolean);
  const problems = checkVersionBumps({
    changedPaths,
    read: (side, file) => readAt(repo, side === 'base' ? mergeBase : 'HEAD', file),
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    return 1;
  }
  console.log('version-bump: every changed plugin is bumped in all of its manifests and marketplace entries.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
