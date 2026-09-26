import { describe, test, expect } from 'bun:test';
import { evaluateBashCommand, GIT_HOOK_BYPASS_REASON } from './block-destructive-core';

/**
 * GIT HOOK BYPASS — a repo's hooks are its own gates (leak scan, formatting,
 * parity). Skipping or disabling them is a hard block, lab session or not.
 */

const BLOCKED = [
  'git commit --no-verify -m "x"',
  'git commit -m "x" --no-verify',
  'git commit -n -m "x"',
  'git commit -anm "x"',
  'git commit -am "x" -n',
  'git commit --no-verif -m x',
  'git -C /repo commit --no-verify -m x',
  'git push --no-verify origin feature',
  'git push origin feature --no-verify',
  'git merge --no-verify feature',
  'git am --no-verify patch.mbox',
  'git rebase --no-verify main',
  'git -c core.hooksPath=/dev/null commit -m x',
  'git -c core.hookspath=/tmp/empty push origin feature',
  'git --config-env=core.hooksPath=EMPTY commit -m x',
  'git config core.hooksPath /dev/null',
  'git config --local core.hooksPath .nohooks',
  'git config --unset core.hooksPath',
  'git config set core.hooksPath /dev/null',
  'git config unset core.hooksPath',
  'HUSKY=0 git commit -m x',
  'env HUSKY=0 git push origin feature',
  'HUSKY_SKIP_HOOKS=1 git commit -m x',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
  'export HUSKY=0',
  'git add . && git commit --no-verify -m x',
  'git --config-env core.hooksPath=EMPTY commit -m x',
  'git config --remove-section core',
  'git config --rename-section core retired',
  'git config remove-section core',
  'git config --global --remove-section bootstrap',
  'env -u FOO git push --no-verify origin main',
  'env -C /repo git commit -n -m x',
  "env -S 'git commit --no-verify -m x'",
  'env --split-string="git push --no-verify origin main"',
  'git -c bootstrap.boundaryChecker= push origin feature',
  'git -c bootstrap.boundarychecker=/nowhere commit -m x',
  'git config --unset bootstrap.boundaryChecker',
  'git config bootstrap.boundaryChecker ""',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=bootstrap.boundaryChecker GIT_CONFIG_VALUE_0= git push origin feature',
];

const ALLOWED = [
  'git commit -m "x"',
  'git commit -am "fix the -n flag handling"',
  'git commit -m -n',
  'git commit --message "--no-verify is now refused"',
  'git commit -uno -m x',
  'git push -n origin feature',
  'git push --dry-run origin feature',
  'git cherry-pick -n abc123',
  'git revert -n abc123',
  'git merge -n feature',
  'git config core.hooksPath',
  'git config --get core.hooksPath',
  'git config get core.hooksPath',
  'git config user.name "A Person"',
  'HUSKY=1 git commit -m x',
  'git commit -m --no-verify',
  'git config --get core.hooksPath scripts/hooks',
  'git config --get bootstrap.boundaryChecker',
  'git config --list',
  'git config --remove-section alias',
  'env -u FOO git push origin main',
];

describe('hook bypass is refused', () => {
  for (const command of BLOCKED) {
    test(`blocks: ${command}`, () => {
      const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
      expect(verdict.action).toBe('block');
      expect(verdict.reason).toBe(GIT_HOOK_BYPASS_REASON);
    });
  }
});

describe('ordinary git use is unaffected', () => {
  for (const command of ALLOWED) {
    test(`allows: ${command}`, () => {
      const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
      expect(verdict.reason === GIT_HOOK_BYPASS_REASON).toBe(false);
    });
  }
});

describe('wrapper option values are not mistaken for the command', () => {
  test('env -u NAME still resolves the real command for every check', () => {
    expect(evaluateBashCommand('rm -rf /srv/project/src', { cwd: '/srv/project' }).action).toBe('block');
    expect(evaluateBashCommand('env -u FOO rm -rf /srv/project/src', { cwd: '/srv/project' }).action).toBe('block');
    expect(evaluateBashCommand('env -C /srv rm -rf /srv/project/src', { cwd: '/srv/project' }).action).toBe('block');
    expect(evaluateBashCommand("env -S 'rm -rf /srv/project/src'", { cwd: '/srv/project' }).action).toBe('block');
  });
});

describe('a lab session does not exempt it', () => {
  test('hook bypass stays blocked in a lab session', () => {
    const previous = process.env.NANOCLAW_INSTRUCTIONS_PROFILE;
    process.env.NANOCLAW_INSTRUCTIONS_PROFILE = 'lab';
    try {
      expect(evaluateBashCommand('git push --no-verify origin main', { cwd: '/workspace/worktrees/LAB-APP' }).action)
        .toBe('block');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_INSTRUCTIONS_PROFILE;
      else process.env.NANOCLAW_INSTRUCTIONS_PROFILE = previous;
    }
  });
});
