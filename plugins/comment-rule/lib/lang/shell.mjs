const WORD_BREAK = /[\s;&|()<>]/;
const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|()<>'"]+))/y;

function skipSingle(text, i, to) {
  const end = text.indexOf("'", i + 1);
  return end < 0 || end >= to ? to : end + 1;
}

function skipBackquote(text, i, to) {
  let j = i + 1;
  while (j < to && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, to);
}

function skipDouble(text, i, to) {
  let j = i + 1;
  while (j < to) {
    const c = text[j];
    if (c === '"') return j + 1;
    if (c === '\\') j += 2;
    else if (c === '`') j = skipBackquote(text, j, to);
    else if (c === '$' && (text[j + 1] === '(' || text[j + 1] === '{')) j = skipBalanced(text, j + 1, to);
    else j++;
  }
  return to;
}

function skipBalanced(text, i, to) {
  const open = text[i];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  let j = i;
  while (j < to) {
    const c = text[j];
    if (c === '\\') j += 2;
    else if (c === "'") j = skipSingle(text, j, to);
    else if (c === '"') j = skipDouble(text, j, to);
    else if (c === '`') j = skipBackquote(text, j, to);
    else {
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j + 1;
      j++;
    }
  }
  return to;
}

/**
 * `#` opens a comment only at the start of a word, so `a#b`, `$#` and `${x#y}` are code. Heredoc
 * bodies, arithmetic and every quoted form are code; a `#` inside a `$( )` nested in double
 * quotes is not counted. The first line's shebang is not a comment.
 */
export function shellCommentRanges(text) {
  const ranges = [];
  const to = text.length;
  const pendingHeredocs = [];
  let i = text.startsWith('#!') ? text.indexOf('\n') : 0;
  if (i < 0) return ranges;
  while (i < to) {
    const c = text[i];
    const atWordStart = i === 0 || WORD_BREAK.test(text[i - 1]);
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
    else if (c === '"') i = skipDouble(text, i, to);
    else if (c === '`') i = skipBackquote(text, i, to);
    else if (c === '(' && text[i + 1] === '(' && atWordStart) i = skipBalanced(text, i, to);
    else if (c === '$') {
      const next = text[i + 1];
      if (next === "'") {
        let j = i + 2;
        while (j < to && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
        i = Math.min(j + 1, to);
      } else if (next === '{' || (next === '(' && text[i + 2] === '(')) i = skipBalanced(text, i + 1, to);
      else i += next === '(' ? 1 : 2;
    } else if (text.startsWith('<<<', i)) i += 3;
    else if (text.startsWith('<<', i)) {
      HEREDOC.lastIndex = i;
      const match = HEREDOC.exec(text);
      if (match) {
        pendingHeredocs.push({ strip: match[1] === '-', delimiter: match[2] ?? match[3] ?? match[4] });
        i = HEREDOC.lastIndex;
      } else i += 2;
    } else i++;
  }
  return ranges;
}
