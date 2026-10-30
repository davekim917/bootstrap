import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'fs';
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
let fork = '';
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
    fork = join(dir, 'fork');
    checkout(fork, 'git@github.com:example/core.git', 'feature-x');
    writeFileSync(join(fork, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:example/core.git\n[remote "upstream"]\n\turl = https://github.com/Acme/core.git\n`);
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
        ['gh pr merge naming it before the subcommand', 'gh -R Acme/core pr merge 12 --squash', () => other],
        ['gh pr merge with an attached -R', 'gh pr merge 12 -RAcme/core', () => other],
        ['gh pr merge with GH_REPO set on the command', 'GH_REPO=Acme/core gh pr merge 12 --squash', () => other],
        ['gh pr merge after GH_REPO is exported', 'export GH_REPO=Acme/core && gh pr merge 12 --squash', () => other],
        ['auto-merge', 'gh pr merge 12 --auto --squash', () => theirs],
        ['the REST merge endpoint', 'gh api -X PUT repos/Acme/core/pulls/12/merge', () => other],
        ['the REST merge endpoint with gh placeholders', 'gh api -X PUT repos/{owner}/{repo}/pulls/12/merge', () => theirs],
        ['a merge after cd into the checkout', 'cd core && gh pr merge 12 --squash', () => dir],
        ['gh placeholders filled by GH_REPO', 'GH_REPO=Acme/core gh api -X PUT repos/{owner}/{repo}/pulls/12/merge', () => other],
        ['the REST branch-merge endpoint', 'gh api -X POST repos/Acme/core/merges -f base=master -f head=feature-x', () => other],
        ['a repository named through a variable', 'repo=Acme/core; gh pr merge 12 -R "$repo" --squash', () => other],
        ['a merge after a cd the guard cannot follow', 'cd "$CHECKOUT" && gh pr merge 12 --squash', () => other],
        ['a push of every branch after a cd the guard cannot follow', 'cd "$CHECKOUT" && git push --all origin', () => other],
        ['a pull request URL held in a variable', 'PR_URL=https://github.com/Acme/core/pull/12; gh pr merge "$PR_URL" --squash', () => other],
        ['a REST merge endpoint with a variable part', 'PR=12; gh api -X PUT "repos/Acme/core/pulls/$PR/merge"', () => other],
        ['a REST merge endpoint whose whole repository is a variable', 'REPO=Acme/core; gh api -X PUT "repos/$REPO/pulls/12/merge"', () => other],
        ['a merge from a variable env -C directory', 'CHECKOUT=/somewhere; env -C "$CHECKOUT" gh pr merge 12 --squash', () => other],
        ['the REST merge endpoint by curl', 'curl -X PUT https://api.github.com/repos/Acme/core/pulls/12/merge', () => other],
        ['a GraphQL merge from its checkout', `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`, () => theirs],
        ['the review-loop merge', 'PR=12 REPO=Acme/core codex-review.sh merge --head abc', () => other],
        ['a push to the protected branch', 'git push origin HEAD:master', () => theirs],
        ['a push after repointing origin at the listed repository', 'git remote set-url origin git@github.com:Acme/core.git && git push origin HEAD:master', () => other],
        ['a merge in a checkout cloned in the same step', 'git clone git@github.com:Acme/core.git NEWDIR && cd NEWDIR && gh pr merge 12 --squash', () => dir],
        ['a push behind onecli run', 'onecli run --agent ag-example -- git push origin HEAD:master', () => theirs],
        ['a merge behind onecli run', 'onecli run -- gh pr merge 12 -R Acme/core --squash', () => other],
        ['a push naming a protected branch after gh pr checkout from another checkout', 'gh pr checkout 12 && git push origin HEAD:master', () => other],
        ['a push of the current branch after gh pr checkout', 'gh pr checkout 12 && git push origin HEAD', () => theirs],
        ['a push of the current branch after gh pr co', 'gh pr co 12 && git push', () => theirs],
        ['an implicit push from a fork whose upstream is listed', 'git push', () => {
            const tracking = join(dir, 'tracking');
            checkout(tracking, 'git@github.com:example/core.git', 'master');
            writeFileSync(join(tracking, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:example/core.git\n[remote "upstream"]\n\turl = https://github.com/Acme/core.git\n[branch "master"]\n\tremote = upstream\n\tmerge = refs/heads/master\n`);
            return tracking;
        }],
        ['a repository sync into the listed repository', 'gh repo sync Acme/core --branch master', () => other],
        ['a repository sync from inside the listed checkout', 'gh repo sync --branch master', () => theirs],
        ['a protected push in every submodule', "git submodule foreach 'git push origin master'", () => other],
        ['a protected push from a find match directory', 'find LISTED_DIR -maxdepth 0 -exec git -C {} push origin HEAD:master \\;', () => other],
        ['a protected push after a cd inside an executor script', "find . -maxdepth 0 -exec sh -c 'cd LISTED_DIR && git push origin HEAD:master' \\;", () => other],
        ['an implicit push run by find after a branch switch', 'git switch master && find . -maxdepth 0 -exec git push origin HEAD \\;', () => theirs],
        ['a protected push two executors deep', "find . -maxdepth 0 -exec git submodule foreach 'git push origin HEAD:master' \\;", () => other],
        ['a REST merge with a gh option before api', 'gh --hostname github.com api -X PUT repos/Acme/core/pulls/12/merge', () => other],
        ['an implicit push after a script the guard does not follow', './prepare.sh && git push origin HEAD', () => theirs],
        ['a protected push in a ~ path', 'git -C ~/listed-core push origin HEAD:master', () => other],
        ['a merge whose repository xargs fills in', "printf '%s\\n' Acme/core | xargs -I{} gh pr merge 12 -R {} --squash", () => other],
        ['a merge run by find -exec', 'find . -maxdepth 0 -exec gh pr merge 12 -R Acme/core --squash \\;', () => other],
        ['a matching push, which writes every matching branch', 'git push origin :', () => theirs],
        ['a push through a symlink into the listed checkout', 'cd core-link && git push origin HEAD:master', () => {
            mkdirSync(join(theirs, 'subdir'), { recursive: true });
            const link = join(other, 'core-link');
            if (!existsSync(link)) symlinkSync(join(theirs, 'subdir'), link);
            return other;
        }],
        ['a push of @ from the protected branch', 'git push origin @', () => join(dir, 'core-on-master')],
        ['a second REST merge endpoint on one curl', 'curl -X PUT https://api.github.com/repos/example/ours/pulls/1/merge https://api.github.com/repos/Acme/core/pulls/12/merge', () => other],
        ['a push from a worktree added in the same step', 'git -C CORE worktree add NESTED master && git -C NESTED push origin HEAD:master', () => other],
        ['a push after gh pr checkout with a repository flag first', 'gh -R Acme/core pr checkout 12 && git push origin HEAD', () => theirs],
        ['a merge in a checkout gh cloned in the same step', 'gh repo clone Acme/core NESTED && cd NESTED && gh pr merge 12 --squash', () => other],
        ['a push of the current branch after renaming it', 'git branch -M master && git push -u origin HEAD', () => theirs],
        ['a merge with an empty GH_REPO, which gh ignores', "GH_REPO='' gh pr merge 12 --squash", () => theirs],
        ['a push to the protected branch over GitHub SSH on port 443', 'git push ssh://git@ssh.github.com:443/Acme/core.git HEAD:master', () => other],
        ['a push of the checked-out protected branch', 'git push', () => join(dir, 'core-on-master')],
        ['a push after cd into the checkout', 'cd CORE && git push origin feature-x:master', () => dir],
        ['a delete of the protected branch', 'git push origin :master', () => theirs],
        ['a push of every branch', 'git push --all origin', () => theirs],
        ['a push of every branch by its alias', 'git push --branches origin', () => theirs],
        ['a push of every branch by an abbreviation', 'git push --mirr origin', () => theirs],
        ['a push by URL', 'git push https://github.com/Acme/core.git main:master', () => other],
        ['a push to that branch name from a checkout the guard can not place', 'cd $D && git push origin HEAD:master', () => dir],
        ['a push of the current branch after switching to the protected one', 'git switch master && git push', () => theirs],
        ['a push after checking out the protected branch', 'git checkout master && git push origin HEAD', () => theirs],
        ['a push whose last -C names the checkout', 'git -C OURS -C ../core push origin HEAD:master', () => dir],
        ['a push of the current branch after a switch in another checkout', 'git -C OURS switch feature-x && git push', () => join(dir, 'core-on-master')],
        ['a push from another checkout after a switch here', 'git switch feature-x && git -C CORE_ON_MASTER push', () => other],
        ['a push after switching to the previous branch', "git switch '@{-1}' && git push", () => theirs],
        ['a push after a switch here and a cd into the checkout', 'git switch feature-x && cd CORE_ON_MASTER && git push', () => other],
        ['a push moved by -C after a switch there', 'git -C CORE switch master && git -C CORE push', () => other],
        ['a merge from a fork whose upstream is the listed repository', 'gh pr merge 12 --squash', () => fork],
        ['a push of the current branch after creating it, which the guard does not infer', 'git checkout -b fix-y && git push -u origin HEAD', () => theirs],
        ['a REST merge endpoint held whole in a variable', 'ENDPOINT=repos/Acme/core/pulls/12/merge; gh api -X PUT "$ENDPOINT"', () => other],
        ['a REST merge endpoint with a partial placeholder', 'GH_REPO=example/core gh api -X PUT repos/Acme/{repo}/pulls/12/merge', () => other],
    ])('%s', (_label, command, cwd) => {
        checkout(join(dir, 'core-on-master'), 'https://github.com/Acme/core.git', 'master');
        const resolved = command.replace('cd CORE', `cd ${theirs}`).replace('-C OURS', `-C ${other}`).replace('CORE_ON_MASTER', join(dir, 'core-on-master')).replaceAll('-C CORE ', `-C ${theirs} `).replaceAll('NEWDIR', join(dir, 'not-yet-cloned')).replaceAll('NESTED', join(other, 'new-core')).replaceAll('LISTED_DIR', theirs);
        expect(action(resolved, cwd())).toBe('block');
    });
});

