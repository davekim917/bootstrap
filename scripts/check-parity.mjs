#!/usr/bin/env node
/**
 * Unified "bootstrap parity" drift gate — the cross-cutting enforcement for the
 * develop-once / deploy-everywhere structure. Runs every artifact's drift check
 * and fails (exit 1) if ANY artifact has drifted from its single source:
 *
 *   - HOOKS  → scripts/vendor-guards.mjs --check
 *       The shared destructive-guard + file-protection cores are authored once
 *       (workflow/hooks/guards/*-core.ts) and vendored into workflow-agents.
 *   - AGENTS → plugins/workflow-agents/scripts/sync-codex-agents.mjs --check
 *       Codex agent TOMLs are generated from the Claude agent .md sources.
 *   - SKILLS → evals/harness/parity-lint.mjs --all
 *       workflow-agents skills must cover the Claude skills' substance and carry
 *       no Claude-only orchestration tokens outside their Dispatch-by-Runtime
 *       region. (Skill BODIES legitimately differ — Claude-specific vs runtime
 *       neutral — so they are gated by substance coverage, not byte-identity.)
 *   - BOUNDARIES → scripts/check-plugin-boundaries.mjs
 *       Plugin boundary invariants (user-facing skill-name parity, real SKILL.md).
 *
 * Usage: node scripts/check-parity.mjs    (run in CI / pre-commit)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHECKS = [
  { name: 'hooks    (vendor-guards --check)', argv: ['scripts/vendor-guards.mjs', '--check'] },
  { name: 'agents   (sync-codex-agents --check)', argv: ['plugins/workflow-agents/scripts/sync-codex-agents.mjs', '--check'] },
  { name: 'skills:gen (sync-agent-skills --check)', argv: ['plugins/workflow-agents/scripts/sync-agent-skills.mjs', '--check'] },
  { name: 'skills:lint (parity-lint --all)', argv: ['evals/harness/parity-lint.mjs', '--all'] },
  { name: 'bounds   (check-plugin-boundaries)', argv: ['scripts/check-plugin-boundaries.mjs'] },
];

let failed = 0;
for (const c of CHECKS) {
  const script = path.join(REPO, c.argv[0]);
  if (!fs.existsSync(script)) {
    console.log(`—  ${c.name} (script absent, skipped)`);
    continue;
  }
  console.log(`\n=== ${c.name} ===`);
  const r = spawnSync('node', [script, ...c.argv.slice(1)], { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${c.name} — DRIFT`);
  } else {
    console.log(`✓ ${c.name}`);
  }
}

if (failed > 0) {
  console.error(`\n[check-parity] ${failed} drift check(s) FAILED — regenerate the stale artifact(s) and re-commit.`);
  process.exit(1);
}
console.log('\n[check-parity] ✓ all artifacts (hooks · agents · skills · boundaries) in sync.');
