import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, parseConfig } from './config.mjs';
import { prohibitedForms } from './forms.mjs';
import { languageOf, scanMany } from './scan.mjs';

const MAX_LISTED_LINES = 50;

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tryGit(repo, args) {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

function show(repo, ref, file) {
  return tryGit(repo, ['show', `${ref}:${file}`]);
}

function readWorkingFile(repo, file) {
  const absolute = path.join(repo, file);
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) return null;
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

export function defaultBaseRef(repo) {
  const originHead = tryGit(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])?.trim();
  if (originHead) return originHead.replace(/^refs\/remotes\//, '');
  for (const candidate of ['origin/main', 'origin/master', 'origin/develop']) {
    if (tryGit(repo, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])) return candidate;
  }
  throw new Error('no base given and origin has no HEAD, main, master or develop branch; pass --base <ref>');
}

function ownOwner(repo) {
  const url = tryGit(repo, ['remote', 'get-url', 'origin'])?.trim() ?? '';
  return url.match(/github\.com[:/]([^/\s]+)\//i)?.[1] ?? null;
}

function newCommentLines(baseLines, headLines) {
  const remaining = new Map();
  for (const text of baseLines.values()) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  const added = [];
  for (const [line, text] of [...headLines.entries()].sort((a, b) => a[0] - b[0])) {
    const left = remaining.get(text) ?? 0;
    if (left > 0) remaining.set(text, left - 1);
    else added.push({ line: line + 1, text });
  }
  return added;
}

function compareFile(entry, baseScan, headScan, context) {
  const baseLines = baseScan?.lines ?? new Map();
  const headLines = headScan?.lines ?? new Map();
  const added = newCommentLines(baseLines, headLines);
  const findings = [];
  for (const { line, text } of added) {
    for (const rule of prohibitedForms(text, context)) findings.push({ line, rule, text: text.slice(0, 200) });
  }
  return {
    path: entry.newPath ?? entry.oldPath,
    ...(entry.oldPath && entry.newPath && entry.oldPath !== entry.newPath ? { old_path: entry.oldPath } : {}),
    language: entry.language,
    base: baseLines.size,
    head: headLines.size,
    net: headLines.size - baseLines.size,
    new_comment_lines: added.slice(0, MAX_LISTED_LINES).map(({ line, text }) => ({ line, text: text.slice(0, 200) })),
    ...(added.length > MAX_LISTED_LINES ? { new_comment_lines_total: added.length } : {}),
    findings,
  };
}

function evaluate(repo, entries, context) {
  const items = [];
  for (const entry of entries) {
    for (const side of ['base', 'head']) {
      const text = entry[`${side}Text`];
      if (text === null) continue;
      const file = side === 'base' ? entry.oldPath : entry.newPath;
      entry[`${side}Index`] = items.length;
      items.push({
        file,
        text,
        language: entry.language,
        resolveFrom: [path.dirname(path.join(repo, file)), repo],
        sqlDialect: context.sqlDialect ?? 'ansi',
      });
    }
  }
  const scans = scanMany(items);
  const files = [];
  const errors = [];
  for (const entry of entries) {
    const baseScan = entry.baseIndex === undefined ? null : scans[entry.baseIndex];
    const headScan = entry.headIndex === undefined ? null : scans[entry.headIndex];
    const failed = [baseScan, headScan].find((scan) => scan?.error);
    if (failed) {
      errors.push({ path: entry.newPath ?? entry.oldPath, error: failed.error });
      continue;
    }
    const record = compareFile(entry, baseScan, headScan, context);
    if (record.base || record.head) files.push(record);
  }
  return { files, errors };
}

function summarise(files, errors, extra) {
  const before = files.reduce((sum, file) => sum + file.base, 0);
  const after = files.reduce((sum, file) => sum + file.head, 0);
  const findings = files.reduce((sum, file) => sum + file.findings.length, 0);
  const net = after - before;
  const status = errors.length ? 'error' : net > 0 || findings > 0 ? 'fail' : 'pass';
  return { status, ...extra, before, after, net, findings, files, errors };
}

function parseNameStatus(output) {
  const fields = output.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++];
    const oldPath = fields[i++];
    const newPath = /^[RC]/.test(status) ? fields[i++] : oldPath;
    entries.push({ status: status[0], oldPath, newPath });
  }
  return entries;
}

