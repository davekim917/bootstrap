import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let cached;

function usable(candidate) {
  return candidate && typeof candidate.createSourceFile === 'function' ? candidate : null;
}

function globalDirs() {
  return [
    ...(process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules'),
    path.join(os.homedir(), '.npm-global/lib/node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ];
}

// TypeScript 7 has no JavaScript compiler API; `usable` skips it.
export function loadTypeScript(searchFrom = []) {
  if (cached !== undefined) return cached;
  const require = createRequire(import.meta.url);
  const nearby = searchFrom === null ? [] : [...searchFrom, PLUGIN_ROOT];
  for (const dir of nearby) {
    try {
      const found = usable(require(require.resolve('typescript', { paths: [dir] })));
      if (found) return (cached = found);
    } catch {}
  }
  const installed = searchFrom === null ? [path.join(PLUGIN_ROOT, 'node_modules'), ...globalDirs()] : globalDirs();
  for (const dir of installed) {
    try {
      const found = usable(require(path.join(dir, 'typescript')));
      if (found) return (cached = found);
    } catch {}
  }
  return (cached = null);
}

function scriptKind(ts, file) {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// A trivia scan next to JSX text reads `<p>// x</p>` as a comment, so ranges inside a token are dropped.
export function typescriptCommentRanges(ts, file, text) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
  const ranges = new Map();
  const tokens = [];
  const mark = (found) => {
    for (const range of found ?? []) ranges.set(range.pos, [range.pos, range.end]);
  };
  const isJsxText = (node) => node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces;
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.EndOfFileToken) {
      mark(ts.getLeadingCommentRanges(text, node.getFullStart()));
      return;
    }
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (isJsxText(node)) {
      tokens.push([node.pos, node.end]);
      return;
    }
    const template = node.kind >= ts.SyntaxKind.FirstTemplateToken && node.kind <= ts.SyntaxKind.LastTemplateToken;
    const children = template || ts.isLiteralExpression(node) ? [] : node.getChildren(sourceFile);
    if (children.length === 0) {
      mark(ts.getLeadingCommentRanges(text, node.getFullStart()));
      mark(ts.getTrailingCommentRanges(text, node.getEnd()));
      const start = node.getStart(sourceFile);
      if (node.getEnd() > start) tokens.push([start, node.getEnd()]);
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sourceFile);
  tokens.sort((a, b) => a[0] - b[0]);
  const insideToken = (offset) => {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [start, end] = tokens[mid];
      if (offset < start) hi = mid - 1;
      else if (offset >= end) lo = mid + 1;
      else return true;
    }
    return false;
  };
  return [...ranges.values()].filter(([start]) => !insideToken(start)).sort((a, b) => a[0] - b[0]);
}
