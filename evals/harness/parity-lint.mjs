#!/usr/bin/env node
/**
 * Deterministic workflow contract gate.
 *
 * This intentionally does not compare heading counts or document length. The two runtime
 * plugins may express native dispatch differently; parity means they expose the same small
 * public surface and preserve the safety and review contracts that matter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLUGINS } from './lib.mjs';
import {
  WORKER_AGENT,
  frontmatterScalar,
  parseAgentDef,
  renderCodexAgentToml,
} from '../../plugins/workflow-agents/scripts/codex-agent-toml.mjs';
import {
  GENERATED_POLICY_BASENAME,
  POLICY_CONSUMER_PLUGINS,
  POLICY_PATH,
  applyAgentDefPolicy,
  loadWorkerPolicy,
  policyProseTokens,
  renderPolicyModule,
} from '../../plugins/workflow-agents/scripts/worker-policy.mjs';

/** Repo root, derived from wherever the plugins tree is (lib.mjs honours an override). */
const REPO = path.dirname(PLUGINS);

/**
 * The workflow pair's public surface. `orchestrate` is NOT here: it ships in its
 * own plugin pair (bootstrap-orchestrate / bootstrap-orchestrate-agents) so the
 * operator can disable automatic delegation pressure while the explicitly-invoked
 * team skills keep working. Its inventory is EXPECTED_ORCHESTRATE_SKILLS.
 */
export const EXPECTED_SKILLS = Object.freeze([
  'team-auto',
  'team-build',
  'team-debug',
  'team-plan',
  'team-retro',
  'team-review',
  'team-ship',
]);

export const EXPECTED_ORCHESTRATE_SKILLS = Object.freeze(['orchestrate']);

/** Worker tiers retired in 5.x; their return in any contract copy is a regression. */
const RETIRED_WORKER_POLICY = ['worker-fast', 'worker-high', 'worker-codex', 'gpt-5.6-luna'];

export const RETIRED_SKILLS = Object.freeze([
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
]);

export const SHARED_CONTRACTS = Object.freeze([
  'cross-model-review.md',
  'workflow-contract.md',
]);

const CLAUDE_ROOT = path.join(PLUGINS, 'workflow', 'skills');
const AGENT_ROOT = path.join(PLUGINS, 'workflow-agents', 'skills');
const ORCHESTRATE_CLAUDE_ROOT = path.join(PLUGINS, 'orchestrate', 'skills');
const ORCHESTRATE_AGENT_ROOT = path.join(PLUGINS, 'orchestrate-agents', 'skills');

export function normalizeWhitespace(value) {
  return value.replace(/\\\s*\n/g, ' ').replace(/\s+/g, ' ').trim();
}

