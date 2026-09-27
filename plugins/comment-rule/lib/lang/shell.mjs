const WORD_BREAK = /[\s;&|()<>]/;

// The delimiter is a whole shell word with its quotes removed: `<<'E'OF` and `<<$'EOF'` both end at `EOF`.
function heredocDelimiter(text, i) {
  let j = i + 2;
  const strip = text[j] === '-';
  if (strip) j++;
  while (text[j] === ' ' || text[j] === '\t') j++;
  let word = '';
  while (j < text.length && !WORD_BREAK.test(text[j])) {
    const c = text[j];
    const quote = c === '$' && text[j + 1] === "'" ? "'" : c === "'" || c === '"' ? c : null;
    if (quote) {
      const open = c === '$' ? j + 2 : j + 1;
      const close = text.indexOf(quote, open);
      if (close < 0) return null;
      word += text.slice(open, close);
      j = close + 1;
    } else if (c === '\\') {
      word += text[j + 1] ?? '';
      j += 2;
    } else {
      word += c;
      j++;
    }
  }
  return word ? { strip, delimiter: word, end: j } : null;
}

function skipSingle(text, i, to) {
  const end = text.indexOf("'", i + 1);
  return end < 0 || end >= to ? to : end + 1;
}

function backquoted(text, i, to, ranges) {
  let j = i + 1;
  while (j < to && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
  const end = Math.min(j, to);
  scan(text, i + 1, end, ranges, false);
  return Math.min(end + 1, to);
}

function braced(text, i, to, ranges) {
  let depth = 0;
  let j = i;
  while (j < to) {
    const c = text[j];
    if (c === '\\') j += 2;
    else if (c === "'") j = skipSingle(text, j, to);
    else if (c === '"') j = doubleQuoted(text, j, to, ranges);
    else if (c === '`') j = backquoted(text, j, to, ranges);
    else if (c === '$' && text[j + 1] === '(' && text[j + 2] === '(') j = skipArithmetic(text, j + 1, to);
    else if (c === '$' && text[j + 1] === '(') j = scan(text, j + 2, to, ranges, true);
    else {
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return j + 1;
      j++;
    }
  }
  return to;
}

function skipArithmetic(text, i, to) {
  let depth = 0;
  for (let j = i; j < to; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')' && --depth === 0) return j + 1;
  }
  return to;
}

function doubleQuoted(text, i, to, ranges) {
  let j = i + 1;
  while (j < to) {
    const c = text[j];
    if (c === '"') return j + 1;
    if (c === '\\') j += 2;
    else if (c === '`') j = backquoted(text, j, to, ranges);
    else if (c === '$' && text[j + 1] === '{') j = braced(text, j + 1, to, ranges);
    else if (c === '$' && text[j + 1] === '(' && text[j + 2] === '(') j = skipArithmetic(text, j + 1, to);
    else if (c === '$' && text[j + 1] === '(') j = scan(text, j + 2, to, ranges, true);
    else j++;
  }
  return to;
}

// A command substitution is shell code wherever it is nested, so its comments are scanned too.
function scan(text, start, to, ranges, insideSubstitution) {
  const pendingHeredocs = [];
  let depth = 0;
  let i = start;
  while (i < to) {
    const c = text[i];
    const atWordStart = i === start || WORD_BREAK.test(text[i - 1]);
    if (c === '\n') {
      i++;
      while (pendingHeredocs.length) {
        const { strip, delimiter } = pendingHeredocs.shift();
        while (i < to) {
          let end = text.indexOf('\n', i);
          if (end < 0) end = to;
          const line = text.slice(i, end).replace(/\r$/, '');
          i = end + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break;
        }
      }
      continue;
    }
    if (c === '#' && atWordStart) {
      let j = i;
      while (j < to && text[j] !== '\n') j++;
      ranges.push([i, j]);
      i = j;
    } else if (c === '\\') i += 2;
    else if (c === "'") i = skipSingle(text, i, to);
    else if (c === '"') i = doubleQuoted(text, i, to, ranges);
    else if (c === '`') i = backquoted(text, i, to, ranges);
    else if (c === '(' && text[i + 1] === '(' && atWordStart) i = skipArithmetic(text, i, to);
    else if (c === '$') {
      const next = text[i + 1];
      if (next === "'") {
        let j = i + 2;
        while (j < to && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
        i = Math.min(j + 1, to);
      } else if (next === '{') i = braced(text, i + 1, to, ranges);
      else if (next === '(' && text[i + 2] === '(') i = skipArithmetic(text, i + 1, to);
      else if (next === '(') i = scan(text, i + 2, to, ranges, true);
      else i += 2;
    } else if (text.startsWith('<<<', i)) i += 3;
    else if (text.startsWith('<<', i)) {
      const heredoc = heredocDelimiter(text, i);
      if (heredoc) {
        pendingHeredocs.push(heredoc);
        i = heredoc.end;
      } else i += 2;
    } else {
      if (insideSubstitution && c === '(') depth++;
      else if (insideSubstitution && c === ')' && depth-- === 0) return i + 1;
      i++;
    }
  }
  return to;
}

export function shellCommentRanges(text) {
  const ranges = [];
  const start = text.startsWith('#!') ? text.indexOf('\n') : 0;
  if (start >= 0) scan(text, start, text.length, ranges, false);
  return ranges;
}
