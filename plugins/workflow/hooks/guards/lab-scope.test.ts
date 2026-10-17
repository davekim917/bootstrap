import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  describeGate,
  evaluateBashCommand,
  isLabSession,
  labTargetOf,
  extractCommands,
  parseLabScope,
  LAB_SCOPE_FILE_ENV,
} from './block-destructive-core';

/**
 * LAB-SCOPED EXEMPTION.
 *
 * Two predicates must BOTH hold for a tier-2 gate to become an allow:
 *   1. lab session  — NANOCLAW_INSTRUCTIONS_PROFILE === 'lab'
 *   2. lab target   — the resolved command names a LAB-* or configured extra repo
 *                     under the configured lab org, a `lab-`/`lab_` database, or
 *                     a `lab-` Render resource
 *
 * Lab org and extra repos come from an untracked lab-scope file; these tests
 * point BOOTSTRAP_LAB_SCOPE_FILE at a fixture naming a fictional org.
 *
 * The three-way matrix below is the contract: lab+lab allows, lab+prod holds,
 * prod-session+lab holds. Tier 1 (the hard blocks) is never exempted.
 */

const PROFILE = 'NANOCLAW_INSTRUCTIONS_PROFILE';
let saved: string | undefined;

let scopeDir = '';
let scopeFile = '';
let savedScope: string | undefined;

beforeAll(() => {
  savedScope = process.env[LAB_SCOPE_FILE_ENV];
  scopeDir = mkdtempSync(join(tmpdir(), 'lab-scope-test-'));
  scopeFile = join(scopeDir, 'lab-scope.local.json');
  writeFileSync(scopeFile, JSON.stringify({ org: 'lab-org', extraRepos: ['TEAM-WIKI'] }));
  process.env[LAB_SCOPE_FILE_ENV] = scopeFile;
});

afterAll(() => {
  if (savedScope === undefined) delete process.env[LAB_SCOPE_FILE_ENV];
  else process.env[LAB_SCOPE_FILE_ENV] = savedScope;
  rmSync(scopeDir, { recursive: true, force: true });
});

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

const LAB_WORKTREE = '/workspace/worktrees/LAB-APP';
const PROD_WORKTREE = '/workspace/worktrees/APP';

// (command, cwd) pairs whose target IS a lab target.
const LAB_TARGETS: Array<[string, string]> = [
  // git — bare remote resolved through a lab worktree checkout
  ['git push --force origin main', LAB_WORKTREE],
  ['git push -f', LAB_WORKTREE],
  ['git push origin --delete scratch', LAB_WORKTREE],
  ['git push origin +main', LAB_WORKTREE],
  // git — explicit lab URL, cwd irrelevant
  ['git push --force https://github.com/Lab-Org/LAB-APP.git main', '/tmp'],
  ['git push --force git@github.com:lab-org/LAB-RENDER-SPIKE.git main', '/tmp'],
  ['git push --force https://github.com/Lab-Org/TEAM-WIKI.git main', '/tmp'],
  // Pre-rename lowercase spellings. GitHub repo names are case-insensitive and
  // both repos were renamed up from lowercase, so agents still hold URLs like
  // these and GitHub redirects them to the current name.
  ['git push --force https://github.com/lab-org/lab-app.git main', '/tmp'],
  ['git push --force https://github.com/lab-org/team-wiki.git main', '/tmp'],
  ['git push --force origin main', '/workspace/worktrees/lab-app'],
  ['gh repo delete lab-org/lab-app --yes', '/tmp'],
  // git — -C relocates the effective checkout
  [`git -C ${LAB_WORKTREE} push -f origin develop`, '/tmp'],
  // psql — lab database / user / connection string
  ['psql -d lab_app -c "DROP TABLE users"', '/tmp'],
  ['psql --dbname=lab_app -c "TRUNCATE events"', '/tmp'],
  ['psql -U lab_app_admin -d lab_app -c "DELETE FROM sessions"', '/tmp'],
  [
    'psql postgresql://lab_app_admin:pw@example.com/lab_app -c "DROP SCHEMA public CASCADE"',
    '/tmp',
  ],
  ['psql "host=example.com dbname=lab_app" -c "DROP TABLE t"', '/tmp'],
  // render — lab service / database argument
  ['render services delete lab-app-api --confirm', '/tmp'],
  ['render databases delete lab-app-db', '/tmp'],
  // gh — LAB-* repos only
  ['gh repo delete Lab-Org/LAB-APP --yes', '/tmp'],
];

