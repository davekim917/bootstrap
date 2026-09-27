import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python_ranges.py');

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

/** One interpreter for every Python file in a run; `null` ranges mean the file could not be read. */
export function pythonCommentRanges(texts) {
  if (texts.length === 0) return [];
  const prepared = texts.map((text, id) => ({ id, ...normalise(text) }));
  const run = spawnSync(process.env.COMMENT_RULE_PYTHON || 'python3', [HELPER], {
    input: JSON.stringify(prepared.map(({ id, normalised }) => ({ id, text: normalised }))),
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (run.error || run.status !== 0) {
    const reason = run.error ? run.error.message : run.stderr.trim().split('\n').pop();
    return texts.map(() => ({ ranges: null, error: `python3 unavailable: ${reason}` }));
  }
  const results = JSON.parse(run.stdout);
  return results.map(({ id, ranges, error }) => {
    const { map } = prepared[id];
    return {
      ranges: ranges && ranges.map(([start, end]) => [map[start], map[end]]),
      error,
    };
  });
}
