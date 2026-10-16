#!/usr/bin/env node
/**
 * Stop hook: checks the commit SHAs and "merged/closed #N" claims in the agent's final message against GitHub, and
 * sends the turn back once when a claim is proven false. A claim is checked only when it names its repository: a
 * GitHub URL, `owner/repo#N`, `repo#N` matching one repository the session knows, or a bare `#N` that the session's
 * own commands tied to exactly one repository. A SHA is checked in the repository of a PR the same sentence names.
 * Anything it cannot prove (no gh auth, an unreadable repository, offline, an ambiguous reference) passes, with one
 * line on stderr.
 *
 * Off switch: CLAIM_CHECK=off in the environment.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CLAIMS = 12;
const BUDGET_MS = 20_000;
const CALL_TIMEOUT_MS = 8_000;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

const SHA_KEYWORD = /\b(?:commit(?:ted|s)?|merged?|squash(?:ed)?|sha|pushed|landed|revert(?:ed)?|cherry-pick(?:ed)?|head|rebased?|tagged)\b/i;
const NOT_A_COMMIT = /\b(?:image|docker|container|digest|sha-?256|checksum|md5|etag|blob|uuid|token|pid)\b/i;
const NEGATION = /\b(?:not|never|no|unmerged|will|would|should|could|can|to be|once|after|before|until|if|when|pending|awaiting|ready to|about to|going to|unable|whether|unsure|unclear|unknown|uncertain|verify|confirm|check|maybe|might|may|possibly|probably|likely|seems?|appears?|supposedly|reportedly)\b|n't\b/i;
const REF = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)|(?:\b([\w.-]+\/[\w.-]+)|\b([\w.-]+))?#(\d+)\b/g;

/** Message text with fenced code blocks removed: pasted output is quoted, not claimed. */
export function claimText(message) {
  return message.replace(/```[\s\S]*?(?:```|$)/g, '\n');
}

function sentences(text) {
  const normalized = text.replace(/\[([^\]]*)\]\((https:\/\/github\.com\/[^)\s]+)\)/g, (_, label, url) =>
    /\/(?:pull|issues|commit)\/\w+/.test(url) ? url : label,
  );
  return normalized.split(/(?<=[.!?;])\s+|\n+/);
}

function isShaToken(token) {
  return /^[0-9a-f]{7,40}$/.test(token) && /[a-f]/.test(token) && /[0-9]/.test(token);
}

