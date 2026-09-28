const TERMINATOR = /\r\n|[\n\r\u2028\u2029]/g;

export function lineStarts(text) {
  const starts = [0];
  for (const match of text.matchAll(TERMINATOR)) starts.push(match.index + match[0].length);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Split on every terminator any supported language honours, or CR-only files hide their comment lines.
export function commentLinesFromRanges(text, ranges) {
  const starts = lineStarts(text);
  const lines = new Map();
  for (const [start, end] of ranges) {
    if (end <= start) continue;
    const first = lineOf(starts, start);
    const last = lineOf(starts, end - 1);
    for (let line = first; line <= last; line++) {
      const from = Math.max(start, starts[line]);
      const to = Math.min(end, line + 1 < starts.length ? starts[line + 1] : text.length);
      const segment = text.slice(from, to).replace(/[\n\r\u2028\u2029]+$/, '').trim();
      const previous = lines.get(line);
      lines.set(line, previous ? `${previous} ${segment}`.trim() : segment);
    }
  }
  return lines;
}

export function commentOnlyLfLines(text, ranges) {
  let masked = '';
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    masked += text.slice(at, from) + text.slice(from, end).replace(/[^\n]/g, ' ');
    at = end;
  }
  masked += text.slice(at);
  const original = text.split('\n');
  const only = new Set();
  masked.split('\n').forEach((line, index) => {
    if (line.trim() === '' && original[index].trim() !== '') only.add(index);
  });
  return only;
}
