import { describe, it, expect } from 'bun:test';
import {
  evaluateBashCommand,
  evaluateGitCloneDestination,
  evaluateSelfApproval,
  evaluateSnowflakeConnector,
} from './block-destructive-core';
import { evaluateEmailSend } from './email-gate-core';
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

// git-clone into a managed dir is blocked (must use clone_repo/create_worktree);
// pure /tmp clones and non-clone commands are allowed. Order-independent: a
// managed-dir reference ANYWHERE alongside `git clone` blocks the whole command.
const GIT_CLONE_BLOCK = [
  'git clone https://github.com/a/b /workspace/agent/b',
  'git clone https://github.com/a/b /workspace/agent/repos/b',
  'git clone https://github.com/a/b /workspace/worktrees/b',
  'git clone https://github.com/a/b /workspace/workgroup/b',
  'git clone https://github.com/a/b /tmp/x && mv /tmp/x /workspace/agent/stolen',
];
const GIT_CLONE_ALLOW = [
  'git clone https://github.com/a/b /tmp/scratch',
  'git status',
  'git pull origin main',
  'echo git clone',
];

// Edits blocked / allowed by file-protection.
const EDIT_BLOCK = ['.env', 'app/.env.local', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.git/config', 'terraform/main.tf', 'infra/terraform/prod.tf'];
const EDIT_ALLOW = ['src/index.ts', '.env.example', '.gitignore', 'README.md', 'lib/util.js'];

// Self-approval (writing the .claude-destructive-gate marker yourself) is a
// hard block; everything else allows. Pure on `command`.
const SELF_APPROVAL_BLOCK = [
  'touch .claude-destructive-gate',
  'echo ok > .claude-destructive-gate',
  'echo /tmp/.claude-destructive-gate/abc',
];
const SELF_APPROVAL_ALLOW = ['ls -la', 'git status', 'echo hello'];

// Ad-hoc Python snowflake.connector exec is blocked (steer to `snow sql`);
// the snow CLI, grep, pip, and bare echoes allow. Pure on `command`.
const SNOWFLAKE_BLOCK = [
  "python -c 'import snowflake.connector'",
  'python3 -c "from snowflake.connector import connect"',
  'python -c "import snowflake_connector"',
];
const SNOWFLAKE_ALLOW = [
  'snow sql -q "select 1"',
  'grep snowflake.connector requirements.txt',
  'pip install snowflake-connector-python',
  'echo snowflake.connector',
];

// Outbound email sends via the gws CLI are GATED when interactive; a non-email
// command allows, and a scheduled-task send bypasses the gate (allow) — both
// faithful to evaluateEmailSend's policy. The gate verdict depends on the env
// snapshot, so each row pins the (command, env) pair.
const EMAIL_GATE = [
  'gws gmail +send --to a@b.com --subject hi',
  'gws gmail +reply --to a@b.com',
  'gws gmail users messages send --json \'{"raw":"x"}\'',
];
const EMAIL_ALLOW = ['ls -la', 'git status', 'gws gmail +send --to a@b.com --dry-run'];

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

describe('parity contract — git-clone destination', () => {
  for (const cmd of GIT_CLONE_BLOCK) {
    it(`blocks: ${cmd}`, () => expect(evaluateGitCloneDestination(cmd).action).toBe('block'));
  }
  for (const cmd of GIT_CLONE_ALLOW) {
    it(`allows: ${cmd}`, () => expect(evaluateGitCloneDestination(cmd).action).toBe('allow'));
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

// ── Manifest rows added for the migrated command-guards (Group C / C1). ──
// These three guards (self-approval, snowflake, email-gate) were ported into the
// shared cores alongside the destructive + git-clone set above. Pinning their
// verdicts here keeps the cross-surface contract complete: opencode-guard.ts and
// the Codex runner both consume these same evaluators, so if this manifest holds,
// every surface agrees by construction.

describe('parity contract — self-approval', () => {
  for (const cmd of SELF_APPROVAL_BLOCK) {
    it(`blocks: ${cmd}`, () => expect(evaluateSelfApproval(cmd).action).toBe('block'));
  }
  for (const cmd of SELF_APPROVAL_ALLOW) {
    it(`allows: ${cmd}`, () => expect(evaluateSelfApproval(cmd).action).toBe('allow'));
  }
});

describe('parity contract — snowflake connector', () => {
  for (const cmd of SNOWFLAKE_BLOCK) {
    it(`blocks: ${cmd}`, () => expect(evaluateSnowflakeConnector(cmd).action).toBe('block'));
  }
  for (const cmd of SNOWFLAKE_ALLOW) {
    it(`allows: ${cmd}`, () => expect(evaluateSnowflakeConnector(cmd).action).toBe('allow'));
  }
});

describe('parity contract — email gate', () => {
  // Interactive send (isScheduledTask:false) → gate. The scheduled-task bypass is
  // verified separately below.
  for (const cmd of EMAIL_GATE) {
    it(`gates (interactive): ${cmd}`, () =>
      expect(evaluateEmailSend(cmd, { isScheduledTask: false }).action).toBe('gate'));
  }
  // Non-email commands always allow, regardless of schedule context.
  for (const cmd of EMAIL_ALLOW) {
    it(`allows: ${cmd}`, () =>
      expect(evaluateEmailSend(cmd, { isScheduledTask: false }).action).toBe('allow'));
  }
  // A real send bypasses (allow) when it originates from a scheduled task —
  // faithful to evaluateEmailSend's v1-parity policy.
  for (const cmd of EMAIL_GATE) {
    it(`allows (scheduled bypass): ${cmd}`, () =>
      expect(evaluateEmailSend(cmd, { isScheduledTask: true }).action).toBe('allow'));
  }
});
