const IDENT = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y;
const JINJA = /\{[{%#]/;

export const SQL_DIALECTS = {
  ansi: { lineMarkers: [], escapingQuotes: '', tripleQuotes: false, dashNeedsSpace: false },
  snowflake: { lineMarkers: ['//'], escapingQuotes: "'", tripleQuotes: false, dashNeedsSpace: false },
  bigquery: { lineMarkers: ['#'], escapingQuotes: `'"`, tripleQuotes: true, dashNeedsSpace: false },
  mysql: { lineMarkers: ['#'], escapingQuotes: `'"`, tripleQuotes: false, dashNeedsSpace: true },
};

// Jinja renders before SQL parses, so `{# #}` inside a SQL string is still a comment.
function jinjaPass(text) {
  const ranges = [];
  let masked = '';
  let i = 0;
  while (i < text.length) {
    const open = text.slice(i, i + 2);
    if (open === '{#' || open === '{{' || open === '{%') {
      const close = open === '{#' ? '#}' : open === '{{' ? '}}' : '%}';
      let j = i + 2;
      let quote = null;
      while (j < text.length) {
        const c = text[j];
        if (quote) {
          if (c === '\\') j++;
          else if (c === quote) quote = null;
        } else if (open !== '{#' && (c === '"' || c === "'")) quote = c;
        else if (text.startsWith(close, j)) break;
        j++;
      }
      const end = Math.min(j + 2, text.length);
      if (open === '{#') ranges.push([i, end]);
      masked += text.slice(i, end).replace(/[^\n\r\u2028\u2029]/g, ' ');
      i = end;
    } else {
      masked += text[i];
      i++;
    }
  }
  return { ranges, masked };
}

function sqlPass(text, from, to, ranges, dialect) {
  let i = from;
  let escapeContinuationEnd = -1;
  while (i < to) {
    const c = text[i];
    const pair = text.slice(i, i + 2);
    const dashComment = pair === '--' && (!dialect.dashNeedsSpace || i + 2 >= to || /[\s\x00-\x1f]/.test(text[i + 2]));
    if (dashComment || dialect.lineMarkers.some((marker) => text.startsWith(marker, i))) {
      let j = i;
      while (j < to && text[j] !== '\n' && text[j] !== '\r') j++;
      ranges.push([i, j]);
      i = j;
    } else if (pair === '/*') {
      let depth = 0;
      let j = i;
      while (j < to) {
        const two = text.slice(j, j + 2);
        if (two === '/*') {
          depth++;
          j += 2;
        } else if (two === '*/') {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      ranges.push([i, Math.min(j, to)]);
      i = Math.min(j, to);
    } else if (dialect.tripleQuotes && (text.startsWith("'''", i) || text.startsWith('"""', i))) {
      const triple = text.slice(i, i + 3);
      let j = i + 3;
      while (j < to && !text.startsWith(triple, j)) j += text[j] === '\\' ? 2 : 1;
      i = Math.min(j + 3, to);
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1);
      i = end < 0 || end >= to ? to : end + 1;
    } else if (c === "'" || c === '"' || ((c === 'E' || c === 'e') && text[i + 1] === "'" && !IDENT.test(text[i - 1] ?? ''))) {
      const prefixed = c === 'E' || c === 'e';
      const gap =
        escapeContinuationEnd >= 0 ? text.slice(escapeContinuationEnd, i).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ') : null;
      const escapes =
        prefixed || dialect.escapingQuotes.includes(c) || (c === "'" && gap !== null && /^\s*\n\s*$/.test(gap));
      const quote = prefixed ? "'" : c;
      let j = i + (prefixed ? 2 : 1);
      while (j < to) {
        if (escapes && text[j] === '\\') j += 2;
        else if (text[j] === quote && text[j + 1] === quote) j += 2;
        else if (text[j] === quote) {
          j++;
          break;
        } else j++;
      }
      i = Math.min(j, to);
      escapeContinuationEnd = escapes ? i : -1;
    } else if (c === '$' && !IDENT.test(text[i - 1] ?? '')) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(text);
      if (!tag) {
        i++;
        continue;
      }
      const bodyStart = i + tag[0].length;
      const close = text.indexOf(tag[0], bodyStart);
      const bodyEnd = close < 0 || close > to ? to : close;
      sqlPass(text, bodyStart, bodyEnd, ranges, dialect);
      i = Math.min(bodyEnd + tag[0].length, to);
    } else i++;
  }
}

// A function body's comments are comments, so a dollar-quoted body is lexed as SQL.
export function sqlCommentRanges(text, dialect = 'ansi') {
  const jinja = JINJA.test(text) ? jinjaPass(text) : { ranges: [], masked: text };
  const ranges = [...jinja.ranges];
  sqlPass(jinja.masked, 0, jinja.masked.length, ranges, SQL_DIALECTS[dialect]);
  return ranges.sort((a, b) => a[0] - b[0]);
}
