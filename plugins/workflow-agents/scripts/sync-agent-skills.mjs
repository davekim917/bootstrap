#!/usr/bin/env node
/**
 * Generate the Codex/OpenCode workflow skills tree from its canonical Claude
 * source.
 *
 *   bootstrap-workflow (plugins/workflow) → bootstrap-workflow-agents (plugins/workflow-agents)
 *
 * The seven `team-*` skills and the shared contracts are authored once in
 * `plugins/workflow/skills/` and copied here with only schema/path
 * substitutions. `skills/shared/` is copied rather than referenced across the
 * plugin boundary: an installed marketplace cache materializes only the plugin's
 * own subtree, so a relative path leaving the plugin would resolve in this
 * checkout and be missing on every real install (the same reason the guard cores
 * are vendored rather than cross-imported — scripts/vendor-guards.mjs:11-16).
 * `evals/harness/parity-lint.mjs` fails if a copy drifts.
 *
 * Usage:
 *   node plugins/workflow-agents/scripts/sync-agent-skills.mjs
 *   node plugins/workflow-agents/scripts/sync-agent-skills.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The one canonical home of every shared contract file. */
export const CANONICAL_SHARED = path.join(REPO, 'plugins/workflow/skills/shared');

export const TEAM_SKILLS = [
  'team-plan',
  'team-build',
  'team-review',
  'team-auto',
  'team-debug',
  'team-ship',
  'team-retro',
];

const SHARED = [
  'workflow-contract.md',
  'cross-model-review.md',
  'references/CODEX-SOURCES.md',
  'references/codex-adversarial-prompt.md',
  'references/codex-review-output.schema.json',
];

export const CLAUDE_SKILLS = path.join(REPO, 'plugins/workflow/skills');
export const AGENT_SKILLS = path.join(REPO, 'plugins/workflow-agents/skills');

/** Mechanical substitutions for schema/path differences only. */
export function transformSkill(text) {
  return text
    .replace(/^user-invocable:\s*(?:true|false)\s*\n/m, '')
    .replace(/\.claude\/tmp/g, '.agents/tmp/bootstrap-workflow')
    .replace(/(?<![./\w])CLAUDE\.md/g, 'AGENTS.md/CLAUDE.md');
}

/**
 * What the generated skills tree must contain, keyed by path relative to its
 * `skills/` root. `transform` is applied to SKILL.md only; the shared contracts
 * stay byte-identical, which is exactly what parity-lint checks.
 */
function expectedFiles() {
  const files = new Map();
  for (const skill of TEAM_SKILLS) {
    const source = path.join(CLAUDE_SKILLS, skill, 'SKILL.md');
    if (!fs.existsSync(source)) throw new Error(`missing canonical skill: ${source}`);
    files.set(path.join(skill, 'SKILL.md'), transformSkill(fs.readFileSync(source, 'utf8')));
  }
  for (const name of SHARED) {
    const source = path.join(CANONICAL_SHARED, name);
    if (!fs.existsSync(source)) throw new Error(`missing canonical shared contract: ${source}`);
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

function removeEmptyParents(root, file) {
  let dir = path.dirname(file);
  while (dir !== root && dir.startsWith(`${root}${path.sep}`)) {
    if (fs.readdirSync(dir).length > 0) break;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

function removeUnexpectedEmptyDirectories(root, expected) {
  const directories = existingDirectories(root).sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  for (const relative of directories) {
    const prefix = `${relative}${path.sep}`;
    const belongs = [...expected.keys()].some(
      (file) => file === relative || file.startsWith(prefix),
    );
    if (!belongs) {
      const target = path.join(root, relative);
      if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    }
  }
}

/**
 * Reconcile the generated tree against its expectation. Returns the failure
 * lines a `--check` run should print; in write mode it writes and returns [].
 */
function reconcile({ label, root, expected, expectedTopLevel, check }) {
  const problems = [];
  const actual = existingFiles(root);
  const stale = [];

  for (const [relative, content] of expected) {
    const destination = path.join(root, relative);
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
      const target = path.join(root, relative);
      fs.unlinkSync(target);
      removeEmptyParents(root, target);
    }
    removeUnexpectedEmptyDirectories(root, expected);
  }

  const unexpectedDirectories = existingDirectories(root).filter((relative) => {
    const topLevel = relative.split(path.sep)[0];
    return !expectedTopLevel.has(topLevel);
  });

  if (check) {
    if (stale.length) problems.push(`${label}: stale or missing:\n  ${stale.join('\n  ')}`);
    if (unexpected.length) {
      problems.push(`${label}: unexpected generated-tree files:\n  ${unexpected.join('\n  ')}`);
    }
    if (unexpectedDirectories.length) {
      problems.push(
        `${label}: unexpected generated-tree directories:\n  ${unexpectedDirectories.join('\n  ')}`,
      );
    }
  }
  return problems;
}

function main() {
  const check = process.argv.includes('--check');
  const problems = reconcile({
    label: 'sync-agent-skills[workflow-agents]',
    root: AGENT_SKILLS,
    expected: expectedFiles(),
    expectedTopLevel: new Set([...TEAM_SKILLS, 'shared']),
    check,
  });

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }

  const action = check ? 'verified' : 'generated';
  console.log(
    `sync-agent-skills: ${action} ${TEAM_SKILLS.length} skills and ${SHARED.length} shared contracts `
    + 'in plugins/workflow-agents',
  );
}

// Run only as a script. Importing this module (parity-lint reads its constants)
// must never regenerate the tree a --check run is about to verify.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
