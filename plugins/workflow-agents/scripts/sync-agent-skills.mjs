#!/usr/bin/env node
/**
 * Generate every mechanically-derived plugin artifact from its canonical Claude
 * source.
 *
 * There are two plugin PAIRS, and this script drives both:
 *
 *   bootstrap-workflow      (plugins/workflow)      → bootstrap-workflow-agents
 *   bootstrap-orchestrate   (plugins/orchestrate)   → bootstrap-orchestrate-agents
 *
 * It also maintains the CROSS-PAIR copies. `/orchestrate` reads
 * `../shared/workflow-contract.md`, and that contract is shared with the seven
 * `team-*` skills — but a relative path cannot leave a plugin: an installed
 * marketplace cache materializes only the plugin's own subtree, so
 * `plugins/orchestrate` reaching into `plugins/workflow` would resolve in this
 * checkout and be missing on every real install (the same reason the guard cores
 * are vendored rather than cross-imported — scripts/vendor-guards.mjs:11-16).
 * So the orchestrate pair carries its own byte-identical copy of `skills/shared/`,
 * generated here from the canonical `plugins/workflow/skills/shared/` and gated
 * by evals/harness/parity-lint.mjs, which fails if any copy diverges.
 *
 * Usage:
 *   node plugins/workflow-agents/scripts/sync-agent-skills.mjs
 *   node plugins/workflow-agents/scripts/sync-agent-skills.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODEX_WORKER_MODEL, WORKER_AGENT, renderCodexAgentToml } from './codex-agent-toml.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The one canonical home of every shared contract file, for both pairs. */
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

export const ORCHESTRATE_SKILLS = ['orchestrate'];

const SHARED = [
  'workflow-contract.md',
  'cross-model-review.md',
  'references/CODEX-SOURCES.md',
  'references/codex-adversarial-prompt.md',
  'references/codex-review-output.schema.json',
];

/**
 * Each pair: a canonical Claude plugin whose skills are authored by hand, and a
 * generated Codex/OpenCode twin. `shared/` in BOTH trees is generated from
 * CANONICAL_SHARED — which means the orchestrate pair's copy is generated even
 * on its Claude side, because its canonical source lives in the other plugin.
 */
/** The one canonical worker-transport helper, mirrored into the other plugins. */
export const HELPER_SOURCE = path.join(REPO, 'plugins/workflow/scripts/frontier-worker.mjs');

export const PAIRS = [
  {
    name: 'workflow',
    skills: TEAM_SKILLS,
    claude: path.join(REPO, 'plugins/workflow'),
    agents: path.join(REPO, 'plugins/workflow-agents'),
    // The canonical Claude tree authors its own shared/ in place.
    generateClaudeShared: false,
  },
  {
    name: 'orchestrate',
    skills: ORCHESTRATE_SKILLS,
    claude: path.join(REPO, 'plugins/orchestrate'),
    agents: path.join(REPO, 'plugins/orchestrate-agents'),
    generateClaudeShared: true,
  },
];


/** Mechanical substitutions for schema/path differences only. */
export function transformSkill(text) {
  return text
    .replace(/^user-invocable:\s*(?:true|false)\s*\n/m, '')
    .replace(/\.claude\/tmp/g, '.agents/tmp/bootstrap-workflow')
    .replace(/(?<![./\w])CLAUDE\.md/g, 'AGENTS.md/CLAUDE.md');
}

/**
 * What a generated skills tree must contain, keyed by path relative to that
 * tree's `skills/` root.
 *
 * `transform` is applied to SKILL.md only. For the Codex/OpenCode twin it is
 * `transformSkill` (schema/path substitutions); for the orchestrate pair's own
 * Claude `shared/` copy there is no transform at all — those files must stay
 * byte-identical to the canonical ones, which is exactly what parity-lint checks.
 */
