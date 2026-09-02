import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { evaluateBashCommand, isLabSession, labTargetOf, extractCommands } from './block-destructive-core';

/**
 * LAB-SCOPED EXEMPTION.
 *
 * Two predicates must BOTH hold for a tier-2 gate to become an allow:
 *   1. lab session  — NANOCLAW_INSTRUCTIONS_PROFILE === 'lab'
 *   2. lab target   — the resolved command names a LAB-* or ACME-WIKI repo,
 *                     a `lab-`/`lab_` database, or a `lab-` Render resource
 *
 * The three-way matrix below is the contract: lab+lab allows, lab+prod holds,
 * prod-session+lab holds. Tier 1 (the hard blocks) is never exempted.
 */

const PROFILE = 'NANOCLAW_INSTRUCTIONS_PROFILE';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[PROFILE];
});

afterEach(() => {
  if (saved === undefined) delete process.env[PROFILE];
  else process.env[PROFILE] = saved;
});

function inLab(): void {
  process.env[PROFILE] = 'lab';
}

function outsideLab(): void {
  delete process.env[PROFILE];
}

const LAB_WORKTREE = '/workspace/worktrees/LAB-INITECH';
const PROD_WORKTREE = '/workspace/worktrees/INITECH';

// (command, cwd) pairs whose target IS a lab target.
const LAB_TARGETS: Array<[string, string]> = [
  // git — bare remote resolved through the lab worktree checkout
  ['git push --force origin main', LAB_WORKTREE],
  ['git push -f', LAB_WORKTREE],
  ['git push origin --delete scratch', LAB_WORKTREE],
  ['git push origin +main', LAB_WORKTREE],
  // git — explicit lab URL, cwd irrelevant
  ['git push --force https://github.com/Acme-ai/LAB-INITECH.git main', '/tmp'],
  ['git push --force git@github.com:acme-ai/LAB-RENDER-SPIKE.git main', '/tmp'],
  ['git push --force https://github.com/Acme-ai/ACME-WIKI.git main', '/tmp'],
  // Pre-rename lowercase spellings. GitHub repo names are case-insensitive and
  // both repos were renamed up from lowercase, so agents still hold URLs like
  // these and GitHub redirects them to the current name.
  ['git push --force https://github.com/acme-ai/lab-initech.git main', '/tmp'],
  ['git push --force https://github.com/acme-ai/acme-wiki.git main', '/tmp'],
  ['git push --force origin main', '/workspace/worktrees/lab-initech'],
  ['gh repo delete acme-ai/lab-initech --yes', '/tmp'],
  // git — -C relocates the effective checkout
  [`git -C ${LAB_WORKTREE} push -f origin develop`, '/tmp'],
  // psql — lab database / user / connection string
  ['psql -d lab_initech -c "DROP TABLE users"', '/tmp'],
  ['psql --dbname=lab_initech -c "TRUNCATE events"', '/tmp'],
  ['psql -U lab_initech_admin -d lab_initech -c "DELETE FROM sessions"', '/tmp'],
  [
    'psql postgresql://lab_initech_admin:pw@dpg-abc-a.virginia-postgres.render.com/lab_initech -c "DROP SCHEMA public CASCADE"',
    '/tmp',
  ],
  ['psql "host=dpg-abc-a.virginia-postgres.render.com dbname=lab_initech" -c "DROP TABLE t"', '/tmp'],
  // render — lab service / database argument
  ['render services delete lab-initech-api --confirm', '/tmp'],
  ['render databases delete lab-initech-db', '/tmp'],
  // gh — LAB-* repos only
  ['gh repo delete Acme-ai/LAB-INITECH --yes', '/tmp'],
];

