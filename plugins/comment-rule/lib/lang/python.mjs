import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python_ranges.py');
const TIMEOUT_MS = Number(process.env.COMMENT_RULE_PYTHON_TIMEOUT_MS) || 60_000;

/** Python reads CRLF and a lone CR as LF; `map[k]` is the original UTF-16 offset of normalised code point k. */
function normalise(text) {
  let normalised = '';
  const map = [];
  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i);
    const width = codePoint > 0xffff ? 2 : 1;
    if (text[i] === '\r') {
      map.push(i);
      normalised += '\n';
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    map.push(i);
    normalised += String.fromCodePoint(codePoint);
    i += width;
  }
  map.push(text.length);
  return { normalised, map };
}

// Stdin is a file, not `input`: spawnSync ends `input` with shutdown(2), which Codex's sandbox denies, so the helper never saw EOF.
function openInput(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-rule-'));
  try {
    const file = path.join(dir, 'input.json');
    fs.writeFileSync(file, payload);
    return fs.openSync(file, 'r');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One interpreter for every Python file in a run; `null` ranges mean the file could not be read. */
export function pythonCommentRanges(texts) {
  if (texts.length === 0) return [];
  const prepared = texts.map((text, id) => ({ id, ...normalise(text) }));
  const failed = (reason) => texts.map(() => ({ ranges: null, error: `python3 unavailable: ${reason}` }));
  let stdin;
  let run;
  try {
    stdin = openInput(JSON.stringify(prepared.map(({ id, normalised }) => ({ id, text: normalised }))));
    run = spawnSync(process.env.COMMENT_RULE_PYTHON || 'python3', [HELPER], {
      stdio: [stdin, 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    return failed(error.message);
  } finally {
    if (stdin !== undefined) fs.closeSync(stdin);
  }
  if (run.error?.code === 'ETIMEDOUT') return failed(`no result within ${TIMEOUT_MS} ms`);
  if (run.error || run.status !== 0) return failed(run.error ? run.error.message : run.stderr.trim().split('\n').pop());
  const results = JSON.parse(run.stdout);
  return results.map(({ id, ranges, error }) => {
    const { map } = prepared[id];
    return {
      ranges: ranges && ranges.map(([start, end]) => [map[start], map[end]]),
      error,
    };
  });
}