// Between a PR reference and the SHA it names, only connective words: "#42: merged — `abc1234`", "#42 merged as
// squash abc1234", "`abc1234` (#42)". A SHA elsewhere in the sentence may belong to another repository.
const REF_TO_SHA = /^[\s`*)\]]*[:,—–-]?\s*(?:(?:is|was|has been|got|now)\s+)?(?:(?:merged|squashed|landed|pushed|committed|reverted|rebased)\s+)?(?:(?:as|at|in|to|into|=|—|–|-|:)\s*)?(?:(?:the\s+)?(?:merge\s+commit|squash(?:\s+commit)?|commit|sha|head)\s*)?[`*(]*$/i;
const SHA_TO_REF = /^[`*\s]*[(\[]?\s*$/;

function adjacentRef(sentence, refMatches, shaStart, shaEnd) {
  for (const { ref, start, end } of refMatches) {
    if (end <= shaStart && REF_TO_SHA.test(sentence.slice(end, shaStart))) return ref;
    if (start >= shaEnd && SHA_TO_REF.test(sentence.slice(shaEnd, start))) return ref;
  }
  return null;
}

/**
 * Claims the message states as facts. A ref is { repo: 'owner/repo' | null, name: 'repo' | null, number }; a SHA
 * claim carries the one ref it sits beside, since a SHA is checked only in that PR's repository.
 */
export function extractClaims(text) {
  const prClaims = [];
  const shaClaims = [];
  const seenPr = new Set();
  const seenSha = new Set();
  for (const sentence of sentences(text)) {
    const refMatches = [];
    for (const m of sentence.matchAll(REF)) {
      const ref = {
        repo: m[1] ? `${m[1]}/${m[2]}` : m[4] ?? null,
        name: m[1] || m[4] ? null : m[5] ?? null,
        number: Number(m[3] ?? m[6]),
      };
      refMatches.push({ ref, start: m.index, end: m.index + m[0].length });
      const start = m.index;
      const end = start + m[0].length;
      const lead = sentence.slice(Math.max(0, start - 30), start);
      const after = sentence.slice(end, end + 40);
      let verb = null;
      const afterMatch = /^\s*[)\]]?\s*[:,—–-]?\s*(?:(?:is|was|were|are|has been|have been|got)\s+)?(?:(?:now|also|just|already|both)\s+)?(merged|closed)\b/i.exec(after);
      if (afterMatch && !NEGATION.test(after.slice(0, afterMatch.index + afterMatch[0].length)) && !NEGATION.test(lead)) {
        verb = afterMatch[1].toLowerCase();
      }
      if (!verb) {
        const beforeMatch = /\b(merged|closed)\s+(?:PR\s+|pull request\s+|issue\s+)?$/i.exec(lead);
        if (beforeMatch && !NEGATION.test(lead)) verb = beforeMatch[1].toLowerCase();
      }
      if (!verb) continue;
      const key = `${ref.repo ?? ref.name ?? ''}#${ref.number}:${verb}`;
      if (seenPr.has(key)) continue;
      seenPr.add(key);
      prClaims.push({ ...ref, verb });
    }
    const urlShas = new Set();
    for (const m of sentence.matchAll(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})\b/g)) {
      urlShas.add(m[3]);
      if (seenSha.has(m[3])) continue;
      seenSha.add(m[3]);
      shaClaims.push({ sha: m[3], repo: `${m[1]}/${m[2]}`, refs: [] });
    }
    for (const m of sentence.matchAll(/(?<![\w-])([0-9a-f]{7,40})(?![\w-])/g)) {
      const sha = m[1];
      if (!isShaToken(sha) || seenSha.has(sha) || urlShas.has(sha)) continue;
      const before = sentence.slice(Math.max(0, m.index - 48), m.index);
      if (!SHA_KEYWORD.test(before) || NOT_A_COMMIT.test(before)) continue;
      const ref = adjacentRef(sentence, refMatches, m.index, m.index + sha.length);
      if (!ref) continue;
      seenSha.add(sha);
      shaClaims.push({ sha, repo: null, refs: [ref] });
    }
  }
  return { prClaims, shaClaims };
}

