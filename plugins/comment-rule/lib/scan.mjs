import path from 'node:path';

import { commentLinesFromRanges } from './lines.mjs';
import { pythonCommentRanges } from './lang/python.mjs';
import { shellCommentRanges } from './lang/shell.mjs';
import { sqlCommentRanges } from './lang/sql.mjs';
import { loadTypeScript, typescriptCommentRanges } from './lang/typescript.mjs';

const BY_EXTENSION = [
  [/\.(?:[cm]?[jt]sx?)$/i, 'typescript'],
  [/\.pyi?$/i, 'python'],
  [/\.sql$/i, 'sql'],
  [/\.(?:sh|bash)$/i, 'shell'],
];
const SHELL_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:ba|da|k)?sh\b/;
const PYTHON_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?python[\d.]*\b/;

export function languageOf(file, text) {
  for (const [pattern, language] of BY_EXTENSION) if (pattern.test(file)) return language;
  if (path.posix.extname(file) !== '' || typeof text !== 'string') return null;
  if (SHELL_SHEBANG.test(text)) return 'shell';
  if (PYTHON_SHEBANG.test(text)) return 'python';
  return null;
}

export function needsContentForLanguage(file) {
  return !BY_EXTENSION.some(([pattern]) => pattern.test(file)) && path.posix.extname(file) === '';
}

export function scanMany(items) {
  const results = items.map(() => null);
  const pythonItems = [];
  items.forEach((item, index) => {
    try {
      switch (item.language) {
        case 'typescript': {
          const ts = loadTypeScript(item.resolveFrom);
          if (!ts) {
            results[index] = {
              error: 'typescript (5.x or 6.x) not found: install it in the repository, or run `npm ci` in the comment-rule plugin',
            };
            return;
          }
          results[index] = { lines: commentLinesFromRanges(item.text, typescriptCommentRanges(ts, item.file, item.text)) };
          return;
        }
        case 'sql':
          results[index] = { lines: commentLinesFromRanges(item.text, sqlCommentRanges(item.text, item.sqlDialect)) };
          return;
        case 'shell':
          results[index] = { lines: commentLinesFromRanges(item.text, shellCommentRanges(item.text)) };
          return;
        case 'python':
          pythonItems.push(index);
          return;
        default:
          results[index] = { lines: new Map() };
      }
    } catch (error) {
      results[index] = { error: `parse failed: ${error.message}` };
    }
  });
  const python = pythonCommentRanges(pythonItems.map((index) => items[index].text));
  pythonItems.forEach((index, k) => {
    const { ranges, error } = python[k];
    results[index] = ranges
      ? { lines: commentLinesFromRanges(items[index].text, ranges) }
      : { error };
  });
  return results;
}