describe('everything else is untouched', () => {
    test.each([
        ['a feature-branch push', 'git push -u origin feature-x', () => theirs],
        ['a merge in a checkout with an extra remote off GitHub', 'gh pr merge 12 --squash', () => {
            const mixed = join(dir, 'mixed');
            checkout(mixed, 'git@github.com:example/ours.git', 'feature-x');
            writeFileSync(join(mixed, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:example/ours.git\n[remote "mirror"]\n\turl = https://gitlab.com/example/ours.git\n`);
            return mixed;
        }],
        ['a feature push in every submodule', "git submodule foreach 'git push origin feature-x'", () => other],
        ['a push after a file edit, in a checkout of no listed repository', "sed -i 's/a/b/' notes.md && git push origin HEAD", () => other],
        ['a push before a worktree is removed', 'git push origin HEAD && git worktree remove ../scratch-tree', () => other],
        ['a feature push after a script', './prepare.sh && git push origin feature-x', () => theirs],
        ['a merge in another repository after listing remotes', 'git remote -v && gh pr merge 12 --squash', () => other],
        ['a push naming the branch just created', 'git checkout -b fix-y && git push -u origin fix-y', () => theirs],
        ['a tags-only push from the protected branch', 'git push origin --tags', () => join(dir, 'core-on-master')],
        ['a push to a repository off GitHub', 'git push https://gitlab.com/example/ours.git HEAD:master', () => theirs],
        ['a draft pull request', 'gh pr create --draft --title t --body b', () => theirs],
        ['a merge in another repository', 'gh pr merge 12 --squash', () => other],
        ['a merge naming another repository from their checkout', 'gh pr merge 12 -R example/ours', () => theirs],
        ['a merge with a subject held in a variable', 'gh pr merge 12 --squash --subject "$TITLE"', () => other],
        ['an atomic feature-branch push', 'git push --atomic origin feature-x', () => theirs],
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
