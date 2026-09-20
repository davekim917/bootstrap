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

/**
 * The workflow pair's public surface. `orchestrate` is NOT here: it ships in its
 * own plugin (bootstrap-orchestrate) so the operator can disable automatic
 * delegation pressure while the explicitly-invoked team skills keep working. Its
 * inventory is EXPECTED_ORCHESTRATE_SKILLS.
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

/**
 * Retired worker ROLE names. `worker-frontier` is the newest arrival: it was the
 * single named role the whole delegation contract pointed at, with a policy file
 * rendering its model and effort. `/orchestrate` now names a model and an effort
 * per dispatch instead, and the five `worker-<level>` shims it dispatches to
 * carry no instructions — so any of these reappearing is a role growing back.
 *
 * Checked in BOTH the workflow contract and the orchestrate skill, because a
 * role name has no legitimate use in either.
 *
 * `worker-high` was on this list and is REMOVED, deliberately: it is now a live
 * shim name (`agents/worker-high.md`). Leaving it would fail the gate on any doc
 * that legitimately names the shim, and the two are not the same thing — the
 * retired `worker-high` was a cheap tier in a ladder, this one is an effort level
 * with no model and no instructions behind it. Every name that stays is one no
 * shim can claim, because none of them is an effort level.
 */
const RETIRED_WORKER_ROLES = [
  'worker-fast',
  'worker-codex',
  'worker-frontier',
];

/**
 * Model ids that were WORKER TIERS in the retired ladder — checked in the
 * contract only.
 *
 * Split out from the role names because a model id, unlike a role name, has a
 * legitimate use: `/orchestrate <model> …` may name any model the runtime
 * accepts, `luna` included. Naming the id in the skill is the skill working;
 * naming it in the CONTRACT would mean a tier had been reinstated, which is the
 * thing worth catching — the same collision `worker-high` caused, and the same
 * resolution: narrow the check to where the name still means what the gate
 * thinks it means.
 */
const RETIRED_WORKER_TIER_MODELS = [
  'gpt-5.6-luna',
];

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
/** One tree, both runtimes — the orchestrate plugin is no longer a Claude/Codex pair. */
const ORCHESTRATE_ROOT = path.join(PLUGINS, 'orchestrate', 'skills');
/** The five effort shims live beside the skill, not under it. */
const ORCHESTRATE_AGENTS_ROOT = path.join(PLUGINS, 'orchestrate', 'agents');
const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

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
  orchestrateRoot = ORCHESTRATE_ROOT,
  orchestrateAgentsRoot = ORCHESTRATE_AGENTS_ROOT,
} = {}) {
  const failures = [];
  const checks = [];
  const workflowInventories = [
    ['Claude', claudeRoot, skillInventory(claudeRoot), EXPECTED_SKILLS, 'seven team skills'],
    ['Codex/OpenCode', agentRoot, skillInventory(agentRoot), EXPECTED_SKILLS, 'seven team skills'],
  ];
  const orchestrateInventories = [
    ['orchestrate', orchestrateRoot, skillInventory(orchestrateRoot), EXPECTED_ORCHESTRATE_SKILLS, 'the orchestrate skill'],
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

  // The seven team-* skills open with "Read `../shared/workflow-contract.md`
  // first". A relative path cannot leave a plugin: an installed marketplace cache
  // materializes only the plugin's own subtree, so `plugins/workflow-agents`
  // reaching into `plugins/workflow` would resolve in this checkout and be
  // MISSING on every real install — and a missing contract reference does not
  // fail loudly. The skills would quietly degrade to whatever the model remembers
  // of the contract.
  //
  // So the Codex tree carries its own copy, generated from the canonical tree
  // (plugins/workflow/skills/shared) by sync-agent-skills.mjs. The cost of that
  // choice is drift, and THIS is the gate that pays it: the copy compared
  // byte-for-byte against the canonical one.
  //
  // The orchestrate plugin is NOT in this list any more. It used to carry two more
  // copies because `/orchestrate` opened by reading the same contract; the
  // rewritten skill states its whole procedure inline and reads nothing.
  const sharedRoots = [
    ['Codex/OpenCode', agentRoot],
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
    'claude -p --model claude-fable-5-1 --effort medium --safe-mode --no-session-persistence --tools "" --strict-mcp-config --output-format json',
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
      'The retained owner implements, runs the checks and repairs failures',
      'Owner testing is not independent review',
      'Honor an explicit user override naming the check or its verification owner',
      'fork_turns: "none"', 'Resume the same agent id for build, test and repair',
    ]);
    for (const retired of [...RETIRED_WORKER_ROLES, ...RETIRED_WORKER_TIER_MODELS]) {
      if (workflow.includes(retired)) failures.push(`${label}/workflow: retired worker policy ${retired}`);
    }
  }

  // The orchestrate skill: its own plugin only.
  //
  // What this gate is FOR, now that there is no policy file to derive from. The
  // skill is a parameterized delegation prompt, and the parts that make it one
  // are the parts that quietly rot:
  //
  //  - the four parameters, and the positional parse that fills the first two
  //    from the invocation;
  //  - the four dispatch lines, which are runtime × model family, not runtime —
  //    drop one and that combination silently has no instruction at all, which
  //    reads as the skill simply not working there;
  //  - the retained thread, asserted per line, because "same sub-agent every
  //    round" is the one property a coordinator drifts away from first;
  //  - NO refusal prose for a cross-provider model: the Agent tool rejects a
  //    non-Anthropic model at input validation and spawn_agent errors on an
  //    unknown id, so the tool's own error is the report and a sentence would
  //    only restate it;
  //  - retained owner verification, explicit user overrides and separate fresh
  //    independent review. Testing by the author is necessary acceptance evidence,
  //    but cannot substitute for an independent review verdict.
  //
  // Prose that merely reads well would pass none of these.
  for (const [label, root] of orchestrateInventories.map(([l, r]) => [l, r])) {
    const skillPath = path.join(root, 'orchestrate', 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const skill = fs.readFileSync(skillPath, 'utf8');
    requireTokens(failures, `${label}/orchestrate`, skill, [
      '{model}', '{effort_level}', '{rounds}', '{done}', '{task}',
      'the first two words after /orchestrate are {model} and {effort_level}',
      'one continuous thread',
      'You coordinate and verify evidence',
      'The retained owner implements, runs the checks and repairs failures',
      'Verification is whatever the deliverable demands',
      'Say in one line which check you chose',
      'check or its verification owner, honor that explicit user override',
      'Owner testing is not independent review',
      'use a separate reviewer with fresh context',
      'fork_turns: "none"',
      'including build, test and repair',
      // One line per runtime, each named by its own prefix so a deleted one
      // fails as itself rather than as a vague missing token. There is no
      // cross-provider hop and no refusal prose for one: each runtime's own
      // tool rejects a model it cannot run, and that error is the report.
      'Claude Code:', 'Codex:', 'OpenCode:',
      'bootstrap-orchestrate:worker-{effort_level}',
      'every later round is SendMessage to that name',
      'spawn_agent', 'reasoning_effort',
      'every later round goes to that agent id',
      'agent "worker-{effort_level}" when that agent exists',
      // The two DEGRADATIONS a runtime performs silently unless told to speak:
      // the Agent tool maps any Claude id to a family alias, and OpenCode runs a
      // default sub-agent when the shim is absent. Each names what to say.
      'a specific version cannot be named; say so if one was asked for',
      'say in one line that effort could not be set',
    ]);
    if (/not to test|stop after implementation/i.test(skill)) {
      failures.push(`${label}/orchestrate: conflicting owner verification prohibition`);
    }
    for (const retired of RETIRED_WORKER_ROLES) {
      if (skill.includes(retired)) failures.push(`${label}/orchestrate: retired worker policy ${retired}`);
    }
  }

  checkEffortShims(failures, checks, orchestrateAgentsRoot);

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

  return { pass: failures.length === 0, checks, failures };
}

