import path from 'node:path';

import { languageOf, needsContentForLanguage } from './scan.mjs';

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Move to): (.+?)\s*$/gm;
const MAX_LINES_SHOWN = 8;

export function editedFiles(toolInput, cwd) {
  const files = new Set();
  if (!toolInput || typeof toolInput !== 'object') return [];
  for (const key of ['file_path', 'filePath', 'path']) {
    if (typeof toolInput[key] === 'string' && toolInput[key]) files.add(path.resolve(cwd, toolInput[key]));
  }
  for (const value of Object.values(toolInput)) {
    if (typeof value !== 'string' || !value.includes('*** Begin Patch')) continue;
    for (const [, file] of value.matchAll(PATCH_PATH)) files.add(path.resolve(cwd, file));
  }
  return [...files].filter((file) => languageOf(file) !== null || needsContentForLanguage(file));
}

const GUIDANCE =
  'A change must not add comment lines on net across the files it touches. A constraint belongs in a test, type, ' +
  'assert or lint rule; a comment is only for what code cannot check (an external system\'s quirk, why the ' +
  'obvious approach was wrong). Cut the rest, or delete as many narrating or restating comment lines elsewhere ' +
  'in the change. Never cite file:line or a PR/issue/ticket number in a comment.';

// Raise each line once per session, or a deliberately kept comment is repeated on every later edit.
export function feedbackMessage(results, reported) {
  const parts = [];
  for (const result of results) {
    if (!result || result.error) continue;
    const key = result.key ?? result.path;
    const seen = reported.get(key) ?? new Set();
    const findings = result.findings.filter((finding) => !seen.has(`${finding.rule}\0${finding.text}`));
    const growth = result.net > 0 ? result.new_comment_lines.filter(({ text }) => !seen.has(text)) : [];
    if (findings.length === 0 && growth.length === 0) continue;
    const lines = [];
    if (growth.length) {
      lines.push(`${result.path}: ${result.head} comment lines, ${result.net} more than HEAD. New:`);
      for (const { line, text } of growth.slice(0, MAX_LINES_SHOWN)) lines.push(`  ${line}: ${text.slice(0, 120)}`);
      if (growth.length > MAX_LINES_SHOWN) lines.push(`  … and ${growth.length - MAX_LINES_SHOWN} more`);
    }
    for (const finding of findings) {
      lines.push(`${result.path}:${finding.line} ${finding.rule.replace(/-/g, ' ')}: ${finding.text.slice(0, 120)}`);
    }
    parts.push(lines.join('\n'));
    for (const { text } of growth) seen.add(text);
    for (const finding of findings) seen.add(`${finding.rule}\0${finding.text}`);
    reported.set(key, seen);
  }
  return parts.length ? `comment-rule feedback (not a block):\n${parts.join('\n')}\n${GUIDANCE}` : null;
}
