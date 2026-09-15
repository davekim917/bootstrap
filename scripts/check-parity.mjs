#!/usr/bin/env node
/**
 * Unified "bootstrap parity" drift gate — the cross-cutting enforcement for the
 * develop-once / deploy-everywhere structure. Runs every artifact's drift check
 * and fails (exit 1) if ANY artifact has drifted from its single source:
 *
 *   - HOOKS  → scripts/vendor-guards.mjs --check
 *       The shared destructive-guard + file-protection cores are authored once
 *       (workflow/hooks/guards/*-core.ts) and vendored into workflow-agents.
 *   - WORKFLOW CONTRACT → evals/harness/parity-lint.mjs --all
 *       Both plugins expose seven team skills plus orchestrate, mirror the shared contracts,
 *       retain both explicit cross-model review lanes, and stop auto at ship.
 *   - WORKER POLICY → plugins/workflow-agents/scripts/worker-policy.test.mjs
 *       plus the generated-artifact halves of parity-lint. The frontier-worker
 *       model/effort policy is ONE hand-edited file
 *       (plugins/workflow/worker-policy.json); the agent def's frontmatter, the
 *       Codex role TOML, and the generated policy module beside every
 *       frontier-worker.mjs are rendered from it. Edit the policy, run
 *       sync-agent-skills.mjs, commit — no gate asserts a model name by hand.
 *   - BOUNDARIES → scripts/check-plugin-boundaries.mjs
 *       Plugin boundary invariants (user-facing skill-name parity, real SKILL.md).
 *   - ORCHESTRATE SPLIT → scripts/plugin-enablement.test.mjs
 *       Resolves and RUNS the session composition with bootstrap-orchestrate
 *       enabled and disabled. The disabled state must let a coordinator read
 *       implementation source directly while every team-* skill still loads;
 *       the enabled state must reproduce the pre-split guard chain exactly.
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
  { name: 'worker:policy (worker-policy tests)', argv: ['--test', 'plugins/workflow-agents/scripts/worker-policy.test.mjs'] },
  { name: 'worker:transport (frontier-worker tests)', argv: ['--test', 'plugins/workflow/scripts/frontier-worker.test.mjs'] },
  { name: 'worker:roles (install-agent-roles tests)', argv: ['--test', 'plugins/workflow-agents/scripts/install-agent-roles.test.mjs'] },
  { name: 'worker:roles (SessionStart bare-install tests)', argv: ['--test', 'plugins/workflow-agents/scripts/session-install-roles.test.mjs'] },
  { name: 'skills:gen (sync-agent-skills --check)', argv: ['plugins/workflow-agents/scripts/sync-agent-skills.mjs', '--check'] },
  { name: 'split    (orchestrate enable/disable proof)', argv: ['--test', 'scripts/plugin-enablement.test.mjs'] },
  { name: 'contracts (parity-lint tests)', argv: ['--test', 'evals/harness/parity-lint.test.mjs'] },
  { name: 'skills:contract (parity-lint --all)', argv: ['evals/harness/parity-lint.mjs', '--all'] },
  { name: 'bounds   (check-plugin-boundaries)', argv: ['scripts/check-plugin-boundaries.mjs'] },
];

let failed = 0;
for (const c of CHECKS) {
  const scriptArg = c.argv[0] === '--test' ? c.argv[1] : c.argv[0];
  const script = path.join(REPO, scriptArg);
  if (!fs.existsSync(script)) {
    console.log(`—  ${c.name} (script absent, skipped)`);
    continue;
  }
  console.log(`\n=== ${c.name} ===`);
  const argv = c.argv[0] === '--test' ? ['--test', script] : [script, ...c.argv.slice(1)];
  const r = spawnSync('node', argv, { cwd: REPO, stdio: 'inherit' });
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
console.log('\n[check-parity] ✓ all artifacts (hooks · skills · boundaries) in sync.');
