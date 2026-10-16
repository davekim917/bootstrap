import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { claimText, decide, extractClaims, transcriptRefs } from '../hooks/claim-check.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'claim-check.mjs');
const REMOTE = 'example-org/example-app';
const OTHER = 'example-org/other-app';

const dirs = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function gitEnv(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
}

/** A real checkout whose origin is a GitHub URL for `remote`. */
function checkout(remote = REMOTE) {
  const dir = tempDir('claim-check-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: gitEnv(dir), encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', `https://github.com/${remote}.git`);
  return dir;
}

function transcript(records) {
  const file = path.join(tempDir('claim-check-transcript-'), 't.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

/**
 * A GitHub API stand-in at the gh CLI boundary. `routes` maps an API path to what gh prints (after --jq) or to an
 * `{ http: <code> }` failure; anything unrouted fails the way an unreachable network does.
 */
function fakeGh(routes) {
  const calls = [];
  const gh = (args) => {
    calls.push(args[1]);
    const route = routes[args[1]];
    if (route === undefined) return { status: 1, stdout: '', stderr: 'error connecting to api.github.com' };
    if (route?.http) {
      // gh api prints an error response's body on stdout, whether or not --jq was given.
      const body = route.body ?? '';
      return { status: 1, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: `gh: ${route.message ?? 'Not Found'} (HTTP ${route.http})` };
    }
    return { status: 0, stdout: typeof route === 'string' ? route : JSON.stringify(route), stderr: '' };
  };
  return { gh, calls };
}

function judge(message, { cwd, records, routes = {} } = {}) {
  const logs = [];
  const { gh, calls } = fakeGh(routes);
  const input = { last_assistant_message: message, cwd, transcript_path: records ? transcript(records) : undefined };
  const verdict = decide(input, { gh, log: (l) => logs.push(l) });
  return { verdict, logs, calls };
}

const OPEN_PR_42 = {
  [`repos/${REMOTE}`]: '',
  [`repos/${REMOTE}/commits/d30add0e`]: { http: 422, message: 'No commit found for SHA: d30add0e' },
  [`repos/${REMOTE}/issues/42`]: { state: 'open', pr: true },
  [`repos/${REMOTE}/pulls/42`]: 'false',
  [`repos/${REMOTE}/issues/43`]: { state: 'open', pr: true },
  [`repos/${REMOTE}/issues/43/events`]: '0',
};

test('the fabricated-merge replay is sent back: invented merge SHA, PR still open, and a claimed close of an open PR', () => {
  const cwd = checkout();
  const { verdict } = judge('PR #42: Merged — `d30add0e`, deployed to the running host. Closed #43 with the finding written up.', {
    cwd,
    records: [
      { cwd, message: { content: [{ type: 'tool_use', input: { command: `PR=42 REPO=${REMOTE} codex-review.sh status` } }] } },
      { cwd, message: { content: [{ type: 'tool_use', input: { command: `gh pr close 43 --repo ${REMOTE}` } }] } },
    ],
    routes: OPEN_PR_42,
  });
  assert.equal(verdict?.decision, 'block');
  assert.match(verdict.reason, /example-org\/example-app#42 is open, so it was not merged/);
  assert.match(verdict.reason, /commit d30add0e does not exist in example-org\/example-app/);
  assert.match(verdict.reason, /example-org\/example-app#43 is open and has never been closed, so it was not closed/);
});

test('the same claims written as links are checked without any transcript', () => {
  const { verdict } = judge(`[example-app#42](https://github.com/${REMOTE}/pull/42) merged as \`d30add0e\`.`, {
    routes: OPEN_PR_42,
  });
  assert.equal(verdict?.decision, 'block');
  assert.match(verdict.reason, /#42 is open/);
  assert.match(verdict.reason, /commit d30add0e does not exist/);
});

test('true claims pass: a merged PR with its merge commit, a closed issue', () => {
  const { verdict } = judge(`${REMOTE}#42 merged as squash 9f3c2b1a. ${REMOTE}#50 closed.`, {
    routes: {
      [`repos/${REMOTE}`]: '',
      [`repos/${REMOTE}/issues/42`]: { state: 'closed', pr: true },
      [`repos/${REMOTE}/pulls/42`]: 'true',
      [`repos/${REMOTE}/commits/9f3c2b1a`]: '',
      [`repos/${REMOTE}/issues/50`]: { state: 'closed', pr: false },
    },
  });
  assert.equal(verdict, null);
});

test('unverifiable claims pass with a log line: offline, an untied #N, a SHA with no PR beside it', () => {
  const offline = judge(`${REMOTE}#42 merged.`);
  assert.equal(offline.verdict, null);
  assert.ok(offline.logs.some((l) => l.includes('not readable')));

  const untied = judge('Merged #42.', { cwd: checkout(), routes: OPEN_PR_42 });
  assert.equal(untied.verdict, null);
  assert.ok(untied.logs.some((l) => l.includes('not tied to one repository')));

  const loose = judge('The head is still `d30add0e`; a teammate pushed the fix as `1a2b3c4d`.', { cwd: checkout(), routes: OPEN_PR_42 });
  assert.equal(loose.verdict, null);
  assert.deepEqual(loose.calls, []);
});

test('a 422 that is not "no commit found" proves nothing', () => {
  const { verdict, logs } = judge(`[example-app#42](https://github.com/${REMOTE}/pull/42) merged as \`d30add0e\`.`, {
    routes: {
      ...OPEN_PR_42,
      [`repos/${REMOTE}/pulls/42`]: 'true',
      [`repos/${REMOTE}/issues/42`]: { state: 'closed', pr: true },
      [`repos/${REMOTE}/commits/d30add0e`]: { http: 422, message: 'Validation Failed' },
    },
  });
  assert.equal(verdict, null);
  assert.ok(logs.some((l) => l.includes('d30add0e unverified')));
});

test('a reopened item was closed once, so a closed claim about it passes', () => {
  const { verdict } = judge(`${REMOTE}#43 was closed yesterday and later reopened.`, {
    routes: { ...OPEN_PR_42, [`repos/${REMOTE}/issues/43/events`]: '1' },
  });
  assert.equal(verdict, null);
});

test('a bare #N tied to two repositories in the transcript is not guessed', () => {
  const { verdict, logs } = judge('Merged #42.', {
    cwd: checkout(),
    records: [{ command: `gh pr view 42 --repo ${REMOTE}` }, { command: `gh pr view 42 --repo ${OTHER}` }],
    routes: OPEN_PR_42,
  });
  assert.equal(verdict, null);
  assert.ok(logs.some((l) => l.includes('not tied to one repository')));
});

test('a gh command without a repository ties nothing, since the record may not hold the directory it ran in', () => {
  const cwd = checkout();
  const { verdict, logs } = judge('Merged #42.', {
    cwd,
    records: [{ cwd, message: { content: [{ type: 'tool_use', input: { command: 'cd ../elsewhere && gh pr view 42' } }] } }],
    routes: OPEN_PR_42,
  });
  assert.equal(verdict, null);
  assert.ok(logs.some((l) => l.includes('not tied to one repository')));
});

test('repo#N resolves by name only to a repository the session knows', () => {
  const routes = {
    [`repos/${OTHER}`]: '',
    [`repos/${OTHER}/issues/7`]: { state: 'open', pr: true },
    [`repos/${OTHER}/pulls/7`]: 'false',
  };
  const known = judge('other-app#7 merged.', { records: [{ command: `git clone https://github.com/${OTHER}.git` }], routes });
  assert.equal(known.verdict?.decision, 'block');
  const unknown = judge('other-app#7 merged.', { routes });
  assert.equal(unknown.verdict, null);
});

test('the CLI blocks once, passes on stop_hook_active and on the off switch, and never fails the turn', () => {
  const bin = tempDir('claim-check-bin-');
  // gh stand-in: the repository is readable, the PR is open and unmerged.
  fs.writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/bin/sh',
      'case "$2" in',
      `  repos/${REMOTE}) exit 0 ;;`,
      `  repos/${REMOTE}/issues/42) echo '{"state":"open","pr":true}' ;;`,
      `  repos/${REMOTE}/pulls/42) echo false ;;`,
      "  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;",
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const input = JSON.stringify({ last_assistant_message: `Merged ${REMOTE}#42.` });
  const env = { ...gitEnv(bin), PATH: `${bin}:${process.env.PATH}` };
  const cli = (stdin, extraEnv = {}) => spawnSync('node', [HOOK], { input: stdin, env: { ...env, ...extraEnv }, encoding: 'utf8' });

  const blocked = cli(input);
  assert.equal(blocked.status, 0, blocked.stderr);
  const verdict = JSON.parse(blocked.stdout);
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /#42 is open, so it was not merged/);

  const again = cli(JSON.stringify({ ...JSON.parse(input), stop_hook_active: true }));
  assert.equal(again.status, 0);
  assert.equal(again.stdout, '');

  assert.equal(cli(input, { CLAIM_CHECK: 'off' }).stdout, '');

  const garbage = cli('not json');
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});

test('only stated facts count: negated, conditional and future forms, fenced output and non-commit hashes are not claims', () => {
  for (const text of [
    '#42 is open, not merged yet.',
    'Once #42 is merged, the deploy can go.',
    'I will merge #42 after review.',
    '#42 needs review before it can be merged.',
    'It has not merged #42.',
    `I was unable to verify whether ${REMOTE}#42 was merged.`,
    `${REMOTE}#42 probably merged overnight.`,
    `Was ${REMOTE}#42 merged?`,
  ]) {
    assert.deepEqual(extractClaims(text).prClaims, [], text);
  }
  for (const text of [
    'Output:\n```\nMerged #42 at commit d30add0e\n```',
    'For #42: image digest abc1234def is live.',
    'For #42: container 3f9a2b1c7d restarted after the commit landed.',
    'See run 1234567 for #42.',
    'The commit message for #42 mentions deadbeefcafe.',
    `Does https://github.com/${REMOTE}/commit/d30add0e exist?`,
    `I could not find https://github.com/${REMOTE}/commit/d30add0e anywhere.`,
  ]) {
    assert.deepEqual(extractClaims(claimText(text)).shaClaims, [], text);
  }
  for (const text of ['Reconcile #18 against merged PRs.', 'Asked about #18, which merged PRs cover.']) {
    assert.deepEqual(extractClaims(text).prClaims, [], text);
  }
  assert.deepEqual(extractClaims('Both landed (EXAMPLE #19, groups `fce2f426`).').shaClaims, []);
  assert.deepEqual(extractClaims('Merged PR #42.').prClaims, [{ repo: null, name: null, number: 42, verb: 'merged' }]);
  assert.deepEqual(extractClaims('#42 was merged.').prClaims.map((c) => c.verb), ['merged']);
  assert.deepEqual(extractClaims('Squash commit `c66c722cb` (#81).').shaClaims.map((c) => c.sha), ['c66c722cb']);
  assert.deepEqual(extractClaims('#42: Merged — `d30add0e`.').shaClaims.map((c) => c.sha), ['d30add0e']);
});

test('transcriptRefs ties numbers from URLs, owner/repo#N, gh --repo and REPO=/PR= forms', () => {
  const { numbers, repos } = transcriptRefs(
    [
      `https://github.com/${REMOTE}/pull/1`,
      `${OTHER}#2`,
      `gh pr view 3 --repo ${REMOTE}`,
      `gh -R ${OTHER} pr merge 4`,
      `PR=5 REPO=${REMOTE} codex-review.sh merge`,
      `gh api repos/${OTHER}/pulls/6`,
      `gh pr view --repo ${REMOTE} 7`,
      `gh pr view -R ${OTHER} 8 --json state`,
      `gh pr view 9 --json state --repo ${REMOTE}`,
      `gh pr list --repo ${REMOTE} --limit 50`,
    ].join('\n'),
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [...(numbers.get(n) ?? [])]),
    [[REMOTE], [OTHER], [REMOTE], [OTHER], [REMOTE], [OTHER], [REMOTE], [OTHER], [REMOTE]],
  );
  assert.equal(numbers.has(50), false);
  assert.ok(repos.has(REMOTE) && repos.has(OTHER));
});

test('a gh error is never a contradiction: error bodies, non-zero exits and malformed answers all pass', () => {
  const merged = `Merged ${REMOTE}#42.`;
  const closed = `Closed ${REMOTE}#43.`;
  const rateLimit = { message: 'API rate limit exceeded for user ID 1.', documentation_url: 'https://docs.github.com/rest' };
  for (const [name, message, overrides] of [
    ['issue 403 rate limit with its body on stdout', merged, { [`repos/${REMOTE}/issues/42`]: { http: 403, message: 'API rate limit exceeded', body: rateLimit } }],
    ['issue 401 auth error', merged, { [`repos/${REMOTE}/issues/42`]: { http: 401, message: 'Bad credentials', body: { message: 'Bad credentials' } } }],
    ['issue 502', merged, { [`repos/${REMOTE}/issues/42`]: { http: 502, message: 'Bad Gateway', body: '<html>bad gateway</html>' } }],
    ['issue exit 0 with an error body', merged, { [`repos/${REMOTE}/issues/42`]: rateLimit }],
    ['issue exit 0 with an unparseable body', merged, { [`repos/${REMOTE}/issues/42`]: 'not json' }],
    ['issue exit 0 with the wrong shape', merged, { [`repos/${REMOTE}/issues/42`]: { state: 'open' } }],
    ['issue exit 0 with an unknown state', merged, { [`repos/${REMOTE}/issues/42`]: { state: 'locked', pr: true } }],
    ['pulls 403 rate limit', merged, { [`repos/${REMOTE}/pulls/42`]: { http: 403, message: 'API rate limit exceeded', body: rateLimit } }],
    ['pulls exit 0 with an error body', merged, { [`repos/${REMOTE}/pulls/42`]: JSON.stringify(rateLimit) }],
    ['events 500', closed, { [`repos/${REMOTE}/issues/43/events`]: { http: 500, message: 'Server Error', body: { message: 'Server Error' } } }],
    ['events exit 0 with an error body', closed, { [`repos/${REMOTE}/issues/43/events`]: JSON.stringify(rateLimit) }],
    ['commit 403 rate limit', `${REMOTE}#42 merged as \`d30add0e\`.`, {
      [`repos/${REMOTE}/issues/42`]: { state: 'closed', pr: true },
      [`repos/${REMOTE}/pulls/42`]: 'true',
      [`repos/${REMOTE}/commits/d30add0e`]: { http: 403, message: 'API rate limit exceeded', body: rateLimit },
    }],
    ['commit 403 whose message mentions no commit found', `${REMOTE}#42 merged as \`d30add0e\`.`, {
      [`repos/${REMOTE}/issues/42`]: { state: 'closed', pr: true },
      [`repos/${REMOTE}/pulls/42`]: 'true',
      [`repos/${REMOTE}/commits/d30add0e`]: { http: 403, message: 'No commit found for SHA: d30add0e', body: rateLimit },
    }],
  ]) {
    const { verdict } = judge(message, { routes: { ...OPEN_PR_42, ...overrides } });
    assert.equal(verdict, null, name);
  }
});

test('a negated or reported claim is not a claim', () => {
  for (const text of [
    `I did not merge ${REMOTE}#42 as d30add0e.`,
    `I have neither merged ${REMOTE}#42 nor closed it.`,
    `${REMOTE}#42 was never merged, and ${REMOTE}#43 was never closed.`,
    `My earlier message claimed ${REMOTE}#42 was merged as d30add0e; that was wrong.`,
    `The log says ${REMOTE}#42 merged as d30add0e, which is false.`,
    `> Merged ${REMOTE}#42 as d30add0e.`,
    `The commit message reads "Merged ${REMOTE}#42 as d30add0e".`,
    `The title is \`Merged ${REMOTE}#42 as d30add0e\`.`,
    `If ${REMOTE}#42 is merged as d30add0e, deploy it.`,
    `Once ${REMOTE}#42 lands as squash d30add0e we can deploy.`,
    `${REMOTE}#42 probably merged as d30add0e overnight.`,
    `I will check whether ${REMOTE}#42 merged as d30add0e.`,
  ]) {
    const { prClaims, shaClaims } = extractClaims(claimText(text));
    assert.deepEqual([prClaims, shaClaims], [[], []], text);
    assert.equal(judge(text, { routes: OPEN_PR_42 }).verdict, null, text);
  }
});

test('output in a tilde fence or an indented block is quoted, not claimed', () => {
  for (const text of [
    `~~~\nMerged ${REMOTE}#42 as d30add0e.\n~~~`,
    `~~~text\nMerged ${REMOTE}#42.\n~~~~`,
    `Output:\n\n    Merged ${REMOTE}#42 as d30add0e.\n`,
    `\`\`\`\`\nMerged ${REMOTE}#42.\n\`\`\`\``,
  ]) {
    assert.equal(judge(text, { routes: OPEN_PR_42 }).verdict, null, text);
  }
});

test('a commit that exists in the local checkout is never reported missing, and an unpublished commit is not checked remotely', () => {
  const cwd = checkout();
  const env = gitEnv(cwd);
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'local only'], { cwd, env });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, env, encoding: 'utf8' }).trim();
  const routes = {
    ...OPEN_PR_42,
    [`repos/${REMOTE}/issues/42`]: { state: 'closed', pr: true },
    [`repos/${REMOTE}/pulls/42`]: 'true',
    [`repos/${REMOTE}/commits/${sha}`]: { http: 422, message: `No commit found for SHA: ${sha}` },
    [`repos/${REMOTE}/commits/${sha.slice(0, 9)}`]: { http: 422, message: `No commit found for SHA: ${sha.slice(0, 9)}` },
  };
  const committed = judge(`Committed ${REMOTE}#42 as ${sha}.`, { cwd, routes });
  assert.equal(committed.verdict, null);
  assert.equal(committed.calls.some((c) => c.includes('/commits/')), false);
  for (const text of [`${REMOTE}#42 merged as \`${sha.slice(0, 9)}\`.`, `https://github.com/${REMOTE}/commit/${sha} merged.`]) {
    assert.equal(judge(text, { cwd, routes }).verdict, null, text);
  }
});

test('every gh call gets the time left in one budget, and nothing runs once it is spent', () => {
  let clock = 0;
  const seen = [];
  const routes = {
    'repos/example-org/one': '',
    'repos/example-org/one/issues/42': { state: 'open', pr: true },
    'repos/example-org/one/pulls/42': 'false',
    'repos/example-org/two': '',
    'repos/example-org/two/issues/43': { state: 'open', pr: true },
    'repos/example-org/two/pulls/43': 'false',
  };
  const { gh: inner } = fakeGh(routes);
  const gh = (args, opts = {}) => {
    seen.push({ path: args[1], at: clock, timeout: opts.timeout });
    clock += 6_000;
    return inner(args);
  };
  decide({ last_assistant_message: 'Merged example-org/one#42. Merged example-org/two#43.' }, { gh, now: () => clock });
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.ok(Number.isFinite(call.timeout) && call.timeout > 0, `${call.path} got timeout ${call.timeout}`);
    assert.ok(call.at + call.timeout <= 20_000, `${call.path} at ${call.at} may run past the budget (${call.timeout})`);
  }
});