function readTail(file) {
  if (!file) return '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * What the session's own records tie to a repository: PR/issue numbers seen with exactly that repository (URLs,
 * `owner/repo#N`, `gh pr … N --repo owner/repo`, `REPO=owner/repo PR=N`), and every GitHub repository named at all.
 * A gh command without a repository is not counted: the directory it ran in is not reliably in the record.
 */
export function transcriptRefs(text) {
  const numbers = new Map();
  const repos = new Set();
  const tie = (repo, number) => {
    repos.add(repo);
    if (!numbers.has(number)) numbers.set(number, new Set());
    numbers.get(number).add(repo);
  };
  for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(?:pull|issues)\/(\d+)/g)) tie(`${m[1]}/${m[2]}`, Number(m[3]));
  for (const m of text.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)) tie(m[1], Number(m[2]));
  for (const m of text.matchAll(/repos\/([\w.-]+\/[\w.-]+)\/(?:pulls|issues)\/(\d+)\b/g)) tie(m[1], Number(m[2]));
  for (const m of text.matchAll(/\bgh\s+((?:(?:-R|--repo)[ =][\w.-]+\/[\w.-]+\s+)?(?:pr|issue)\s+(?:view|merge|close|comment|checks|edit|reopen|ready|diff|review|checkout)\b[^\n"|;&]{0,160})/g)) {
    const segment = m[1];
    const repo = /(?:^|\s)(?:-R|--repo)[ =]([\w.-]+\/[\w.-]+)/.exec(segment)?.[1];
    const number = /(?:pr|issue)\s+[a-z]+\b(?:\s+(?:-R|--repo)[ =]\S+)*\s+(\d+)\b/.exec(segment)?.[1]
      ?? /\s(\d+)(?=\s|$)/.exec(segment.replace(/(?:-R|--repo)[ =]\S+/g, ''))?.[1];
    if (repo && number) tie(repo, Number(number));
  }
  for (const m of text.matchAll(/\bREPO=([\w.-]+\/[\w.-]+)[^\n"]{0,40}?\bPR=(\d+)|\bPR=(\d+)[^\n"]{0,40}?\bREPO=([\w.-]+\/[\w.-]+)/g)) {
    tie(m[1] ?? m[4], Number(m[2] ?? m[3]));
  }
  for (const m of text.matchAll(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/"\s)#?]|$)/g)) repos.add(`${m[1]}/${m[2]}`);
  return { numbers, repos };
}

/** The last assistant message's text from a Claude transcript, for runtimes that omit last_assistant_message. */
export function lastAssistantText(transcript) {
  const lines = transcript.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (record?.type !== 'assistant') continue;
    const content = record.message?.content;
    const text = Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '';
    if (text) return text;
  }
  return '';
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: CALL_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function githubRepoOf(remoteUrl) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The GitHub repository of the checkout holding `cwd`, or null. */
export function cwdRepo(cwd, git = run) {
  if (!cwd) return null;
  const url = git('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
  return url.status === 0 ? githubRepoOf(url.stdout) : null;
}

/**
 * Resolves each claim's repository from what the session knows, then checks it. Returns the claims proven false.
 * `gh(args)` returns {status, stdout, stderr}; status null means the call could not run.
 */
export function verifyClaims({ prClaims, shaClaims, known, gh, log = () => {}, deadline = Infinity }) {
  const falseClaims = [];
  const accessible = new Map();
  const readable = (repo) => {
    if (!accessible.has(repo)) accessible.set(repo, gh(['api', `repos/${repo}`, '--silent']).status === 0);
    return accessible.get(repo);
  };
  // Not found is a 404, or for the commit endpoint a 422 whose message says so; any other 422 (validation, abuse
  // protection) proves nothing.
  const missing = (result) => result.status !== 0 && /HTTP 404/.test(result.stderr);
  const missingCommit = (result) => missing(result) || (result.status !== 0 && /No commit found for SHA/i.test(result.stderr));
  const resolve = (ref) => {
    if (ref.repo) return ref.repo;
    if (ref.name) {
      const matches = [...known.repos].filter((r) => r.split('/')[1].toLowerCase() === ref.name.toLowerCase());
      return matches.length === 1 ? matches[0] : null;
    }
    const tied = known.numbers.get(ref.number);
    return tied?.size === 1 ? [...tied][0] : null;
  };
  const label = (ref) => `${ref.repo ?? ref.name ?? ''}#${ref.number}`;

  for (const claim of prClaims) {
    if (Date.now() > deadline) {
      log(`claim-check: time budget spent; ${label(claim)} not checked`);
      continue;
    }
    const repo = resolve(claim);
    if (!repo) {
      log(`claim-check: ${label(claim)} is not tied to one repository; unverified`);
      continue;
    }
    if (!readable(repo)) {
      log(`claim-check: ${repo} not readable; #${claim.number} unverified`);
      continue;
    }
    const issue = gh(['api', `repos/${repo}/issues/${claim.number}`, '--jq', '{state: .state, pr: (.pull_request != null)}']);
    if (missing(issue)) {
      falseClaims.push(`${repo}#${claim.number} does not exist, so it was not ${claim.verb}`);
      continue;
    }
    let state;
    try {
      state = JSON.parse(issue.stdout);
    } catch {
      log(`claim-check: ${repo}#${claim.number} unverified`);
      continue;
    }
    if (claim.verb === 'closed') {
      if (state.state === 'open') falseClaims.push(`${repo}#${claim.number} is still open, so it was not closed`);
      continue;
    }
    if (!state.pr) {
      falseClaims.push(`${repo}#${claim.number} is an issue, not a pull request, so it was not merged`);
      continue;
    }
    const pull = gh(['api', `repos/${repo}/pulls/${claim.number}`, '--jq', '.merged']);
    if (pull.status !== 0) {
      log(`claim-check: ${repo}#${claim.number} merge state unverified`);
      continue;
    }
    if (pull.stdout.trim() === 'false') {
      falseClaims.push(`${repo}#${claim.number} is ${state.state === 'open' ? 'open' : 'closed without merging'}, so it was not merged`);
    }
  }

  for (const claim of shaClaims) {
    if (Date.now() > deadline) {
      log(`claim-check: time budget spent; ${claim.sha} not checked`);
      continue;
    }
    const candidates = claim.repo ? [claim.repo] : [...new Set(claim.refs.map(resolve))];
    if (candidates.length !== 1 || !candidates[0]) {
      log(`claim-check: ${claim.sha} is not tied to one repository; unverified`);
      continue;
    }
    const repo = candidates[0];
    if (!readable(repo)) {
      log(`claim-check: ${repo} not readable; ${claim.sha} unverified`);
      continue;
    }
    const result = gh(['api', `repos/${repo}/commits/${claim.sha}`, '--silent']);
    if (missingCommit(result)) falseClaims.push(`commit ${claim.sha} does not exist in ${repo}`);
    else if (result.status !== 0) log(`claim-check: ${repo}@${claim.sha} unverified`);
  }
  return falseClaims;
}

export function decide(input, { gh, git = run, log = () => {}, now = Date.now } = {}) {
  if (process.env.CLAIM_CHECK === 'off') return null;
  if (input?.stop_hook_active) return null;
  const transcript = readTail(input?.transcript_path);
  const message = typeof input?.last_assistant_message === 'string' && input.last_assistant_message
    ? input.last_assistant_message
    : lastAssistantText(transcript);
  if (!message) return null;
  const { prClaims, shaClaims } = extractClaims(claimText(message));
  const total = prClaims.length + shaClaims.length;
  if (total === 0) return null;
  if (total > MAX_CLAIMS) log(`claim-check: ${total} claims; checking the first ${MAX_CLAIMS}`);
  const keptPr = prClaims.slice(0, MAX_CLAIMS);
  const keptSha = shaClaims.slice(0, Math.max(0, MAX_CLAIMS - keptPr.length));

  const known = transcriptRefs(transcript);
  for (const repo of transcriptRefs(message).repos) known.repos.add(repo);
  const home = cwdRepo(input?.cwd, git);
  if (home) known.repos.add(home);

  const falseClaims = verifyClaims({ prClaims: keptPr, shaClaims: keptSha, known, gh, log, deadline: now() + BUDGET_MS });
  if (falseClaims.length === 0) return null;
  return {
    decision: 'block',
    reason:
      `Your last message states things GitHub contradicts:\n${falseClaims.map((c) => `- ${c}`).join('\n')}\n` +
      'Correct the message: report only what a command you ran printed, and include that output. ' +
      'If you did not run the action, say so. This check runs once per turn.',
  };
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const verdict = decide(input, {
    gh: (args) => run('gh', args),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  if (verdict) process.stdout.write(`${JSON.stringify(verdict)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`claim-check: ${error instanceof Error ? error.message : String(error)}; passing\n`);
  }
  process.exit(0);
}
