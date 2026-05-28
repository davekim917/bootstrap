#!/usr/bin/env node
/**
 * Single-source generator for the MECHANICALLY-DERIVABLE workflow-agents skills.
 *
 * The develop-once goal for skills, made concrete by measuring the actual
 * Claude→agents delta per skill:
 *
 *   - 8 skills (MANAGED below) differ from their Claude source ONLY by mechanical,
 *     runtime-neutral token substitutions. Those are GENERATED here from the
 *     Claude source — edit the Claude skill once, regenerate, and the agents copy
 *     follows. `--check` fails if a managed copy drifts from `transform(Claude)`.
 *
 *   - 9 skills (the 5 orchestration skills with Dispatch-by-Runtime sections +
 *     4 others) carry JUDGMENT-BASED runtime-neutral translation — re-worded prose,
 *     Skill-tool/`~/.claude` invocation language rephrased to neutral form, inline
 *     TeamCreate/Task blocks lifted into a Dispatch section. That can't be faithfully
 *     reproduced by mechanical rules, so those skills stay hand-authored and are
 *     gated for drift by `evals/harness/parity-lint.mjs` (substance coverage +
 *     no-Claude-token-leak) instead. See PARITY.md.
 *
 * Net: every skill is drift-gated (managed → here; hand-authored → parity-lint),
 * and the trivially-derivable majority of the duplication is eliminated.
 *
 * Usage:
 *   node plugins/workflow-agents/scripts/sync-agent-skills.mjs           # regenerate managed skills
 *   node plugins/workflow-agents/scripts/sync-agent-skills.mjs --check   # exit 1 if any managed copy is stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLAUDE = path.join(REPO, 'plugins/workflow/skills');
const AGENTS = path.join(REPO, 'plugins/workflow-agents/skills');

// Skills whose agents copy is exactly transform(Claude) — verified by measuring
// the delta (Δ≤4, no Dispatch section, purely mechanical substitutions).
const MANAGED = [
  'best-practice-check',
  'team-brief',
  'team-debug',
  'team-plan',
  'team-receiving-review-feedback',
  'team-retro',
  'team-ship',
  'team-tdd',
];

/** Mechanical, runtime-neutral substitutions (Claude → agents). */
export function transform(text) {
  return text
    .replace(/\.claude\/tmp/g, '.agents/tmp/bootstrap-workflow')
    // standalone CLAUDE.md → AGENTS.md/CLAUDE.md (not inside a path like ~/.claude/CLAUDE.md)
    .replace(/(?<![./\w])CLAUDE\.md/g, 'AGENTS.md/CLAUDE.md');
}

function main() {
  const check = process.argv.includes('--check');
  const stale = [];
  let wrote = 0;

  for (const skill of MANAGED) {
    const src = path.join(CLAUDE, skill, 'SKILL.md');
    const dst = path.join(AGENTS, skill, 'SKILL.md');
    if (!fs.existsSync(src)) {
      console.error(`sync-agent-skills: MISSING Claude source for managed skill '${skill}' (${src})`);
      process.exit(1);
    }
    const generated = transform(fs.readFileSync(src, 'utf8'));
    const current = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
    if (current !== generated) {
      stale.push(skill);
      if (!check) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, generated);
        wrote++;
      }
    }
  }

  if (check) {
    if (stale.length) {
      console.error(
        `sync-agent-skills: STALE managed skill(s) — run the generator:\n  ${stale.join('\n  ')}`,
      );
      process.exit(1);
    }
    console.log(`sync-agent-skills: ${MANAGED.length} managed skills in sync ✓ (9 hand-authored skills gated by parity-lint)`);
    return;
  }

  console.log(
    wrote > 0
      ? `sync-agent-skills: regenerated ${wrote} managed skill(s):\n  ${stale.join('\n  ')}`
      : `sync-agent-skills: ${MANAGED.length} managed skills already in sync ✓`,
  );
}

main();