export function skillInventory(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

export function frontmatterFields(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  return new Map(
    [...match[1].matchAll(/^([A-Za-z][\w-]*):\s*(.*)$/gm)]
      .map((entry) => [entry[1], entry[2]]),
  );
}

function requireTokens(failures, label, content, tokens) {
  const normalized = normalizeWhitespace(content);
  for (const token of tokens) {
    if (!normalized.includes(normalizeWhitespace(token))) {
      failures.push(`${label}: missing contract ${JSON.stringify(token)}`);
    }
  }
}

export function evaluateContracts({
  claudeRoot = CLAUDE_ROOT,
  agentRoot = AGENT_ROOT,
  orchestrateClaudeRoot = ORCHESTRATE_CLAUDE_ROOT,
  orchestrateAgentRoot = ORCHESTRATE_AGENT_ROOT,
} = {}) {
  const failures = [];
  const checks = [];
  // Loaded once and threaded through: every model/effort assertion below is
  // derived from it, so the gate demands whatever the policy file says today.
  const policy = loadWorkerPolicy(REPO);
  const workflowInventories = [
    ['Claude', claudeRoot, skillInventory(claudeRoot), EXPECTED_SKILLS, 'seven team skills'],
    ['Codex/OpenCode', agentRoot, skillInventory(agentRoot), EXPECTED_SKILLS, 'seven team skills'],
  ];
  const orchestrateInventories = [
    ['Claude/orchestrate', orchestrateClaudeRoot, skillInventory(orchestrateClaudeRoot), EXPECTED_ORCHESTRATE_SKILLS, 'the orchestrate skill'],
    ['Codex/OpenCode/orchestrate', orchestrateAgentRoot, skillInventory(orchestrateAgentRoot), EXPECTED_ORCHESTRATE_SKILLS, 'the orchestrate skill'],
  ];
  const inventories = [...workflowInventories, ...orchestrateInventories];

  for (const [label, root, inventory, expected, description] of inventories) {
    if (JSON.stringify(inventory) !== JSON.stringify([...expected])) {
      failures.push(`${label}: expected exactly ${expected.join(', ')}; found ${inventory.join(', ')}`);
    } else {
      checks.push(`${label}: ${description}`);
    }
    for (const retired of RETIRED_SKILLS) {
      if (fs.existsSync(path.join(root, retired))) {
        failures.push(`${label}: retired skill directory remains: ${retired}`);
      }
    }
    for (const skill of inventory) {
      const skillPath = path.join(root, skill, 'SKILL.md');
      const fields = frontmatterFields(fs.readFileSync(skillPath, 'utf8'));
      if (!fields?.get('name') || !fields?.get('description')) {
        failures.push(`${label}/${skill}: SKILL.md needs name and description frontmatter`);
      }
    }
  }

  // THE CRUX OF THE ORCHESTRATE SPLIT.
  //
  // `skills/orchestrate/SKILL.md` opens with "Read `../shared/workflow-contract.md`
  // first", and that contract is shared with the seven team-* skills. A relative
  // path cannot leave a plugin: an installed marketplace cache materializes only
  // the plugin's own subtree, so `plugins/orchestrate` reaching into
  // `plugins/workflow` would resolve in this checkout and be MISSING on every real
  // install — and a missing contract reference does not fail loudly. The skill
  // would quietly degrade to whatever the model remembers of the contract.
  //
  // So each plugin carries its own copy, generated from one canonical tree
  // (plugins/workflow/skills/shared) by sync-agent-skills.mjs. The cost of that
  // choice is drift, and THIS is the gate that pays it: every copy compared
  // byte-for-byte against the canonical one, in every tree that has it.
  const sharedRoots = [
    ['Codex/OpenCode', agentRoot],
    ['Claude/orchestrate', orchestrateClaudeRoot],
    ['Codex/OpenCode/orchestrate', orchestrateAgentRoot],
  ];
  for (const shared of SHARED_CONTRACTS) {
    const claudePath = path.join(claudeRoot, 'shared', shared);
    if (!fs.existsSync(claudePath)) {
      failures.push(`shared/${shared}: canonical contract missing from the Claude workflow tree`);
      continue;
    }
    const canonical = fs.readFileSync(claudePath);
    let identical = true;
    for (const [label, root] of sharedRoots) {
      const copyPath = path.join(root, 'shared', shared);
      if (!fs.existsSync(copyPath)) {
        failures.push(`${label}: shared/${shared} must exist in every plugin that reads it`);
        identical = false;
        continue;
      }
      if (!canonical.equals(fs.readFileSync(copyPath))) {
        failures.push(
          `${label}: shared/${shared} must be byte-identical to the canonical copy — ` +
            'regenerate: node plugins/workflow-agents/scripts/sync-agent-skills.mjs',
        );
        identical = false;
      }
    }
    if (identical) checks.push(`shared/${shared}: byte-identical across ${sharedRoots.length + 1} plugin trees`);
  }

  const exactCommands = [
    `codex exec --ignore-user-config --model gpt-6-astra -c 'model_reasoning_effort="medium"' --ephemeral --yolo`,
    'claude -p --model claude-fable-5-1 --effort medium --safe-mode --no-session-persistence --permission-mode plan --tools "" --strict-mcp-config --output-format json',
  ];
  // Contract substance lives with whichever tree carries the file. After the
  // orchestrate split that is no longer one tree per runtime: the shared
  // contracts are in all four, `orchestrate/SKILL.md` only in the orchestrate
  // pair, and the team-* skills only in the workflow pair.
  for (const [label, root] of inventories.map(([l, r]) => [l, r])) {
    const reviewPath = path.join(root, 'shared', 'cross-model-review.md');
    if (!fs.existsSync(reviewPath)) continue;
    const review = fs.readFileSync(reviewPath, 'utf8');
    requireTokens(
      failures,
      `${label}/cross-model-review`,
      review,
      [
        ...exactCommands,
        '3600000',
        '60-minute',
        'missing',
        'unauthenticated',
        'unsupported',
        'timeout',
        'malformed',
        'degraded',
        'run.md',
      ],
    );
    requireTokens(failures, `${label}/cross-model-review`, review, [
      'artifact author, not the coordinator', 'fresh and independent',
      'Routine changes do not automatically require both gates',
      'explicit reviewer effort override',
    ]);

    const workflowPath = path.join(root, 'shared', 'workflow-contract.md');
    if (!fs.existsSync(workflowPath)) {
      failures.push(`${label}: shared/workflow-contract.md must exist wherever cross-model-review.md does`);
      continue;
    }
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    requireTokens(failures, `${label}/workflow`, workflow, [
      'unchanged exact artifact, relevant environment and command',
      'Invalidate affected evidence', 'maximum of 3 corrective rounds',
      'reconsider the root cause or test premise once',
      'Factual corrections and test-detail refinements do not reset authorization',
      'no mandatory exact test skeleton', 'human interruptions', 'escaped defects',
    ]);
    for (const retired of RETIRED_WORKER_POLICY) {
      if (workflow.includes(retired)) failures.push(`${label}/workflow: retired worker policy ${retired}`);
    }
  }

  // The orchestrate skill: its own pair only.
  for (const [label, root] of orchestrateInventories.map(([l, r]) => [l, r])) {
    const ownershipPath = path.join(root, 'orchestrate', 'SKILL.md');
    if (!fs.existsSync(ownershipPath)) continue;
    const ownership = fs.readFileSync(ownershipPath, 'utf8');
    requireTokens(failures, `${label}/orchestrate`, ownership, [
      'worker-frontier',
      // Policy-derived, not literals: flipping worker-policy.json changes what
      // this gate demands, so the skill has to be updated with it instead of the
      // gate being edited afterwards to match.
      policy.claude.model, policy.codex.model,
      `default worker at \`${policy.claude.effort}\` effort`,
      `${policy.claude.escalation.label} or ${policy.claude.label}`,
      `${policy.codex.escalation.label} or ${policy.codex.label}`,
      'same retained session', 'artifact author', '../../scripts/frontier-worker.mjs',
      'Sonnet/xhigh or Terra/xhigh', 'no file-count or cheap-first hurdle',
      'approved worker floor',
      'Never choose a worker below that floor',
    ]);
    for (const retired of RETIRED_WORKER_POLICY) {
      if (ownership.includes(retired)) failures.push(`${label}/orchestrate: retired worker policy ${retired}`);
    }
    // `../../scripts/frontier-worker.mjs` is plugin-relative. It resolves only if
    // this plugin carries its own mirror of the helper — the skill's reference
    // would otherwise point into bootstrap-workflow, which an installed cache
    // cannot see.
    const helper = path.join(root, '..', 'scripts', 'frontier-worker.mjs');
    if (!fs.existsSync(helper)) {
      failures.push(`${label}/orchestrate: SKILL.md names ../../scripts/frontier-worker.mjs but ${path.relative(PLUGINS, helper)} is missing`);
    } else {
      checks.push(`${label}/orchestrate: plugin-relative frontier-worker.mjs resolves`);
    }
  }

  // The team-* skills: the workflow pair only.
  for (const [label, root] of workflowInventories.map(([l, r]) => [l, r])) {
    const plan = path.join(root, 'team-plan', 'SKILL.md');
    if (!fs.existsSync(plan)) continue;
    requireTokens(failures, `${label}/team-plan`, fs.readFileSync(plan, 'utf8'), [
      'plan.md',
      'cross-model',
      'approval',
    ]);

    requireTokens(failures, `${label}/team-review`, fs.readFileSync(path.join(root, 'team-review', 'SKILL.md'), 'utf8'), [
      '--implementation',
      'approved plan',
      'implementation diff',
      'cross-model',
      'run.md',
    ]);

    requireTokens(failures, `${label}/team-auto`, fs.readFileSync(path.join(root, 'team-auto', 'SKILL.md'), 'utf8'), [
      '3 corrective rounds',
      'stops at anything that deploys',
      '.team-auto-active',
      'run.md',
    ]);
  }

  checkWorkerAgentTwin(failures, checks, policy);
  checkWorkerPolicyModules(failures, checks, policy);
  checkWorkerPolicyProse(failures, checks, policy, inventories);

  return { pass: failures.length === 0, checks, failures };
}

/**
 * The worker role is one agent def, shipped to both runtimes. Claude reads
 * `plugins/workflow/agents/<name>.md` (auto-discovered from the plugin root);
 * Codex has no plugin-agent mechanism at all, so it gets a generated role TOML
 * that `scripts/install-agent-roles.mjs` places in `<CODEX_HOME>/agents/`,
 * driven by the plugin's own SessionStart hook so a bare install needs no
 * manual step (`scripts/session-install-roles.mjs`).
 *
 * Byte-identity is impossible across the two formats, so what is checked is the
 * DERIVATION: the TOML must be exactly what the generator produces from the .md
 * right now, and its model must be the Codex model the generator declares. That
 * makes an edit to either side fail here instead of silently forking the role.
 */
function checkWorkerAgentTwin(failures, checks, policy) {
  const source = path.join(PLUGINS, 'workflow', 'agents', `${WORKER_AGENT}.md`);
  const twin = path.join(PLUGINS, 'workflow-agents', 'agents', `${WORKER_AGENT}.toml`);
  for (const [label, file] of [['Claude', source], ['Codex/OpenCode', twin]]) {
    if (!fs.existsSync(file)) {
      failures.push(`${label}/agents: ${WORKER_AGENT} must ship with the plugin (${path.relative(PLUGINS, file)})`);
      return;
    }
  }

  const markdown = fs.readFileSync(source, 'utf8');
  const { frontmatter } = parseAgentDef(markdown);
  if (frontmatterScalar(frontmatter, 'name') !== WORKER_AGENT) {
    failures.push(`Claude/agents: ${WORKER_AGENT}.md must declare \`name: ${WORKER_AGENT}\``);
  }

  // The def's own policy fields must already be what the policy file renders.
  // Checked BEFORE the TOML so a stale def reports itself rather than showing up
  // only as a mismatched Codex model.
  if (applyAgentDefPolicy(markdown, policy) !== markdown) {
    failures.push(
      `Claude/agents: ${WORKER_AGENT}.md model/effort/"Runs on" no longer match ${POLICY_PATH} — ` +
        'regenerate: node plugins/workflow-agents/scripts/sync-agent-skills.mjs',
    );
  } else {
    checks.push(`agents/${WORKER_AGENT}: Claude def model/effort derive from ${POLICY_PATH}`);
  }

  const expected = renderCodexAgentToml(markdown, policy.codex.model);
  if (fs.readFileSync(twin, 'utf8') !== expected) {
    failures.push(
      `Codex/OpenCode/agents: ${WORKER_AGENT}.toml is not the current render of ${WORKER_AGENT}.md — ` +
        'regenerate: node plugins/workflow-agents/scripts/sync-agent-skills.mjs',
    );
    return;
  }
  checks.push(`agents/${WORKER_AGENT}: Codex role TOML derives from the Claude def`);
}

/**
 * The generated policy module every frontier-worker.mjs imports.
 *
 * The transport used to carry the model ids as literals in four copies. Now it
 * imports them, and this is the gate that makes the import trustworthy: each
 * plugin must ship a copy, and each copy must be exactly what the policy file
 * renders today. A hand-edit to a copy and a policy edit without a regenerate
 * both fail here, and neither needs this gate to know a single model name.
 */
function checkWorkerPolicyModules(failures, checks, policy) {
  const expected = renderPolicyModule(policy);
  let allCurrent = true;
  for (const plugin of POLICY_CONSUMER_PLUGINS) {
    const file = path.join(REPO, plugin, 'scripts', GENERATED_POLICY_BASENAME);
    const relative = path.relative(REPO, file);
    if (!fs.existsSync(file)) {
      failures.push(`${relative}: must ship beside frontier-worker.mjs; it imports it and a plugin cannot read across the boundary`);
      allCurrent = false;
      continue;
    }
    if (fs.readFileSync(file, 'utf8') !== expected) {
      failures.push(
        `${relative}: not the current render of ${POLICY_PATH} — ` +
          'regenerate: node plugins/workflow-agents/scripts/sync-agent-skills.mjs',
      );
      allCurrent = false;
    }
  }
  if (allCurrent) {
    checks.push(`worker policy: ${GENERATED_POLICY_BASENAME} derives from ${POLICY_PATH} in ${POLICY_CONSUMER_PLUGINS.length} plugins`);
  }
}

/**
 * The prose surfaces that state the policy in words.
 *
 * `workflow-contract.md` weaves "Opus/Sol" and "Fable/Astra" through whole
 * paragraphs as adjectives; carving a generated block out of that would mean
 * rewriting the contract, so the prose stays hand-authored and this asserts it
 * still names the CURRENT roster. `orchestrate/SKILL.md` carries the policy too
 * and is checked more precisely above, against the exact model ids and the
 * "default worker at `<effort>` effort" phrase. Same limit either way, and the
 * same as NanoClaw's scripts/dispatch-default-docs.test.ts: it proves the doc
 * states the current policy, not that it carries no sentence contradicting it.
 */
function checkWorkerPolicyProse(failures, checks, policy, inventories) {
  const { shortLabels, efforts } = policyProseTokens(policy);
  const surfaces = inventories.map(
    ([label, root]) => [`${label}/workflow-contract`, path.join(root, 'shared', 'workflow-contract.md')],
  );
  for (const [label, file] of surfaces) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    const missing = [...shortLabels, ...efforts].filter((token) => !content.includes(token));
    if (missing.length > 0) {
      failures.push(
        `${label}: prose no longer names the current worker policy (${POLICY_PATH}); missing ${missing.map((t) => JSON.stringify(t)).join(', ')}`,
      );
    } else {
      checks.push(`${label}: prose names the current worker policy tiers and efforts`);
    }
  }
}

function main() {
  const unsupported = process.argv.slice(2).filter((arg) => arg !== '--all');
  if (unsupported.length > 0) {
    console.error('usage: parity-lint.mjs --all');
    process.exit(2);
  }
  const result = evaluateContracts();
  console.log('\n[workflow-contracts]');
  for (const check of result.checks) console.log(`  ✓ ${check}`);
  for (const failure of result.failures) console.log(`  ✗ ${failure}`);
  console.log(`\n[workflow-contracts] ${result.pass ? 'PASS' : `FAIL (${result.failures.length})`}`);
  process.exit(result.pass ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
