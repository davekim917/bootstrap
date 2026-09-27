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

/**
 * `exclude`: never counted. `frozen`: a file that already exists at the base is never counted on
 * either side, so deleting comments from it (say, an applied migration under a checksum) earns
 * nothing; a new file matching the pattern counts. `ticketPrefixes`: extra ticket keys, e.g.
 * "ABC" flags "ABC-123".
 */
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
  const exclude = [...DEFAULT_EXCLUDE, ...list('exclude')].map(globToRegExp);
  const frozen = list('frozen').map(globToRegExp);
  return {
    ticketPrefixes,
    isExcluded: (file) => exclude.some((re) => re.test(file)),
    isFrozen: (file) => frozen.some((re) => re.test(file)),
  };
}