// (command, cwd) pairs whose target is NOT a lab target. These must keep today's
// verdict in the lab room exactly as outside it.
const NON_LAB_TARGETS: Array<[string, string]> = [
  // prod / dev databases
  ['psql -d initech_prod -c "DROP TABLE users"', LAB_WORKTREE],
  ['psql -d initech_dev -c "TRUNCATE events"', LAB_WORKTREE],
  ['psql postgresql://initech_admin:pw@dpg-abc-a.virginia-postgres.render.com/initech_prod -c "DROP TABLE t"', LAB_WORKTREE],
  // a runtime-constructed target has no visible lab signal — fails closed
  ['psql "$DATABASE_URL" -c "DROP TABLE users"', LAB_WORKTREE],
  // Snowflake has no lab tenant
  ['snow sql -q "DROP TABLE prod.orders"', LAB_WORKTREE],
  ['snow sql -q "DROP TABLE lab_initech.orders"', LAB_WORKTREE],
  // non-LAB repos, by URL and by checkout
  ['git push --force https://github.com/Acme-ai/INITECH.git main', LAB_WORKTREE],
  ['git push --force Acme-ai/INITECH main', LAB_WORKTREE],
  ['git push --force origin main', PROD_WORKTREE],
  // a lab checkout does not launder a push aimed at a prod URL
  ['git push --force https://github.com/Acme-ai/INITECH.git main', LAB_WORKTREE],
  // wrong org — the owner is pinned to acme-ai inside the pattern itself,
  // so a LAB-named repo belonging to anyone else is never exempt
  ['git push --force https://github.com/other-org/LAB-INITECH.git main', '/tmp'],
  ['git push --force https://github.com/other-org/lab-initech.git main', '/tmp'],
  ['git push --force git@github.com:other-org/ACME-WIKI.git main', '/tmp'],
  ['gh repo delete other-org/LAB-INITECH --yes', '/tmp'],
  // a repo whose name merely CONTAINS lab- is not a LAB-* repo
  ['git push --force https://github.com/acme-ai/collab-tools.git main', '/tmp'],
  // non-lab Render resources
  ['render services delete initech-prod-api --confirm', LAB_WORKTREE],
  // the wiki is lab-writable, not lab-deletable — in either casing
  ['gh repo delete Acme-ai/ACME-WIKI --yes', LAB_WORKTREE],
  ['gh repo delete Acme-ai/acme-wiki --yes', LAB_WORKTREE],
  ['gh repo delete Acme-ai/INITECH --yes', LAB_WORKTREE],
  // other platform CLIs are not in the exemption at all
  ['fly apps destroy lab-initech-api', LAB_WORKTREE],
  ['kubectl delete deployment lab-initech-api', LAB_WORKTREE],
  ['aws s3 rb s3://lab-initech --force', LAB_WORKTREE],
];

describe('predicate 1 — lab session', () => {
  test('true only for the exact `lab` profile', () => {
    outsideLab();
    expect(isLabSession()).toBe(false);
    process.env[PROFILE] = 'lab-ish';
    expect(isLabSession()).toBe(false);
    process.env[PROFILE] = 'LAB';
    expect(isLabSession()).toBe(false);
    inLab();
    expect(isLabSession()).toBe(true);
  });
});

describe('predicate 2 — lab target (pure; independent of the session)', () => {
  for (const [command, cwd] of LAB_TARGETS) {
    test(`matches: ${command}`, () => {
      const cmds = extractCommands(command);
      expect(cmds.some(c => labTargetOf(c, cwd) !== null)).toBe(true);
    });
  }
  for (const [command, cwd] of NON_LAB_TARGETS) {
    test(`does not match: ${command}`, () => {
      const cmds = extractCommands(command);
      expect(cmds.some(c => labTargetOf(c, cwd) !== null)).toBe(false);
    });
  }
});

