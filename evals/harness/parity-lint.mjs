#!/usr/bin/env node
/**
 * Structural parity-lint — Gate 1 for the workflow-codex rollout.
 *
 *   node parity-lint.mjs <skill> [<skill> ...]
 *   node parity-lint.mjs --all          (every skill present in BOTH trees)
 *
 * Encodes the rollout contract ("augmented, not gutted; behavior unchanged; ONLY
 * orchestration translated") as deterministic checks comparing the augmented
 * `workflow-codex/skills/<skill>` against the Claude original `workflow/skills/<skill>`:
 *
 *   1. SUBSTANCE PRESERVED — every NON-orchestration heading in the Claude skill
 *      appears (verbatim or as a prefix-equivalent) in the codex skill. Orchestration
 *      headings (spawn/team/collaborate/dispatch/parallel/…) are exempt: those are the
 *      part we translate. Coverage must clear --min-heading (default 0.85). This is the
 *      primary anti-gutting signal — a gutted skill cannot keep 85% of its substance
 *      headings with real content.
 *   2. ORCHESTRATION CONFINED — Claude-only primitives (TeamCreate, SendMessage,
 *      subagent_type, Agent(, Task(, TeamDelete) may appear ONLY inside a
 *      "## Dispatch by Runtime" / "Claude (reference…)" region. Anywhere else = leakage
 *      of a primitive that doesn't exist on codex/opencode → FAIL.
 *   3. REFERENCES RESTORED — codex references/ count ≥ Claude references/ count.
 *   4. FRONTMATTER intact (name/version/description).
 *
 * Length ratio is reported and WARNed (<0.7) but not gated on its own — heading
 * coverage already catches gutting, and a faithful translation that delegates to
 * shared/ docs is legitimately tighter. The WARN flags "headings present but suspiciously
 * short" for human review.
 *
 * Exit 0 if every requested skill PASSES, 1 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLUGINS } from './lib.mjs';

const CLAUDE_ROOT = path.join(PLUGINS, 'workflow', 'skills');
const CODEX_ROOT = path.join(PLUGINS, 'workflow-codex', 'skills');

// Heading text matching any of these is "orchestration" — exempt from must-preserve
// (it gets translated to native delegation, often renamed or folded into Dispatch-by-Runtime).
const ORCH_HEADING = /\b(spawn|team|collaborat|deleg|dispatch|parallel|swarm|agent|subagent|orchestrat|fan[\s-]?out|worker)\b/i;
// Claude-only orchestration primitives + Claude-specific paths that must NOT leak into a
// codex/opencode skill body (or into worker-prompt references). `.claude/` paths (scratch
// dirs, skill paths, global config) are Claude-Code-specific and must be translated to a
// runtime-neutral path (e.g. .agents/tmp/bootstrap-workflow/) or AGENTS.md.
const CLAUDE_TOKEN = /\b(TeamCreate|TeamDelete|SendMessage|subagent_type)\b|\bAgent\(|\bTask\(|\.claude\b/;
// The only region where Claude tokens are allowed: the "## Dispatch by Runtime" section.
const DISPATCH_HEADING = /^##\s+Dispatch by Runtime\b/i;

export function headingLines(md) {
  return md.split('\n').filter((l) => /^#{2,4}\s+/.test(l));
}
export function headingText(line) {
  return line.replace(/^#{2,4}\s+/, '').trim();
}
export function norm(h) {
  return h
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\w\s)]+$/, '') // strip trailing punctuation
    .replace(/\s+/g, ' ')
    .trim();
}
/** A required Claude heading is "covered" if some codex heading equals it or one is a prefix of the other (tolerates parenthetical suffixes / minor rewording). */
export function covered(reqNorm, codexNorms) {
  return codexNorms.some((c) => c === reqNorm || c.startsWith(reqNorm) || reqNorm.startsWith(c));
}
function countRefs(dir) {
  const r = path.join(dir, 'references');
  try {
    // Count ALL reference artifacts, not just *.md — skills ship .json refs too
    // (e.g. codex-review-output.schema.json, drift-acks-template.json); a dropped
    // JSON asset must fail the restoration gate.
    return fs.readdirSync(r, { withFileTypes: true }).filter((d) => d.isFile()).length;
  } catch {
    return 0;
  }
}
export function hasFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { ok: false, missing: ['frontmatter block'] };
  const fm = m[1];
  const missing = ['name', 'version', 'description'].filter((k) => !new RegExp(`^${k}:`, 'm').test(fm));
  return { ok: missing.length === 0, missing };
}

/** Confinement: walk lines tracking whether we're inside the "## Dispatch by Runtime" region. */
export function tokenLeaks(md) {
  const leaks = [];
  let inRegion = false;
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      // ONLY a level-2 heading toggles the region: enter on "## Dispatch by Runtime", exit on
      // any other ##. Deeper (###) subheadings — including "### Claude (reference …)" — don't
      // toggle it, so the Claude-reference block stays exempt *only* while under Dispatch. A
      // standalone Claude-reference heading elsewhere can no longer enable the exemption (that
      // was a confinement bypass: a skill could suppress leak detection in any section).
      inRegion = DISPATCH_HEADING.test(line);
    }
    if (!inRegion && CLAUDE_TOKEN.test(line)) {
      const tok = line.match(CLAUDE_TOKEN)[0];
      leaks.push({ line: i + 1, token: tok, text: line.trim().slice(0, 80) });
    }
  }
  return leaks;
}

