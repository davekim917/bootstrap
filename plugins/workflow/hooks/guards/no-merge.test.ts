import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { MERGE_SCOPE_FILE_ENV, evaluateBashCommand, parseMergeScope } from './block-destructive-core';

/**
 * REPOSITORIES AGENTS NEVER MERGE INTO. For a repository the merge scope lists,
 * every merge path and every push to a protected branch is refused outright;
 * feature-branch pushes and draft pull requests still work.
 */

let dir = '';
let scopeFile = '';
let other = '';
let theirs = '';
let saved: string | undefined;

function checkout(path: string, url: string, branch: string): void {
    mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    writeFileSync(join(path, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

beforeAll(() => {
    saved = process.env[MERGE_SCOPE_FILE_ENV];
    dir = mkdtempSync(join(tmpdir(), 'merge-scope-test-'));
    scopeFile = join(dir, 'merge-scope.local.json');
    writeFileSync(scopeFile, JSON.stringify({ noMerge: { 'Acme/core': ['master'] } }));
    theirs = join(dir, 'core');
    other = join(dir, 'ours');
    checkout(theirs, 'https://github.com/Acme/core.git', 'feature-x');
    checkout(other, 'git@github.com:example/ours.git', 'master');
    process.env[MERGE_SCOPE_FILE_ENV] = scopeFile;
});

afterEach(() => {
    process.env[MERGE_SCOPE_FILE_ENV] = scopeFile;
});

afterAll(() => {
    if (saved === undefined) delete process.env[MERGE_SCOPE_FILE_ENV];
    else process.env[MERGE_SCOPE_FILE_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
});

const action = (command: string, cwd: string) => evaluateBashCommand(command, { cwd }).action;

describe('a listed repository refuses every merge and protected-branch push', () => {
    test.each([
        ['gh pr merge in its checkout', 'gh pr merge 12 --squash', () => theirs],
        ['gh pr merge naming it', 'gh pr merge 12 -R Acme/core --squash', () => other],
        ['gh pr merge naming it with --repo=', 'gh pr merge 12 --repo=acme/CORE', () => other],
        ['gh pr merge by URL', 'gh pr merge https://github.com/Acme/core/pull/12', () => other],
        ['auto-merge', 'gh pr merge 12 --auto --squash', () => theirs],
        ['the REST merge endpoint', 'gh api -X PUT repos/Acme/core/pulls/12/merge', () => other],
        ['the REST merge endpoint by curl', 'curl -X PUT https://api.github.com/repos/Acme/core/pulls/12/merge', () => other],
        ['a GraphQL merge from its checkout', `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`, () => theirs],
        ['the review-loop merge', 'PR=12 REPO=Acme/core codex-review.sh merge --head abc', () => other],
        ['a push to the protected branch', 'git push origin HEAD:master', () => theirs],
        ['a push of the checked-out protected branch', 'git push', () => join(dir, 'core-on-master')],
        ['a push after cd into the checkout', 'cd CORE && git push origin feature-x:master', () => dir],
        ['a delete of the protected branch', 'git push origin :master', () => theirs],
        ['a push of every branch', 'git push --all origin', () => theirs],
        ['a push by URL', 'git push https://github.com/Acme/core.git main:master', () => other],
        ['a push to that branch name from a checkout the guard can not place', 'cd $D && git push origin HEAD:master', () => dir],
    ])('%s', (_label, command, cwd) => {
        checkout(join(dir, 'core-on-master'), 'https://github.com/Acme/core.git', 'master');
        const resolved = command.replace('cd CORE', `cd ${theirs}`);
        expect(action(resolved, cwd())).toBe('block');
    });
});

describe('everything else is untouched', () => {
    test.each([
        ['a feature-branch push', 'git push -u origin feature-x', () => theirs],
        ['a draft pull request', 'gh pr create --draft --title t --body b', () => theirs],
        ['a merge in another repository', 'gh pr merge 12 --squash', () => other],
        ['a push to master of another repository', 'git push origin master', () => other],
        ['the review-loop merge elsewhere', 'PR=3 REPO=example/ours codex-review.sh merge --head abc', () => theirs],
    ])('%s', (_label, command, cwd) => {
        expect(action(command, cwd())).toBe('allow');
    });

    test('no merge-scope file refuses nothing', () => {
        process.env[MERGE_SCOPE_FILE_ENV] = join(dir, 'missing.json');
        expect(action('gh pr merge 12 --squash', theirs)).toBe('allow');
    });

    test('an unreadable merge-scope file refuses every merge', () => {
        const broken = join(dir, 'broken.json');
        writeFileSync(broken, '{"noMerge": ');
        process.env[MERGE_SCOPE_FILE_ENV] = broken;
        expect(action('gh pr merge 12 --squash', other)).toBe('block');
    });
});

describe('merge-scope files', () => {
    test.each([
        [{ noMerge: { 'Acme/core': ['master'] } }, true],
        [{ noMerge: { 'Acme/core': [] } }, false],
        [{ noMerge: { 'not a repo': ['master'] } }, false],
        [{ noMerge: ['Acme/core'] }, false],
        [{}, false],
    ])('%j parses: %p', (scope, ok) => {
        expect(parseMergeScope(JSON.stringify(scope)) !== null).toBe(ok);
    });
});