describe('lab session + lab target → allow', () => {
  for (const [command, cwd] of LAB_TARGETS) {
    test(`allows: ${command}`, () => {
      inLab();
      expect(evaluateBashCommand(command, { cwd }).action).toBe('allow');
    });
  }

  test('rm inside a LAB worktree joins the ephemeral allowlist', () => {
    inLab();
    for (const command of [
      'rm -rf /workspace/worktrees/LAB-INITECH/src',
      'rm -rf /workspace/worktrees/LAB-INITECH',
      'rm -rf /workspace/worktrees/ACME-WIKI/docs',
      // pre-rename lowercase checkout dirs
      'rm -rf /workspace/worktrees/lab-initech/src',
      'rm -rf /workspace/worktrees/acme-wiki/docs',
      // host-path alias mount of the same directory
      'rm -rf /home/ubuntu/nanoclaw-v2/data/v2-topics/acme/task-abc/worktrees/LAB-INITECH/src',
    ]) {
      expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('allow');
    }
  });

  test('a lab gate and a lab rm in one command line both clear', () => {
    inLab();
    const command = 'psql -d lab_initech -c "DROP TABLE users" && rm -rf /workspace/worktrees/LAB-INITECH/src';
    expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('allow');
  });

  test('a non-lab gate alongside a lab gate still holds', () => {
    inLab();
    const command = 'psql -d lab_initech -c "DROP TABLE users" && psql -d initech_prod -c "DROP TABLE users"';
    expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('gate');
  });
});

describe('lab session + non-lab target → unchanged', () => {
  for (const [command, cwd] of NON_LAB_TARGETS) {
    test(`still gates: ${command}`, () => {
      inLab();
      expect(evaluateBashCommand(command, { cwd }).action).toBe('gate');
    });
  }

  test('rm outside a LAB worktree still redirects to trash', () => {
    inLab();
    for (const command of [
      'rm -rf /workspace/worktrees/INITECH/src',
      'rm -rf /workspace/agent/notes',
      'rm -rf /workspace/worktrees/LAB-INITECH/../INITECH/src',
    ]) {
      expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('block');
    }
  });

  test('protected home paths stay hard-blocked in the lab', () => {
    inLab();
    for (const command of ['rm -rf ~/.ssh', 'rm -rf /', 'rm -rf /home/ubuntu/Documents']) {
      expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('block');
    }
  });
});

describe('tier 1 is never exempted, lab or not', () => {
  for (const command of [
    'eval echo x',
    'bash -c "psql -d lab_initech -c \'DROP TABLE users\'"',
    'sh -c "rm -rf /workspace/worktrees/LAB-INITECH"',
    'find /workspace/worktrees/LAB-INITECH -delete',
    'xargs rm < list',
    'shred -u /workspace/worktrees/LAB-INITECH/secret',
    'truncate -s 0 /workspace/worktrees/LAB-INITECH/log',
    'unlink /workspace/worktrees/LAB-INITECH/f',
  ]) {
    test(`blocks in the lab: ${command}`, () => {
      inLab();
      expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('block');
    });
  }

  test('dd stays gated in the lab', () => {
    inLab();
    expect(evaluateBashCommand('dd if=/dev/zero of=/workspace/worktrees/LAB-INITECH/f', { cwd: LAB_WORKTREE }).action)
      .toBe('gate');
  });
});

describe('non-lab session + lab target → unchanged', () => {
  for (const [command, cwd] of LAB_TARGETS) {
    test(`still gates: ${command}`, () => {
      outsideLab();
      expect(evaluateBashCommand(command, { cwd }).action).toBe('gate');
    });
  }

  test('rm inside a LAB worktree still redirects to trash outside the lab', () => {
    outsideLab();
    expect(evaluateBashCommand('rm -rf /workspace/worktrees/LAB-INITECH/src', { cwd: LAB_WORKTREE }).action)
      .toBe('block');
  });

  test('a neighbouring profile does not inherit the exemption', () => {
    process.env[PROFILE] = 'labs';
    expect(evaluateBashCommand('psql -d lab_initech -c "DROP TABLE users"', { cwd: LAB_WORKTREE }).action).toBe('gate');
  });
});

describe('cwd defaults to process.cwd() when the adapter has none', () => {
  test('no cwd option and a non-lab process cwd → gate', () => {
    inLab();
    expect(evaluateBashCommand('git push --force origin main').action).toBe('gate');
  });
});