function lintSkill(skill, opts) {
  const claudeFile = path.join(CLAUDE_ROOT, skill, 'SKILL.md');
  const codexFile = path.join(CODEX_ROOT, skill, 'SKILL.md');
  const out = { skill, pass: true, lines: [] };
  const fail = (m) => {
    out.pass = false;
    out.lines.push(`  ✗ ${m}`);
  };
  const ok = (m) => out.lines.push(`  ✓ ${m}`);
  const warn = (m) => out.lines.push(`  ⚠ ${m}`);

  if (!fs.existsSync(codexFile)) return fail(`codex skill missing: ${codexFile}`), out;
  if (!fs.existsSync(claudeFile)) {
    // No Claude counterpart → codex-only skill; only frontmatter + token checks apply.
    warn(`no Claude original (codex-only skill) — substance/refs checks skipped`);
  }
  const codexMd = fs.readFileSync(codexFile, 'utf8');

  // 4. frontmatter
  const fm = hasFrontmatter(codexMd);
  fm.ok ? ok('frontmatter has name/version/description') : fail(`frontmatter missing: ${fm.missing.join(', ')}`);

  // 2. orchestration confinement
  const leaks = tokenLeaks(codexMd);
  if (leaks.length === 0) ok('no Claude-only orchestration tokens leak outside Dispatch/Claude-reference region');
  else for (const l of leaks) fail(`Claude token "${l.token}" leaks at line ${l.line}: ${l.text}`);

  if (fs.existsSync(claudeFile)) {
    const claudeMd = fs.readFileSync(claudeFile, 'utf8');
    // 1. heading coverage (non-orchestration headings must be preserved)
    const required = headingLines(claudeMd).map(headingText).filter((h) => !ORCH_HEADING.test(h));
    const codexNorms = headingLines(codexMd).map((l) => norm(headingText(l)));
    const missing = required.filter((h) => !covered(norm(h), codexNorms));
    const coverage = required.length ? (required.length - missing.length) / required.length : 1;
    const minHeading = opts.minHeading ?? 0.85;
    if (coverage >= minHeading)
      ok(`substance headings preserved: ${(coverage * 100).toFixed(0)}% (${required.length - missing.length}/${required.length})`);
    else fail(`substance gutted: only ${(coverage * 100).toFixed(0)}% of non-orchestration headings preserved; missing: ${missing.join(' | ')}`);

    // 3. references restored
    const cRefs = countRefs(path.join(CLAUDE_ROOT, skill));
    const xRefs = countRefs(path.join(CODEX_ROOT, skill));
    if (xRefs >= cRefs) ok(`references restored: ${xRefs}/${cRefs}`);
    else fail(`references dropped: ${xRefs}/${cRefs} (missing ${cRefs - xRefs})`);

    // length ratio (informational + warn)
    const ratio = claudeMd.split('\n').length ? codexMd.split('\n').length / claudeMd.split('\n').length : 1;
    if (ratio < 0.7) warn(`length ratio ${ratio.toFixed(2)} (<0.70) — headings present but short; verify content isn't thin`);
    else ok(`length ratio ${ratio.toFixed(2)}`);
  }

  // 5. reference confinement — references are worker PROMPTS (loaded by spawned workers),
  // so they must be runtime-neutral: NO Claude-only orchestration primitives. References
  // have no Dispatch-by-Runtime region, so any Claude token there is an unconfined leak.
  const refLeaks = referenceLeaks(path.join(CODEX_ROOT, skill));
  if (refLeaks.length === 0) ok('references carry no Claude-only orchestration tokens');
  else {
    for (const l of refLeaks.slice(0, 10)) fail(`reference leak ${l.file}:${l.line} "${l.token}": ${l.text}`);
    if (refLeaks.length > 10) fail(`...+${refLeaks.length - 10} more reference leaks`);
  }
  return out;
}

/** Scan a skill's references/*.md for Claude-only orchestration tokens (worker prompts must be runtime-neutral). */
export function referenceLeaks(skillDir) {
  const refDir = path.join(skillDir, 'references');
  const leaks = [];
  let files = [];
  try {
    files = fs.readdirSync(refDir).filter((f) => f.endsWith('.md'));
  } catch {
    return leaks;
  }
  for (const f of files) {
    const lines = fs.readFileSync(path.join(refDir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(CLAUDE_TOKEN);
      if (m) leaks.push({ file: f, line: i + 1, token: m[0], text: line.trim().slice(0, 70) });
    });
  }
  return leaks;
}

function main() {
  const argv = process.argv.slice(2);
  const opts = {};
  let skills = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') {
      const codexSkills = fs.readdirSync(CODEX_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'shared').map((d) => d.name);
      skills = codexSkills.filter((s) => fs.existsSync(path.join(CLAUDE_ROOT, s, 'SKILL.md')));
    } else if (argv[i] === '--min-heading') {
      opts.minHeading = Number(argv[++i]);
    } else skills.push(argv[i]);
  }
  if (skills.length === 0) {
    console.error('usage: parity-lint.mjs <skill> [<skill> ...] | --all [--min-heading 0.85]');
    process.exit(2);
  }
  let anyFail = false;
  for (const skill of skills) {
    const r = lintSkill(skill, opts);
    console.log(`\n[parity-lint] ${skill} → ${r.pass ? 'PASS' : 'FAIL'}`);
    for (const l of r.lines) console.log(l);
    if (!r.pass) anyFail = true;
  }
  console.log(`\n[parity-lint] ${anyFail ? 'FAIL' : 'PASS'} (${skills.length} skill${skills.length > 1 ? 's' : ''})`);
  process.exit(anyFail ? 1 : 0);
}

// Run as CLI only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) main();
