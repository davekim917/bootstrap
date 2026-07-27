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

export const EXPECTED_SKILLS = Object.freeze([
  'team-auto',
  'team-build',
  'team-debug',
  'team-plan',
  'team-retro',
  'team-review',
  'team-ship',
]);

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
} = {}) {
  const failures = [];
  const checks = [];
  const inventories = [
    ['Claude', claudeRoot, skillInventory(claudeRoot)],
    ['Codex/OpenCode', agentRoot, skillInventory(agentRoot)],
  ];

  for (const [label, root, inventory] of inventories) {
    if (JSON.stringify(inventory) !== JSON.stringify(EXPECTED_SKILLS)) {
      failures.push(`${label}: expected exactly ${EXPECTED_SKILLS.join(', ')}; found ${inventory.join(', ')}`);
    } else {
      checks.push(`${label}: exactly seven workflow skills`);
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

  for (const shared of SHARED_CONTRACTS) {
    const claudePath = path.join(claudeRoot, 'shared', shared);
    const agentPath = path.join(agentRoot, 'shared', shared);
    if (!fs.existsSync(claudePath) || !fs.existsSync(agentPath)) {
      failures.push(`shared/${shared}: contract must exist in both runtime trees`);
      continue;
    }
    if (!fs.readFileSync(claudePath).equals(fs.readFileSync(agentPath))) {
      failures.push(`shared/${shared}: runtime copies must be byte-identical`);
    } else {
      checks.push(`shared/${shared}: byte-identical`);
    }
  }

  const exactCommands = [
    `codex exec --ignore-user-config --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --ephemeral --yolo`,
    'claude -p --model claude-opus-5 --effort high --safe-mode --no-session-persistence --permission-mode plan --tools "" --strict-mcp-config --output-format json',
  ];
  for (const [label, root] of inventories) {
    const reviewPath = path.join(root, 'shared', 'cross-model-review.md');
    if (!fs.existsSync(reviewPath)) continue;
    requireTokens(
      failures,
      `${label}/cross-model-review`,
      fs.readFileSync(reviewPath, 'utf8'),
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

    const plan = fs.readFileSync(path.join(root, 'team-plan', 'SKILL.md'), 'utf8');
    requireTokens(failures, `${label}/team-plan`, plan, [
      'plan.md',
      'cross-model',
      'before',
      'approval',
    ]);

    const review = fs.readFileSync(path.join(root, 'team-review', 'SKILL.md'), 'utf8');
    requireTokens(failures, `${label}/team-review`, review, [
      '--implementation',
      'approved plan',
      'implementation diff',
      'cross-model',
      'run.md',
    ]);

    const auto = fs.readFileSync(path.join(root, 'team-auto', 'SKILL.md'), 'utf8');
    requireTokens(failures, `${label}/team-auto`, auto, [
      'one',
      'correction',
      'never ships',
      '.team-auto-active',
      'run.md',
    ]);
  }

  return { pass: failures.length === 0, checks, failures };
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
