import { describe, it, expect } from 'bun:test';
import { isCoordinatorModel, isLogisticalToolUse } from './dispatch-first-core';

/**
 * DISPATCH-FIRST SCOPE CONTRACT.
 *
 * This slice used to live beside the destructive/email/file-protection manifest
 * in `plugins/workflow/hooks/guards/conformance.test.ts`. It moved here with the
 * guard itself when `/orchestrate` was split into its own plugin so the operator
 * can DISABLE automatic delegation pressure without losing the safety guards —
 * the two now version and ship independently, and a test left behind in the
 * workflow tree would have kept importing a module that is no longer there.
 *
 * What it pins is the guard's SCOPE, which is the part that decides whether the
 * operator can work directly at all:
 *   1. only coordinator-tier models are ever gated (builders are never touched),
 *   2. logistical calls are not counted toward the dispatch-first threshold.
 * Verdict thresholds and warn/block wording are pinned in
 * `dispatch-first-core.test.ts`; the Claude hook I/O in `dispatch-first.test.ts`.
 */

const COORDINATOR_MODELS = ['claude-sonnet-5', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra'];
const BUILDER_MODELS = ['claude-fable-5-1', 'claude-opus-5', 'gpt-6-astra', 'gpt-6-sol', 'claude-haiku-4-5-20251001'];

const DISPATCH_FIRST_LOGISTICAL: Array<[string, Record<string, unknown>]> = [
  ['Bash', { command: 'gh pr view 42 --json headRefOid' }],
  ['Bash', { command: 'gh api repos/o/r/pulls/42' }],
  ['Bash', { command: 'mkdir -p docs/specs/x' }],
  ['Bash', { command: 'git fetch origin' }],
  ['Bash', { command: 'ls -la' }],
  ['Read', { file_path: '/repo/docs/specs/x/plan.md' }],
  ['Read', { file_path: '/repo/docs/specs/x/run.md' }],
  ['Read', { file_path: '/repo/CLAUDE.md' }],
  ['Read', { file_path: '/repo/.claude/skills/orchestrate/SKILL.md' }],
];

const DISPATCH_FIRST_COUNTED: Array<[string, Record<string, unknown>]> = [
  ['Bash', { command: 'git show HEAD:src/app.ts' }],
  ['Bash', { command: 'curl https://svc/healthz' }],
  ['Bash', { command: 'ls && cat src/index.ts' }],
  ['Read', { file_path: '/repo/src/index.ts' }],
  ['Grep', { pattern: 'healthz' }],
  ['Glob', { pattern: 'src/**/*.ts' }],
  ['WebFetch', { url: 'https://svc/healthz' }],
];

describe('parity contract — dispatch-first', () => {
  for (const m of COORDINATOR_MODELS) {
    it(`gates coordinator: ${m}`, () => expect(isCoordinatorModel(m)).toBe(true));
  }
  for (const m of BUILDER_MODELS) {
    it(`never gates builder: ${m}`, () => expect(isCoordinatorModel(m)).toBe(false));
  }
  for (const [tool, input] of DISPATCH_FIRST_LOGISTICAL) {
    it(`logistical (not counted): ${tool} ${JSON.stringify(input)}`, () =>
      expect(isLogisticalToolUse(tool, input)).toBe(true));
  }
  for (const [tool, input] of DISPATCH_FIRST_COUNTED) {
    it(`counted: ${tool} ${JSON.stringify(input)}`, () =>
      expect(isLogisticalToolUse(tool, input)).toBe(false));
  }
});
