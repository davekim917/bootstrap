import path from 'node:path';

import { languageOf, needsContentForLanguage } from './scan.mjs';

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Move to): (.+?)\s*$/gm;

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
  'History belongs in git, not in a comment. Keep a comment only when a reader would get something wrong ' +
  "without it: an external system's quirk, why the obvious approach is wrong.";

// Raise each finding once per session, or a line the author already saw is repeated on every later edit.
export function feedbackMessage(results, reported) {
  const parts = [];
  for (const result of results) {
    if (!result || result.error) continue;
    const key = result.key ?? result.path;
    const seen = reported.get(key) ?? new Set();
    for (const finding of result.findings) {
      const id = `${finding.rule}\0${finding.text}`;
      if (seen.has(id)) continue;
      seen.add(id);
      parts.push(`${result.path}:${finding.line} ${finding.rule.replace(/-/g, ' ')}: ${finding.text.slice(0, 120)}`);
    }
    reported.set(key, seen);
  }
  return parts.length ? `comment-rule: prohibited comment form, remove it:\n${parts.join('\n')}\n${GUIDANCE}` : null;
}