/**
 * The five effort shims `/orchestrate` dispatches to.
 *
 * They exist for one runtime limitation: Claude Code's Agent tool takes a `model`
 * per call but not an `effort`, so effort can only be pinned in an agent
 * definition's frontmatter. Five near-identical files is the smallest thing that
 * lets a caller ask for any level.
 *
 * The risk they carry is becoming roles again — someone adds a model, or a
 * paragraph of instructions, and the "pick a model per dispatch" property is gone
 * without anything failing. So the assertion is their emptiness: `model: inherit`,
 * the effort the filename claims, and a body short enough that it cannot be
 * carrying a contract. The old `worker-frontier.md` had a 12-line behavioural
 * block; that is the shape being kept out.
 */
function checkEffortShims(failures, checks, agentsRoot) {
  if (!fs.existsSync(agentsRoot)) {
    failures.push(`orchestrate/agents: missing ${path.relative(PLUGINS, agentsRoot)}; /orchestrate has nothing to dispatch to`);
    return;
  }
  const found = fs.readdirSync(agentsRoot).filter((name) => name.endsWith('.md')).sort();
  const expected = EFFORT_LEVELS.map((level) => `worker-${level}.md`).sort();
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    failures.push(`orchestrate/agents: expected exactly ${expected.join(', ')}; found ${found.join(', ') || '(nothing)'}`);
    return;
  }
  let allClean = true;
  for (const level of EFFORT_LEVELS) {
    const file = path.join(agentsRoot, `worker-${level}.md`);
    const text = fs.readFileSync(file, 'utf8');
    const fields = frontmatterFields(text);
    if (fields?.get('name') !== `worker-${level}`) {
      failures.push(`orchestrate/agents/worker-${level}.md: name must be worker-${level}`);
      allClean = false;
    }
    if (fields?.get('model') !== 'inherit') {
      failures.push(
        `orchestrate/agents/worker-${level}.md: model must be \`inherit\` — a pinned model turns the `
          + 'shim back into a role and takes the model choice away from the dispatch',
      );
      allClean = false;
    }
    if (fields?.get('effort') !== level) {
      failures.push(`orchestrate/agents/worker-${level}.md: effort must be \`${level}\`; the filename is the level it pins`);
      allClean = false;
    }
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    if (body.split('\n').filter((line) => line.trim()).length > 2) {
      failures.push(
        `orchestrate/agents/worker-${level}.md: body must stay at most two lines — a shim carries no `
          + 'instructions of its own, and prose here becomes a role no dispatch can override',
      );
      allClean = false;
    }
  }
  if (allClean) checks.push(`orchestrate/agents: ${EFFORT_LEVELS.length} effort shims, model: inherit, no instructions`);
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
