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
 *       Both workflow plugins expose the seven team skills and mirror the shared
 *       contracts; the orchestrate plugin exposes its one skill and the five
 *       effort shims it dispatches to; both explicit cross-model review lanes
 *       survive and auto still stops at ship.
 *   - BOUNDARIES → scripts/check-plugin-boundaries.mjs
 *       Plugin boundary invariants (user-facing skill-name parity, real SKILL.md).
 *   - ORCHESTRATE SPLIT → scripts/plugin-enablement.test.mjs
 *       Resolves and RUNS the session composition with bootstrap-orchestrate
 *       enabled and disabled. The disabled state must let a coordinator read
 *       implementation source directly while every team-* skill still loads;
 *       the enabled state must reproduce the pre-split guard chain exactly.
 *
 * There is no WORKER POLICY row any more. The `worker-frontier` model/effort
 * policy (plugins/workflow/worker-policy.json) and everything rendered from it —
 * the agent def's frontmatter, the Codex role TOML and its SessionStart
 * installer, the generated policy module, the frontier-worker CLI transport —
 * went with the role itself: `/orchestrate` names a model and an effort per
 * dispatch instead of naming a worker, and dispatches through the runtime's own
 * sub-agent tool. `check-plugin-boundaries` asserts those files stay gone.
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

/**
 * MANIFEST VALIDATION — `claude plugin validate`, over every plugin directory.
 *
 * Added because a manifest can be invalid in a way no gate in this repo would
 * notice: `"agents": ["./agents"]` looks obviously right, is rejected by Claude's
 * own schema (`agents.0: Invalid input`), and — whether an install refuses the
 * plugin or merely stops auto-loading `agents/` — leaves every
 * `bootstrap-orchestrate:worker-<level>` dispatch resolving to nothing. Our own
 * gate asserted the broken value, so all six rows above were green while the
 * plugin could not ship its agents.
 *
 * The validator is the only thing that knows the current schema, so it is the
 * only honest check. It is also not a dependency of this repo: CI or a
 * contributor may not have the Claude CLI, and a missing CLI must not read as a
 * failure. It skips with a message instead, and the boundaries gate keeps a
 * hand-written assertion for the one rule we know, so the skip is not total.
 */
function validateManifests() {
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.log('\n=== manifests (claude plugin validate) ===');
    console.log('—  claude CLI not available, skipped (the boundaries gate still checks what it can)');
    return 0;
  }

  const pluginsRoot = path.join(REPO, 'plugins');
  const dirs = fs.existsSync(pluginsRoot)
    ? fs.readdirSync(pluginsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()
          && fs.existsSync(path.join(pluginsRoot, entry.name, '.claude-plugin', 'plugin.json')))
        .map((entry) => `plugins/${entry.name}`)
        .sort()
    : [];

  console.log(`\n=== manifests (claude plugin validate, ${probe.stdout.trim()}) ===`);
  let bad = 0;
  for (const dir of dirs) {
    // The CLI exits 0 even when validation fails, so its OUTPUT is the verdict.
    const r = spawnSync('claude', ['plugin', 'validate', dir], { cwd: REPO, encoding: 'utf8' });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status !== 0 || /Validation failed|Invalid input|✘/.test(output)) {
      bad++;
      console.error(`✗ ${dir}`);
      console.error(output.trim());
    } else {
      console.log(`✓ ${dir}`);
    }
  }
  return bad;
}

failed += validateManifests();

if (failed > 0) {
  console.error(`\n[check-parity] ${failed} drift check(s) FAILED — regenerate the stale artifact(s) and re-commit.`);
  process.exit(1);
}
console.log('\n[check-parity] ✓ all artifacts (hooks · skills · boundaries · manifests) in sync.');