// The config is read at the merge base so that a change cannot exempt itself.
export function checkChange({ repo, base, head }) {
  const baseRef = base ?? defaultBaseRef(repo);
  const mergeBase = git(repo, ['merge-base', baseRef, head ?? 'HEAD']).trim();
  const config = parseConfig(show(repo, mergeBase, CONFIG_FILE));
  const context = { ownOwner: ownOwner(repo), ticketPrefixes: config.ticketPrefixes, sqlDialect: config.sqlDialect };
  const diff = git(repo, ['diff', '--name-status', '-z', '-M', '--no-color', '--no-ext-diff', mergeBase, ...(head ? [head] : []), '--']);
  const entries = [];
  for (const { status, oldPath, newPath } of parseNameStatus(diff)) {
    const counted = (file) => !config.isExcluded(file) && !(config.isFrozen(file) && show(repo, mergeBase, file) !== null);
    let baseText = status === 'A' || status === 'C' || !counted(oldPath) ? null : show(repo, mergeBase, oldPath);
    let headText =
      status === 'D' || !counted(newPath) ? null : head ? show(repo, head, newPath) : readWorkingFile(repo, newPath);
    const language = languageOf(newPath, headText ?? baseText) ?? languageOf(oldPath, baseText ?? headText);
    if (!language) continue;
    if (baseText !== null && languageOf(oldPath, baseText) !== language) baseText = null;
    if (headText !== null && languageOf(newPath, headText) !== language) headText = null;
    entries.push({ oldPath: status === 'A' ? null : oldPath, newPath: status === 'D' ? null : newPath, language, baseText, headText });
  }
  const { files, errors } = evaluate(repo, entries, context);
  files.sort((a, b) => b.net - a.net || a.path.localeCompare(b.path));
  return summarise(files, errors, { base: baseRef, merge_base: mergeBase, head: head ?? 'WORKTREE' });
}

export function checkFileAgainstHead(absoluteFile) {
  const dir = path.dirname(absoluteFile);
  const prefix = tryGit(dir, ['rev-parse', '--show-prefix']);
  const repo = tryGit(dir, ['rev-parse', '--show-toplevel'])?.trim();
  if (prefix === null || !repo) return null;
  const file = `${prefix.trim()}${path.basename(absoluteFile)}`;
  let config;
  try {
    config = parseConfig(readWorkingFile(repo, CONFIG_FILE));
  } catch {
    config = parseConfig(null);
  }
  if (config.isExcluded(file)) return null;
  const headText = readWorkingFile(dir, path.basename(absoluteFile));
  if (headText === null) return null;
  const language = languageOf(file, headText);
  if (!language) return null;
  let baseText = tryGit(dir, ['show', `HEAD:./${path.basename(absoluteFile)}`]);
  if (baseText !== null && config.isFrozen(file)) return null;
  if (baseText !== null && languageOf(file, baseText) !== language) baseText = null;
  const context = { ownOwner: ownOwner(repo), ticketPrefixes: config.ticketPrefixes, sqlDialect: config.sqlDialect };
  const entry = { oldPath: baseText === null ? null : file, newPath: file, language, baseText, headText };
  const { files, errors } = evaluate(repo, [entry], context);
  if (errors.length) return { error: errors[0].error, path: file, key: absoluteFile };
  return { ...(files[0] ?? { path: file, language, base: 0, head: 0, net: 0, new_comment_lines: [], findings: [] }), key: absoluteFile };
}

export function countTree(repo) {
  const config = parseConfig(readWorkingFile(repo, CONFIG_FILE));
  const listed = git(repo, ['ls-files', '-z']).split('\0').filter(Boolean);
  const entries = [];
  for (const file of listed) {
    if (config.isExcluded(file)) continue;
    const text = readWorkingFile(repo, file);
    const language = text === null ? null : languageOf(file, text);
    if (language) entries.push({ oldPath: null, newPath: file, language, baseText: null, headText: text });
  }
  const { files, errors } = evaluate(repo, entries, { ownOwner: null, ticketPrefixes: [], sqlDialect: config.sqlDialect });
  const totals = {};
  for (const file of files) {
    for (const key of [file.language, 'total']) {
      totals[key] ??= { files_with_comments: 0, comment_lines: 0 };
      totals[key].files_with_comments++;
      totals[key].comment_lines += file.head;
    }
  }
  return { totals, errors };
}
