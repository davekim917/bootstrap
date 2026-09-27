const URL = /\bhttps?:\/\/[^\s)\]}>,'"`]+/gi;
const BLOB_LINE_URL = /\/blob\/[^\s#]+#L\d+/i;
const PULL_OR_ISSUE_URL = /github\.com\/([^/\s]+)\/[^/\s]+\/(?:pull|issues)\/\d+/gi;

const LOCATION = /(?<![\w./@-])([\w./@-]*\w):\d+(?!\d|\.\d)/g;
const SOURCE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|json|sh|bash|zsh|py|pyi|md|mdx|ya?ml|toml|sql|rs|go|c|h|cc|cpp|hpp|java|kt|rb|swift|css|scss|html|txt|ipynb|tf|lua|php|vue|svelte)$/;
const EXTENSIONLESS_FILE =
  /^(?:Dockerfile|Containerfile|Makefile|GNUmakefile|Justfile|Procfile|Gemfile|Rakefile|Jenkinsfile)(?:\.[\w-]+)?$|^\.[A-Za-z][\w.-]*$/;

const HISTORY = [
  /\b(?:PRs?|pull requests?|issues?|tickets?|GH)\s*[-#]?\s*\d+\b/i,
  /\b[\w.-]+\/[\w.-]+#\d+\b/,
  /(?<![\w&]|\]\(|(?:colou?r|background|fill|stroke|step|item|rule|row|column|option|case|no\.)\s*[:=]?\s*)#\d{3,}\b/i,
];

/** Host:port, times, versions and ids have neither a path nor a file-like name before the colon. */
function citesFileLine(text) {
  if (BLOB_LINE_URL.test(text)) return true;
  return [...text.replace(URL, ' ').matchAll(LOCATION)].some(([, name]) => {
    const base = name.slice(name.lastIndexOf('/') + 1);
    const pathQualified = name.includes('/') && /[A-Za-z]/.test(base);
    return pathQualified || SOURCE_EXTENSION.test(base) || EXTENSIONLESS_FILE.test(base);
  });
}

function citesHistory(text, { ownOwner, ticketPrefixes }) {
  for (const [, owner] of text.matchAll(PULL_OR_ISSUE_URL)) {
    if (ownOwner && owner.toLowerCase() === ownOwner.toLowerCase()) return true;
  }
  const bare = text.replace(URL, ' ');
  if (HISTORY.some((pattern) => pattern.test(bare))) return true;
  return ticketPrefixes.some((prefix) => new RegExp(`\\b${prefix}[-#]\\d+\\b`, 'i').test(bare));
}

export function prohibitedForms(text, context) {
  const found = [];
  if (citesFileLine(text)) found.push('file-line-citation');
  if (citesHistory(text, context)) found.push('history-reference');
  return found;
}
