#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';

import { checkChange, checkFileAgainstHead, countTree } from '../lib/check.mjs';

const USAGE = `usage:
  comment-rule.mjs check [--repo <dir>] [--base <ref>] [--head <ref>] [--own-typescript] [--json]
  comment-rule.mjs file <path>... [--json]
  comment-rule.mjs count [--repo <dir>] [--json]

check  the change from merge-base(base, head) to head; head defaults to the working tree and base
       to origin's default branch. Exit 0 pass, 1 fail, 2 could not check. --own-typescript never loads
       TypeScript from the checked repository; CI passes it, since a pull request controls those files.
file   each file against HEAD (write-time feedback). Always exits 0 unless it cannot run.
count  comment lines in every tracked file, by language.`;

const GUIDANCE =
  'Keep a comment only where a reader would otherwise get the code wrong (a hazard, constraint or external quirk); ' +
  'cut the rest, or delete as many narrating, restating or history comment lines elsewhere in the change. ' +
  'Never cite file:line or a PR/issue/ticket number in a comment: history belongs in git.';

function printCheck(result) {
  const sign = result.net > 0 ? '+' : '';
  console.log(
    `comment-rule: ${result.status.toUpperCase()} — net ${sign}${result.net} comment lines ` +
      `(${result.before} → ${result.after} in the changed files), ${result.findings} prohibited form(s); base ${result.base} @ ${result.merge_base.slice(0, 12)}`,
  );
  for (const file of result.files.filter((f) => f.net !== 0 || f.findings.length)) {
    console.log(`  ${file.net > 0 ? '+' : ''}${file.net}\t${file.path} (${file.base} → ${file.head})`);
    for (const finding of file.findings) console.log(`    ${file.path}:${finding.line} ${finding.rule}: ${finding.text}`);
  }
  for (const error of result.errors) console.log(`  could not check ${error.path}: ${error.error}`);
  if (result.status === 'fail') console.log(`\n${GUIDANCE}`);
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      'own-typescript': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const repo = path.resolve(values.repo ?? '.');
  if (command === 'check') {
    const result = checkChange({ repo, base: values.base, head: values.head, ownTypeScript: values['own-typescript'] });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else printCheck(result);
    return { pass: 0, fail: 1, error: 2 }[result.status];
  }
  if (command === 'file') {
    const results = rest.map((file) => checkFileAgainstHead(path.resolve(file))).filter(Boolean);
    if (values.json) console.log(JSON.stringify(results, null, 2));
    else for (const r of results) console.log(r.error ? `${r.path}: ${r.error}` : `${r.path}: net ${r.net} (${r.base} → ${r.head}), ${r.findings.length} prohibited form(s)`);
    return 0;
  }
  if (command === 'count') {
    const result = countTree(repo);
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const [language, total] of Object.entries(result.totals).sort((a, b) => b[1].comment_lines - a[1].comment_lines)) {
        console.log(`${language.padEnd(12)} ${String(total.comment_lines).padStart(8)} comment lines in ${total.files_with_comments} files`);
      }
      for (const error of result.errors) console.log(`could not read ${error.path}: ${error.error}`);
    }
    return result.errors.length ? 2 : 0;
  }
  console.error(USAGE);
  return 2;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`comment-rule: could not run: ${String(error?.message ?? error).split('\n')[0]}`);
  process.exitCode = 2;
}
