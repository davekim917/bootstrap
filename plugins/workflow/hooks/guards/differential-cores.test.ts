import { describe, test, expect } from 'bun:test';

// ── C3: Differential cores — SoT vs vendored copy ─────────────────────────────
// The workflow plugin (SoT) and the workflow-agents plugin (re-vendored by Group
// D) each carry their OWN physical copy of the shared guard cores. They MUST stay
// byte-for-byte equivalent in BEHAVIOR; this file is the behavioral backstop that
// proves it over the conformance corpus.
//
// NOTE: this is a SUPPLEMENTAL behavioral backstop, NOT a replacement for the
// file-level `--check` that asserts the vendored copy is identical to source. A
// `--check` catches drift in comments, dead code, and exports the corpus doesn't
// exercise; this catches behavioral drift the moment a corpus input diverges.
// Keep BOTH gates.
//
// Imports deliberately reach across BOTH plugin trees:
//   SoT:      ./block-destructive-core            (same dir = workflow/hooks/guards)
//   vendored: ../../../workflow-agents/hooks/guards/block-destructive-core

import * as sot from './block-destructive-core';
import * as sotEmail from './email-gate-core';
import * as vendored from '../../../workflow-agents/hooks/guards/block-destructive-core';
import * as vendoredEmail from '../../../workflow-agents/hooks/guards/email-gate-core';

// Conformance corpus — mirrors conformance.test.ts so the differential check
// covers the same canonical block/gate/allow inputs the manifest pins.
const BASH_CORPUS = [
  // hard-block
  'eval echo x',
  'unlink secret',
  'shred -u f',
  'bash -c "rm -rf /etc"',
  'rm -rf /home/ubuntu/Documents',
  'rm -rf /',
  'find . -delete',
  'xargs rm < list',
  // gate
  'terraform destroy -auto-approve',
  'psql -c "DROP TABLE users"',
  'snow sql -q "DROP TABLE prod.orders"',
  'aws s3 rb s3://prod --force',
  'gcloud compute instances delete vm-1',
  'kubectl delete deployment api',
  'docker rm -f db',
  'helm uninstall app',
  'dbt run --full-refresh',
  // allow
  'ls -la',
  'git status',
  'rm -rf node_modules',
  'echo hello',
  'cat README.md',
  'rm -rf dist',
  '',
];

const GIT_CLONE_CORPUS = [
  'git clone https://github.com/a/b /workspace/agent/b',
  'git clone https://github.com/a/b /workspace/agent/repos/b',
  'git clone https://github.com/a/b /workspace/worktrees/b',
  'git clone https://github.com/a/b /workspace/workgroup/b',
  'git clone https://github.com/a/b /tmp/x && mv /tmp/x /workspace/agent/stolen',
  'git clone https://github.com/a/b /tmp/scratch',
  'git status',
  'git pull origin main',
  'echo git clone',
  '',
];

const SELF_APPROVAL_CORPUS = [
  'touch .claude-destructive-gate',
  'echo ok > .claude-destructive-gate',
  'echo /tmp/.claude-destructive-gate/abc',
  'ls -la',
  'git status',
  'echo hello',
  '',
];

const SNOWFLAKE_CORPUS = [
  "python -c 'import snowflake.connector'",
  'python3 -c "from snowflake.connector import connect"',
  'python -c "import snowflake_connector"',
  'snow sql -q "select 1"',
  'grep snowflake.connector requirements.txt',
  'pip install snowflake-connector-python',
  'echo snowflake.connector',
  'ls -la',
  '',
];

const EMAIL_CORPUS = [
  'gws gmail +send --to a@b.com --subject hi',
  'gws gmail +reply --to a@b.com',
  'gws gmail +reply-all --to a@b.com',
  'gws gmail +forward --to a@b.com',
  'gws gmail users messages send --json \'{"raw":"x"}\'',
  'gws gmail users drafts send --json \'{"raw":"x"}\'',
  'gws gmail +send --to a@b.com --dry-run',
  'gws gmail +send --to a@b.com --draft',
  'gws gmail +send --help',
  'ls -la',
  'git status',
  '',
];

describe('test_differential_imports_two_paths', () => {
  test('the SoT and vendored cores are distinct module objects from distinct trees', () => {
    // If these were the same import (e.g. a symlink resolved to one inode), the
    // differential check would be vacuous. Prove they are two separate modules.
    expect(sot).not.toBe(vendored);
    expect(sotEmail).not.toBe(vendoredEmail);
    // Both trees export every evaluator under test (guards against a partial
    // re-vendor that silently drops an export).
    for (const fn of [
      'evaluateBashCommand',
      'evaluateGitCloneDestination',
      'evaluateSelfApproval',
      'evaluateSnowflakeConnector',
    ] as const) {
      expect(typeof sot[fn]).toBe('function');
      expect(typeof vendored[fn]).toBe('function');
    }
    expect(typeof sotEmail.evaluateEmailSend).toBe('function');
    expect(typeof vendoredEmail.evaluateEmailSend).toBe('function');
  });
});

describe('test_differential_cores_identical_verdicts', () => {
  describe('evaluateBashCommand', () => {
    for (const cmd of BASH_CORPUS) {
      test(`identical: ${JSON.stringify(cmd)}`, () => {
        expect(sot.evaluateBashCommand(cmd)).toEqual(vendored.evaluateBashCommand(cmd));
      });
    }
  });

  describe('evaluateGitCloneDestination', () => {
    for (const cmd of GIT_CLONE_CORPUS) {
      test(`identical: ${JSON.stringify(cmd)}`, () => {
        expect(sot.evaluateGitCloneDestination(cmd)).toEqual(
          vendored.evaluateGitCloneDestination(cmd),
        );
      });
    }
  });

  describe('evaluateSelfApproval', () => {
    for (const cmd of SELF_APPROVAL_CORPUS) {
      test(`identical: ${JSON.stringify(cmd)}`, () => {
        expect(sot.evaluateSelfApproval(cmd)).toEqual(vendored.evaluateSelfApproval(cmd));
      });
    }
  });

  describe('evaluateSnowflakeConnector', () => {
    for (const cmd of SNOWFLAKE_CORPUS) {
      test(`identical: ${JSON.stringify(cmd)}`, () => {
        expect(sot.evaluateSnowflakeConnector(cmd)).toEqual(
          vendored.evaluateSnowflakeConnector(cmd),
        );
      });
    }
  });

  describe('evaluateEmailSend', () => {
    // The verdict carries label + summary, so a deep-equal here also proves the
    // approval-card content is identical across copies — not just the action.
    for (const cmd of EMAIL_CORPUS) {
      for (const isScheduledTask of [false, true]) {
        test(`identical: ${JSON.stringify(cmd)} (scheduled=${isScheduledTask})`, () => {
          expect(sotEmail.evaluateEmailSend(cmd, { isScheduledTask })).toEqual(
            vendoredEmail.evaluateEmailSend(cmd, { isScheduledTask }),
          );
        });
      }
    }
  });
});