// (command, cwd) pairs whose target is NOT a lab target. These must keep today's
// verdict in a lab room exactly as outside it.
const NON_LAB_TARGETS: Array<[string, string]> = [
  // prod / dev databases
  ['psql -d app_prod -c "DROP TABLE users"', LAB_WORKTREE],
  ['psql -d app_dev -c "TRUNCATE events"', LAB_WORKTREE],
  ['psql postgresql://app_admin:pw@example.com/app_prod -c "DROP TABLE t"', LAB_WORKTREE],
  // a runtime-constructed target has no visible lab signal — fails closed
  ['psql "$DATABASE_URL" -c "DROP TABLE users"', LAB_WORKTREE],
  // Snowflake has no lab tenant
  ['snow sql -q "DROP TABLE prod.orders"', LAB_WORKTREE],
  ['snow sql -q "DROP TABLE lab_app.orders"', LAB_WORKTREE],
  // non-LAB repos, by URL and by checkout
  ['git push --force https://github.com/Lab-Org/APP.git main', LAB_WORKTREE],
  ['git push --force Lab-Org/APP main', LAB_WORKTREE],
  ['git push --force origin main', PROD_WORKTREE],
  // a lab checkout does not launder a push aimed at a prod URL
  ['git push --force https://github.com/Lab-Org/APP.git main', LAB_WORKTREE],
  // wrong org — the owner is pinned to the configured lab org inside the pattern,
  // so a LAB-named repo belonging to anyone else is never exempt
  ['git push --force https://github.com/other-org/LAB-APP.git main', '/tmp'],
  ['git push --force https://github.com/other-org/lab-app.git main', '/tmp'],
  ['git push --force git@github.com:other-org/TEAM-WIKI.git main', '/tmp'],
  ['gh repo delete other-org/LAB-APP --yes', '/tmp'],
  // a repo whose name merely CONTAINS lab- is not a LAB-* repo
  ['git push --force https://github.com/lab-org/collab-tools.git main', '/tmp'],
  // non-lab Render resources
  ['render services delete app-prod-api --confirm', LAB_WORKTREE],
  // the wiki is lab-writable, not lab-deletable — in either casing
  ['gh repo delete Lab-Org/TEAM-WIKI --yes', LAB_WORKTREE],
  ['gh repo delete Lab-Org/team-wiki --yes', LAB_WORKTREE],
  ['gh repo delete Lab-Org/APP --yes', LAB_WORKTREE],
  // other platform CLIs are not in the exemption at all
  ['fly apps destroy lab-app-api', LAB_WORKTREE],
  ['kubectl delete deployment lab-app-api', LAB_WORKTREE],
  ['aws s3 rb s3://lab-app --force', LAB_WORKTREE],
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
      'rm -rf /workspace/worktrees/LAB-APP/src',
      'rm -rf /workspace/worktrees/LAB-APP',
      'rm -rf /workspace/worktrees/TEAM-WIKI/docs',
      // pre-rename lowercase checkout dirs
      'rm -rf /workspace/worktrees/lab-app/src',
      'rm -rf /workspace/worktrees/team-wiki/docs',
      // host-path alias mount of the same directory
      'rm -rf /home/ubuntu/nanoclaw-v2/data/v2-topics/wg-a/task-abc/worktrees/LAB-APP/src',
    ]) {
      expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('allow');
    }
  });

  test('a lab gate and a lab rm in one command line both clear', () => {
    inLab();
    const command = 'psql -d lab_app -c "DROP TABLE users" && rm -rf /workspace/worktrees/LAB-APP/src';
    expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('allow');
  });

  test('a non-lab gate alongside a lab gate still holds', () => {
    inLab();
    const command = 'psql -d lab_app -c "DROP TABLE users" && psql -d app_prod -c "DROP TABLE users"';
    expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('gate');
  });

  test('a step xargs runs under env -C takes its target from that directory', () => {
    inLab();
    const prod = 'xargs -a /dev/null env -C /prod/repo git push --force origin main';
    expect(evaluateBashCommand(prod, { cwd: LAB_WORKTREE }).action).toBe('gate');
    const viaShell = "xargs -a /dev/null env -C /prod/repo sh -c 'git push --force origin main'";
    expect(evaluateBashCommand(viaShell, { cwd: LAB_WORKTREE }).action).toBe('gate');
    const runtime = "printf '%s\\n' 'push --force https://github.com/Prod-Org/APP.git main' | xargs git";
    expect(evaluateBashCommand(runtime, { cwd: LAB_WORKTREE }).action).toBe('gate');
    const lab = `xargs -a /dev/null -I{} env -C ${LAB_WORKTREE} git push --force origin main`;
    expect(evaluateBashCommand(lab, { cwd: '/tmp' }).action).toBe('allow');
  });

  test('a step holding a word xargs reads or find matches gets no lab exemption', () => {
    inLab();
    // Appended words are only known at run time, so the target they may name is too.
    expect(evaluateBashCommand(`xargs -a /dev/null env -C ${LAB_WORKTREE} git push --force origin main`, { cwd: '/tmp' }).action).toBe('gate');
    // -execdir, or a cd to a match, runs it in a directory only the matches decide.
    expect(evaluateBashCommand('find / -name .git -execdir git clean -fdx \\;', { cwd: LAB_WORKTREE }).action).toBe('gate');
    expect(evaluateBashCommand("find / -name .git -exec sh -c 'cd \"$1\"; git clean -fdx' _ {} \\;", { cwd: LAB_WORKTREE }).action).toBe('gate');
  });

  test('git clean is exempt only in a lab work tree, whatever its words name', () => {
    inLab();
    expect(evaluateBashCommand('git clean -fd -e lab-org/LAB-X .', { cwd: PROD_WORKTREE }).action).toBe('gate');
    expect(evaluateBashCommand(`GIT_WORK_TREE=${PROD_WORKTREE} git clean -fd`, { cwd: LAB_WORKTREE }).action).toBe('gate');
    expect(evaluateBashCommand('git clean -fd', { cwd: LAB_WORKTREE }).action).toBe('allow');
    expect(evaluateBashCommand(`export GIT_WORK_TREE=${PROD_WORKTREE}; git clean -fd`, { cwd: LAB_WORKTREE }).action).toBe('gate');
    expect(evaluateBashCommand(`export GIT_DIR=${PROD_WORKTREE}/.git; git clean -fd`, { cwd: LAB_WORKTREE }).action).toBe('gate');
    expect(evaluateBashCommand(`export GIT_WORK_TREE=${PROD_WORKTREE}; GIT_WORK_TREE=${LAB_WORKTREE} git clean -fd`, { cwd: LAB_WORKTREE }).action).toBe('allow');
  });

  test('a cd before a step xargs or find runs moves its target', () => {
    inLab();
    const inScript = "printf x | xargs sh -c 'cd /prod/repo; git push --force origin main'";
    expect(evaluateBashCommand(inScript, { cwd: LAB_WORKTREE }).action).toBe('gate');
    const before = 'cd /prod/repo && find . -maxdepth 0 -exec git push --force origin main \\;';
    expect(evaluateBashCommand(before, { cwd: LAB_WORKTREE }).action).toBe('gate');
    const topLevel = 'cd /prod/repo && git push --force origin main';
    expect(evaluateBashCommand(topLevel, { cwd: LAB_WORKTREE }).action).toBe('gate');
    const unknown = 'cd "$REPO" && git push --force origin main';
    expect(evaluateBashCommand(unknown, { cwd: LAB_WORKTREE }).action).toBe('gate');
    const intoLab = `cd ${LAB_WORKTREE}/src && git push --force origin main`;
    expect(evaluateBashCommand(intoLab, { cwd: LAB_WORKTREE }).action).toBe('allow');
    const scriptIntoLab = `printf x | xargs sh -c 'cd ${LAB_WORKTREE}; git push --force origin main'`;
    expect(evaluateBashCommand(scriptIntoLab, { cwd: LAB_WORKTREE }).action).toBe('allow');
  });

  test('inside xargs, a lab step does not exempt a later non-lab step', () => {
    inLab();
    const prod = `xargs sh -c 'psql -d lab_app -c "DROP TABLE scratch"; psql -d app_prod -c "DROP TABLE users"' < list`;
    expect(evaluateBashCommand(prod, { cwd: LAB_WORKTREE }).action).toBe('gate');
    const labOnly = `xargs sh -c 'psql -d lab_app -c "DROP TABLE scratch"' < list`;
    expect(evaluateBashCommand(labOnly, { cwd: LAB_WORKTREE }).action).toBe('allow');
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
      'rm -rf /workspace/worktrees/APP/src',
      'rm -rf /workspace/agent/notes',
      'rm -rf /workspace/worktrees/LAB-APP/../APP/src',
    ]) {
      expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('block');
    }
  });

  test('protected home paths stay hard-blocked in a lab session', () => {
    inLab();
    for (const command of ['rm -rf ~/.ssh', 'rm -rf /', 'rm -rf /home/ubuntu/Documents']) {
      expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('block');
    }
  });
});

