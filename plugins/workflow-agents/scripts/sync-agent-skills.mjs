#!/usr/bin/env node
/**
 * Generate the complete Codex/OpenCode workflow skill distribution from the
 * canonical Claude tree.
 *
 * Usage:
 *   node plugins/workflow-agents/scripts/sync-agent-skills.mjs
 *   node plugins/workflow-agents/scripts/sync-agent-skills.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLAUDE = path.join(REPO, 'plugins/workflow/skills');
const AGENTS = path.join(REPO, 'plugins/workflow-agents/skills');

const SKILLS = [
  'team-plan',
  'team-build',
  'team-review',
  'team-auto',
  'team-debug',
  'team-ship',
  'team-retro',
];

const SHARED = ['workflow-contract.md', 'cross-model-review.md'];

/** Mechanical substitutions for schema/path differences only. */
export function transformSkill(text) {
  return text
    .replace(/^user-invocable:\s*(?:true|false)\s*\n/m, '')
    .replace(/\.claude\/tmp/g, '.agents/tmp/bootstrap-workflow')
    .replace(/(?<![./\w])CLAUDE\.md/g, 'AGENTS.md/CLAUDE.md');
}

function expectedFiles() {
  const files = new Map();
  for (const skill of SKILLS) {
    const source = path.join(CLAUDE, skill, 'SKILL.md');
    if (!fs.existsSync(source)) {
      throw new Error(`missing canonical skill: ${source}`);
    }
    files.set(
      path.join(skill, 'SKILL.md'),
      transformSkill(fs.readFileSync(source, 'utf8')),
    );
  }
  for (const name of SHARED) {
    const source = path.join(CLAUDE, 'shared', name);
    if (!fs.existsSync(source)) {
      throw new Error(`missing canonical shared contract: ${source}`);
    }
    files.set(path.join('shared', name), fs.readFileSync(source, 'utf8'));
  }
  return files;
}

function existingFiles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else found.push(path.relative(root, full));
    }
  };
  visit(root);
  return found.sort();
}

function existingDirectories(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      found.push(path.relative(root, full));
      visit(full);
    }
  };
  visit(root);
  return found.sort();
}

function removeEmptyParents(file) {
  let dir = path.dirname(file);
  while (dir !== AGENTS && dir.startsWith(`${AGENTS}${path.sep}`)) {
    if (fs.readdirSync(dir).length > 0) break;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

function removeUnexpectedEmptyDirectories(expected) {
  const directories = existingDirectories(AGENTS).sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  for (const relative of directories) {
    const prefix = `${relative}${path.sep}`;
    const belongs = [...expected.keys()].some(
      (file) => file === relative || file.startsWith(prefix),
    );
    if (!belongs) {
      const target = path.join(AGENTS, relative);
      if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    }
  }
}

function main() {
  const check = process.argv.includes('--check');
  const expected = expectedFiles();
  const actual = existingFiles(AGENTS);
  const stale = [];

  for (const [relative, content] of expected) {
    const destination = path.join(AGENTS, relative);
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== content) {
      stale.push(relative);
      if (!check) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content);
      }
    }
  }

  const unexpected = actual.filter((relative) => !expected.has(relative));
  if (!check) {
    for (const relative of unexpected) {
      const target = path.join(AGENTS, relative);
      fs.unlinkSync(target);
      removeEmptyParents(target);
    }
    removeUnexpectedEmptyDirectories(expected);
  }

  const expectedTopLevel = new Set([...SKILLS, 'shared']);
  const unexpectedDirectories = existingDirectories(AGENTS).filter((relative) => {
    const topLevel = relative.split(path.sep)[0];
    return !expectedTopLevel.has(topLevel);
  });

  if (check && (stale.length || unexpected.length || unexpectedDirectories.length)) {
    if (stale.length) {
      console.error(`sync-agent-skills: stale or missing:\n  ${stale.join('\n  ')}`);
    }
    if (unexpected.length) {
      console.error(`sync-agent-skills: unexpected generated-tree files:\n  ${unexpected.join('\n  ')}`);
    }
    if (unexpectedDirectories.length) {
      console.error(
        `sync-agent-skills: unexpected generated-tree directories:\n  ${unexpectedDirectories.join('\n  ')}`,
      );
    }
    process.exit(1);
  }

  const action = check ? 'verified' : 'generated';
  console.log(
    `sync-agent-skills: ${action} ${SKILLS.length} skills and ${SHARED.length} shared contracts`,
  );
}

main();
