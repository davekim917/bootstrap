#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';

import { checkChange, checkFileAgainstHead, countTree } from '../lib/check.mjs';

const USAGE = `usage:
  comment-rule.mjs check [--repo <dir>] [--base <ref>] [--head <ref>] [--own-typescript] [--json]
  comment-rule.mjs file <path>... [--json]
  comment-rule.mjs count [--repo <dir>] [--json]

check  the change from merge-base(base, head) to head; head defaults to the working tree and base
       to origin's default branch. Exit 1 only for a prohibited comment form (file:line, PR/issue/ticket);
       new comment lines are listed for a reviewer to judge, never failed. Exit 2 could not check.
       --own-typescript never loads TypeScript from the checked repository; CI passes it, since a pull
       request controls those files.
file   each file against HEAD (write-time feedback). Always exits 0 unless it cannot run.
count  comment lines in every tracked file, by language.`;

const GUIDANCE =
  'Keep a comment only when a reader, human or agent, would get something wrong without it: an external ' +
  "system's quirk, why the obvious approach is wrong. Cut narration, restatement and history. Never cite " +
  'file:line or a PR/issue/ticket number in a comment: history belongs in git.';

const newCount = (file) => file.new_comment_lines_total ?? file.new_comment_lines.length;

function printCheck(result) {
  const sign = result.net > 0 ? '+' : '';
  const added = result.files.reduce((sum, file) => sum + newCount(file), 0);
  console.log(
    `comment-rule: ${result.status.toUpperCase()} — ${result.findings} prohibited form(s); ${added} new comment line(s) to judge, ` +
      `net ${sign}${result.net} (${result.before} → ${result.after} in the changed files); base ${result.base} @ ${result.merge_base.slice(0, 12)}`,
  );
  for (const file of result.files.filter((f) => newCount(f) || f.findings.length)) {
    console.log(`  +${newCount(file)} new\t${file.path} (${file.base} → ${file.head})`);
    for (const finding of file.findings) console.log(`    ${file.path}:${finding.line} ${finding.rule}: ${finding.text}`);
  }
  for (const error of result.errors) console.log(`  could not check ${error.path}: ${error.error}`);
  if (added || result.findings) console.log(`\n${GUIDANCE}`);
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