describe('tier 1 is never exempted, lab or not', () => {
  for (const command of [
    'eval echo x',
    'bash -c "psql -d lab_app -c \'DROP TABLE users\'"',
    'sh -c "rm -rf /workspace/worktrees/LAB-APP"',
    'find /workspace/worktrees/LAB-APP -delete',
    'xargs rm < list',
    'shred -u /workspace/worktrees/LAB-APP/secret',
    'truncate -s 0 /workspace/worktrees/LAB-APP/log',
    'unlink /workspace/worktrees/LAB-APP/f',
  ]) {
    test(`blocks in a lab session: ${command}`, () => {
      inLab();
      expect(evaluateBashCommand(command, { cwd: LAB_WORKTREE }).action).toBe('block');
    });
  }

  test('dd stays gated in a lab session', () => {
    inLab();
    expect(evaluateBashCommand('dd if=/dev/zero of=/workspace/worktrees/LAB-APP/f', { cwd: LAB_WORKTREE }).action)
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

  test('rm inside a LAB worktree still redirects to trash outside a lab session', () => {
    outsideLab();
    expect(evaluateBashCommand('rm -rf /workspace/worktrees/LAB-APP/src', { cwd: LAB_WORKTREE }).action)
      .toBe('block');
  });

  test('a neighbouring profile does not inherit the exemption', () => {
    process.env[PROFILE] = 'labs';
    expect(evaluateBashCommand('psql -d lab_app -c "DROP TABLE users"', { cwd: LAB_WORKTREE }).action).toBe('gate');
  });
});

describe('cwd defaults to process.cwd() when the adapter has none', () => {
  test('no cwd option and a non-lab process cwd → gate', () => {
    inLab();
    expect(evaluateBashCommand('git push --force origin main').action).toBe('gate');
  });
});

describe('lab scope comes from local config and fails closed', () => {
  const explicitLabUrl = 'git push --force https://github.com/lab-org/LAB-APP.git main';

  function withScopeFile(path: string, body: () => void): void {
    const previous = process.env[LAB_SCOPE_FILE_ENV];
    process.env[LAB_SCOPE_FILE_ENV] = path;
    try {
      body();
    } finally {
      if (previous === undefined) delete process.env[LAB_SCOPE_FILE_ENV];
      else process.env[LAB_SCOPE_FILE_ENV] = previous;
    }
  }

  test('a missing config file means no lab org: explicit lab URLs stay gated', () => {
    withScopeFile(join(scopeDir, 'absent.json'), () => {
      inLab();
      expect(evaluateBashCommand(explicitLabUrl, { cwd: '/tmp' }).action).toBe('gate');
      expect(evaluateBashCommand('gh repo delete lab-org/LAB-APP --yes', { cwd: '/tmp' }).action).toBe('gate');
    });
  });

  test('an empty override disables any lab org rather than falling back', () => {
    withScopeFile('', () => {
      inLab();
      expect(evaluateBashCommand(explicitLabUrl, { cwd: '/tmp' }).action).toBe('gate');
    });
  });

  test('a malformed config file means no lab org', () => {
    const bad = join(scopeDir, 'bad.json');
    writeFileSync(bad, '{"org": "lab org with spaces"}');
    withScopeFile(bad, () => {
      inLab();
      expect(evaluateBashCommand(explicitLabUrl, { cwd: '/tmp' }).action).toBe('gate');
    });
  });

  test('extra repos are writable but never deletable without approval', () => {
    inLab();
    expect(
      evaluateBashCommand('git push --force https://github.com/lab-org/TEAM-WIKI.git main', { cwd: '/tmp' }).action,
    ).toBe('allow');
    expect(evaluateBashCommand('gh repo delete lab-org/TEAM-WIKI --yes', { cwd: '/tmp' }).action).toBe('gate');
  });

  test('a dotted sibling of a lab repo is not that lab repo', () => {
    inLab();
    for (const repo of ['TEAM-WIKI.production', 'LAB-APP.prod', 'LAB-APP.git.bak']) {
      expect(
        evaluateBashCommand(`git push --force https://github.com/lab-org/${repo}.git main`, { cwd: '/tmp' }).action,
      ).toBe('gate');
    }
    expect(
      evaluateBashCommand('git push --force https://github.com/lab-org/LAB-APP.git main', { cwd: '/tmp' }).action,
    ).toBe('allow');
  });

  test('a lab org path on another host is not a lab repo', () => {
    inLab();
    for (const url of [
      'https://example.com/lab-org/TEAM-WIKI.git',
      'https://example.com/lab-org/LAB-APP.git',
      'https://example.com/github.com/lab-org/LAB-APP.git',
      'https://github.com.example.net/lab-org/LAB-APP.git',
      'git@example.com:lab-org/LAB-APP.git',
    ]) {
      expect(evaluateBashCommand(`git push --force ${url} main`, { cwd: '/tmp' }).action).toBe('gate');
    }
    for (const url of [
      'https://github.com/lab-org/LAB-APP',
      'ssh://git@github.com/lab-org/LAB-APP.git',
      'ssh://git@ssh.github.com:443/lab-org/LAB-APP.git',
      'git@github.com:lab-org/LAB-APP.git',
    ]) {
      expect(evaluateBashCommand(`git push --force ${url} main`, { cwd: '/tmp' }).action).toBe('allow');
    }
  });

  test('a narrowed config takes effect even when size and mtime are unchanged', () => {
    const file = join(scopeDir, 'narrowed.json');
    writeFileSync(file, JSON.stringify({ org: 'lab-org1' }));
    withScopeFile(file, () => {
      inLab();
      const url = 'git push --force https://github.com/lab-org1/LAB-APP.git main';
      expect(evaluateBashCommand(url, { cwd: '/tmp' }).action).toBe('allow');
      const { atime, mtime } = statSync(file);
      writeFileSync(file, JSON.stringify({ org: 'lab-org2' }));
      utimesSync(file, atime, mtime);
      expect(evaluateBashCommand(url, { cwd: '/tmp' }).action).toBe('gate');
    });
  });

  test('a config change is picked up without re-importing the core', () => {
    const other = join(scopeDir, 'other.json');
    writeFileSync(other, JSON.stringify({ org: 'second-org' }));
    withScopeFile(other, () => {
      inLab();
      expect(evaluateBashCommand(explicitLabUrl, { cwd: '/tmp' }).action).toBe('gate');
      expect(
        evaluateBashCommand('git push --force https://github.com/second-org/LAB-APP.git main', { cwd: '/tmp' }).action,
      ).toBe('allow');
    });
  });
});

describe('parseLabScope', () => {
  test('accepts an org with optional extra repos', () => {
    expect(parseLabScope('{"org":"lab-org"}')).toEqual({ org: 'lab-org', extraRepos: [] });
    expect(parseLabScope('{"org":"lab-org","extraRepos":["TEAM-WIKI"]}')).toEqual({
      org: 'lab-org',
      extraRepos: ['TEAM-WIKI'],
    });
  });

  test('rejects anything that could widen or break the pattern', () => {
    for (const text of [
      'not json',
      '[]',
      'null',
      '{}',
      '{"org":""}',
      '{"org":".*"}',
      '{"org":"a|b"}',
      '{"org":"lab-org","extraRepos":"TEAM-WIKI"}',
      '{"org":"lab-org","extraRepos":[".*|x"]}',
      '{"org":"lab-org","extraRepos":[1]}',
    ]) {
      expect(parseLabScope(text)).toBeNull();
    }
  });
});

describe('the approval description skips exempt steps', () => {
  test('an exempt lab push is not described; the step that was gated is', () => {
    inLab();
    const command = 'git push -f https://github.com/lab-org/LAB-APP.git main && git push --delete https://github.com/example-corp/widget.git stale-branch';
    const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
    expect(verdict.action).toBe('gate');
    const card = describeGate(command, verdict.reason!, '/tmp');
    expect(card.label).toBe('Delete remote branch stale-branch on https://github.com/example-corp/widget.git');
    expect(card.summary).not.toContain('LAB-APP.git main`');
  });
});
