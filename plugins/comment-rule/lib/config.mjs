import { SQL_DIALECTS } from './lang/sql.mjs';

export const CONFIG_FILE = '.comment-rule.json';

const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/*.min.js'];

function globToRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      pattern += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') pattern += '[^/]*';
    else if (c === '?') pattern += '[^/]';
    else pattern += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

// A frozen file that exists at the base counts on neither side, so deleting its comments earns nothing.
export function parseConfig(text) {
  const raw = text ? JSON.parse(text) : {};
  const list = (key) => {
    const value = raw[key] ?? [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${CONFIG_FILE}: "${key}" must be an array of strings`);
    }
    return value;
  };
  const ticketPrefixes = list('ticketPrefixes');
  const badPrefix = ticketPrefixes.find((prefix) => !/^[A-Za-z][A-Za-z0-9]*$/.test(prefix));
  if (badPrefix) throw new Error(`${CONFIG_FILE}: ticket prefix ${JSON.stringify(badPrefix)} must be letters and digits`);
  const sqlDialect = raw.sqlDialect ?? 'ansi';
  if (!Object.hasOwn(SQL_DIALECTS, sqlDialect)) {
    throw new Error(`${CONFIG_FILE}: sqlDialect must be one of ${Object.keys(SQL_DIALECTS).join(', ')}`);
  }
  const exclude = [...DEFAULT_EXCLUDE, ...list('exclude')].map(globToRegExp);
  const frozen = list('frozen').map(globToRegExp);
  return {
    ticketPrefixes,
    sqlDialect,
    isExcluded: (file) => exclude.some((re) => re.test(file)),
    isFrozen: (file) => frozen.some((re) => re.test(file)),
  };
}
