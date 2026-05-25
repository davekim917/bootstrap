#!/usr/bin/env node
/**
 * Gate 1 — static structure lint for an augmented workflow-codex skill.
 *
 * Verifies the skill was *translated*, not gutted: valid frontmatter, every
 * referenced file exists, the per-runtime dispatch section names its target
 * runtimes, and all runtime-neutral substance anchors survive. Cheap pre-gate to
 * the behavioral eval (run.mjs); passing it is necessary, not sufficient.
 *
 * Usage:  node harness/lint.mjs <suite>
 *   reads  evals/suites/<suite>/anchors.json  (which names the skill + anchors)
 *   checks plugins/workflow-codex/skills/<skill>/SKILL.md
 * Exit:   0 = pass, 1 = fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = path.resolve(HARNESS_DIR, '..');
const BOOTSTRAP_ROOT = path.resolve(EVALS_DIR, '..');

const suite = process.argv[2];
if (!suite) {
  console.error('usage: node harness/lint.mjs <suite>');
  process.exit(2);
}

const anchorsPath = path.join(EVALS_DIR, 'suites', suite, 'anchors.json');
if (!fs.existsSync(anchorsPath)) {
  console.error(`FATAL: no anchors.json at suites/${suite}/anchors.json (nothing to lint)`);
  process.exit(2);
}
const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
const skill = anchors.skill || suite;
const skillDir = path.join(BOOTSTRAP_ROOT, 'plugins', 'workflow-codex', 'skills', skill);
const skillMd = path.join(skillDir, 'SKILL.md');

const failures = [];
const checks = [];
const ok = (m) => checks.push(`  ✓ ${m}`);
const fail = (m) => failures.push(`  ✗ ${m}`);

if (!fs.existsSync(skillMd)) {
  console.error(`FATAL: ${skillMd} not found`);
  process.exit(1);
}
const body = fs.readFileSync(skillMd, 'utf8');

// 1. Frontmatter
const fm = body.match(/^---\n([\s\S]*?)\n---/);
if (!fm) fail('SKILL.md has no YAML frontmatter block');
else {
  for (const key of ['name', 'version', 'description']) {
    if (new RegExp(`^${key}\\s*:`, 'm').test(fm[1])) ok(`frontmatter has \`${key}\``);
    else fail(`frontmatter missing \`${key}\``);
  }
}

// 2. Required substrings (runtime-neutral substance survived the translation)
for (const s of anchors.required_substrings ?? []) {
  if (body.includes(s)) ok(`substance anchor present: "${s}"`);
  else fail(`substance anchor MISSING (gutted?): "${s}"`);
}

// 3. Referenced files exist (the anchors list + any references/ links in the body)
const linkedRefs = new Set([...body.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]));
for (const r of anchors.required_references ?? []) linkedRefs.add(r);
for (const ref of linkedRefs) {
  if (fs.existsSync(path.join(skillDir, ref))) ok(`reference exists: ${ref}`);
  else fail(`reference MISSING: ${ref}`);
}

// 4. Dispatch section names each target runtime — scoped to the section itself (up to the
// next level-2 heading), so a mention in an unrelated later section can't satisfy the gate.
const dispatchIdx = body.indexOf('## Dispatch by Runtime');
if (dispatchIdx === -1) fail('no "## Dispatch by Runtime" section');
else {
  const after = body.slice(dispatchIdx + '## Dispatch by Runtime'.length);
  const nextH2 = after.search(/\n##\s/);
  const dispatch = nextH2 === -1 ? after : after.slice(0, nextH2);
  for (const rt of anchors.dispatch_must_name ?? []) {
    if (dispatch.includes(rt)) ok(`dispatch section names runtime: ${rt}`);
    else fail(`dispatch section does not name runtime: ${rt}`);
  }
}

console.log(`\n[lint] suite=${suite} skill=${skill}`);
for (const c of checks) console.log(c);
for (const f of failures) console.log(f);
console.log(`\n[lint] ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length} issue${failures.length === 1 ? '' : 's'})`}\n`);
process.exit(failures.length === 0 ? 0 : 1);