function expectedFiles({ skillSource, skills, transform, includeSkills = true }) {
  const files = new Map();
  if (includeSkills) {
    for (const skill of skills) {
      const source = path.join(skillSource, skill, 'SKILL.md');
      if (!fs.existsSync(source)) {
        throw new Error(`missing canonical skill: ${source}`);
      }
      files.set(path.join(skill, 'SKILL.md'), transform(fs.readFileSync(source, 'utf8')));
    }
  }
  for (const name of SHARED) {
    const source = path.join(CANONICAL_SHARED, name);
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
 * Reconcile one generated tree against its expectation. Returns the failure
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

/** Copy one file verbatim; returns a failure line under --check when stale. */
function mirrorFile({ label, source, target, check }) {
  if (!fs.existsSync(source)) throw new Error(`missing canonical file: ${source}`);
  const content = fs.readFileSync(source);
  if (fs.existsSync(target) && content.equals(fs.readFileSync(target))) return null;
  if (check) return `${label}: stale or missing ${path.relative(REPO, target)}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return null;
}

function main() {
  const check = process.argv.includes('--check');
  const problems = [];
  let skillCount = 0;

  for (const pair of PAIRS) {
    skillCount += pair.skills.length;

    // Codex/OpenCode twin: transformed skills + shared contracts.
    problems.push(...reconcile({
      label: `sync-agent-skills[${pair.name}-agents]`,
      root: path.join(pair.agents, 'skills'),
      expected: expectedFiles({
        skillSource: path.join(pair.claude, 'skills'),
        skills: pair.skills,
        transform: transformSkill,
      }),
      expectedTopLevel: new Set([...pair.skills, 'shared']),
      check,
    }));

    // The orchestrate pair's Claude `shared/` is generated too: its canonical
    // source lives in plugins/workflow, and a relative path cannot cross a
    // plugin boundary on an installed cache. Skills there stay hand-authored.
    if (pair.generateClaudeShared) {
      problems.push(...reconcile({
        label: `sync-agent-skills[${pair.name}-shared]`,
        root: path.join(pair.claude, 'skills', 'shared'),
        expected: new Map(
          [...expectedFiles({ skills: [], transform: (t) => t, includeSkills: false })]
            .map(([relative, content]) => [path.relative('shared', relative), content]),
        ),
        expectedTopLevel: new Set(['references']),
        check,
      }));
    }

    // The build transport is authored once beside the canonical workflow plugin
    // and mirrored into every plugin whose orchestrate skill names it.
    if (pair.name !== 'workflow') {
      for (const target of [pair.claude, pair.agents]) {
        const problem = mirrorFile({
          label: `sync-agent-skills[${pair.name}]`,
          source: HELPER_SOURCE,
          target: path.join(target, 'scripts', 'frontier-worker.mjs'),
          check,
        });
        if (problem) problems.push(problem);
      }
    }
  }

  // workflow-agents keeps its own copy of the helper (it ships the scripts/ dir
  // the README documents), generated from the same canonical source.
  {
    const problem = mirrorFile({
      label: 'sync-agent-skills[workflow-agents]',
      source: HELPER_SOURCE,
      target: path.join(REPO, 'plugins/workflow-agents/scripts/frontier-worker.mjs'),
      check,
    });
    if (problem) problems.push(problem);
  }

  // The worker role: one Claude agent def in, one Codex role TOML out.
  const agentSource = path.join(REPO, `plugins/workflow/agents/${WORKER_AGENT}.md`);
  const agentTarget = path.join(REPO, `plugins/workflow-agents/agents/${WORKER_AGENT}.toml`);
  if (!fs.existsSync(agentSource)) throw new Error(`missing canonical agent def: ${agentSource}`);
  const agentToml = renderCodexAgentToml(fs.readFileSync(agentSource, 'utf8'), CODEX_WORKER_MODEL);
  const currentToml = fs.existsSync(agentTarget) ? fs.readFileSync(agentTarget, 'utf8') : null;
  if (currentToml !== agentToml) {
    if (check) {
      problems.push(`sync-agent-skills: stale or missing agents/${WORKER_AGENT}.toml`);
    } else {
      fs.mkdirSync(path.dirname(agentTarget), { recursive: true });
      fs.writeFileSync(agentTarget, agentToml);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }

  const action = check ? 'verified' : 'generated';
  console.log(
    `sync-agent-skills: ${action} ${skillCount} skills across ${PAIRS.length} plugin pairs, `
    + `${SHARED.length} shared contracts per tree and 1 agent role`,
  );
}

// Run only as a script. Importing this module (parity-lint reads its constants)
// must never regenerate the tree a --check run is about to verify.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
