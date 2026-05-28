import { describe, it, expect } from 'bun:test';
import { evaluateBashCommand } from './block-destructive-core';
import { checkEditProtection } from './file-protection-core';

/**
 * CROSS-SURFACE PARITY CONTRACT.
 *
 * Every runtime adapter routes through these two shared cores:
 *   - Claude:        block-destructive.ts + file-protection.ts
 *   - OpenCode:      opencode-guard.ts
 *   - Codex (host):  workflow-agents/hooks/codex-guard.ts
 *   - Codex (cont.): nanoclaw runner.ts (imports the vendored cores)
 *
 * This manifest is the single readable source of expected verdicts for the
 * canonical destructive set. If it holds, all surfaces agree by construction;
 * per-adapter wiring tests (opencode-guard.test, runner.test, codex-app-server,
 * block-destructive.test) confirm each adapter maps the core verdict faithfully
 * to its own I/O (exit-2 / throw / stdout-JSON / decision-object).
 */

// Hard-block (never allowed): file-deletion primitives, shell-wrapper bypass,
// protected-path rm.
const BASH_BLOCK = [
  'eval echo x',
  'unlink secret',
  'shred -u f',
  'bash -c "rm -rf /etc"',
  'rm -rf /home/ubuntu/Documents',
  'rm -rf /',
  'find . -delete',
  'xargs rm < list',
];

// Gated (require approval): destructive infra/DB/cloud/IaC/containers/dbt.
const BASH_GATE = [
  'terraform destroy -auto-approve',
  'psql -c "DROP TABLE users"',
  'snow sql -q "DROP TABLE prod.orders"',
  'aws s3 rb s3://prod --force',
  'gcloud compute instances delete vm-1',
  'kubectl delete deployment api',
  'docker rm -f db',
  'helm uninstall app',
  'dbt run --full-refresh',
];

// Allowed: safe / ephemeral.
const BASH_ALLOW = ['ls -la', 'git status', 'rm -rf node_modules', 'echo hello', 'cat README.md', 'rm -rf dist'];

// Edits blocked / allowed by file-protection.
const EDIT_BLOCK = ['.env', 'app/.env.local', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.git/config', 'terraform/main.tf', 'infra/terraform/prod.tf'];
const EDIT_ALLOW = ['src/index.ts', '.env.example', '.gitignore', 'README.md', 'lib/util.js'];

describe('parity contract — destructive bash', () => {
  for (const cmd of BASH_BLOCK) {
    it(`blocks: ${cmd}`, () => expect(evaluateBashCommand(cmd).action).toBe('block'));
  }
  for (const cmd of BASH_GATE) {
    it(`gates: ${cmd}`, () => expect(evaluateBashCommand(cmd).action).toBe('gate'));
  }
  for (const cmd of BASH_ALLOW) {
    it(`allows: ${cmd}`, () => expect(evaluateBashCommand(cmd).action).toBe('allow'));
  }
});

describe('parity contract — file-protection edits', () => {
  for (const p of EDIT_BLOCK) {
    it(`protects: ${p}`, () => expect(checkEditProtection('Write', { file_path: p })).toBe(p));
  }
  for (const p of EDIT_ALLOW) {
    it(`allows edit: ${p}`, () => expect(checkEditProtection('Write', { file_path: p })).toBeNull());
  }
});
