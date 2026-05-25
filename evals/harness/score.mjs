/**
 * Gate-ordered scoring over a normalized transcript (DESIGN.md "Score").
 *
 *   1. Absolute hard gates (primary)  — deterministic, ungameable, model-free.
 *   2. Semantic judge (secondary)     — judge.mjs, evidence-cited. (separate module)
 *   3. Baseline-relative parity (tert) — report.mjs, regression catch only.
 *
 * This module owns gate 1 + the verdict taxonomy. Hard gates are STRUCTURED
 * checks (no eval of prose) so they're safe and identical across runtimes.
 */
import { isReadTool, researchToolKind, isSubagentTool } from './transcript.mjs';

export const VERDICT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  ENV_ERROR: 'ENV_ERROR', // env gap caught by preflight — never model quality
  TIMEOUT: 'TIMEOUT', // infra outcome — never model quality
});

/**
 * Evaluate one structured hard-gate check against a normalized transcript.
 * Supported check types (extend as suites need; keep each safe + deterministic):
 *   { type:'tool_called', read:true }                  any file-read tool used
 *   { type:'tool_called', match:'<regex>' }            a tool whose name matches
 *   { type:'research_called', tool:'exa'|'context7'|'deepwiki' }
 *   { type:'subagents_spawned', min:N, parallel:true }
 *   { type:'output_contains', value:'...' }
 *   { type:'output_matches', regex:'...', flags:'i' }
 *   { type:'no_subagents' }                            asserts solo execution
 * @returns {{pass:boolean, detail:string}}
 */
export function evalCheck(check, t) {
  switch (check.type) {
    case 'tool_called': {
      const hit = t.toolCalls.some((tc) =>
        check.read ? isReadTool(tc.name) : new RegExp(check.match, 'i').test(tc.name),
      );
      return { pass: hit, detail: hit ? `tool matched` : `no toolCall matched ${check.read ? '(read)' : check.match}` };
    }
    case 'research_called': {
      const hit = t.researchCalls.some((r) => r.tool === check.tool);
      // belt-and-suspenders: also scan toolCalls in case an adapter under-populated researchCalls
      const alt = t.toolCalls.some((tc) => researchToolKind(tc.name) === check.tool);
      const ok = hit || alt;
      return { pass: ok, detail: ok ? `${check.tool} called` : `${check.tool} never called` };
    }
    case 'subagents_spawned': {
      const subs = t.subagentSpawns.length
        ? t.subagentSpawns
        : t.toolCalls.filter((tc) => isSubagentTool(tc.name)).map(() => ({ parallel: false }));
      let ok = subs.length >= (check.min ?? 1);
      if (ok && check.parallel) ok = subs.some((s) => s.parallel);
      return { pass: ok, detail: `${subs.length} subagent(s) spawned (need ${check.min ?? 1}${check.parallel ? ', parallel' : ''})` };
    }
    case 'no_subagents': {
      const n = t.subagentSpawns.length || t.toolCalls.filter((tc) => isSubagentTool(tc.name)).length;
      return { pass: n === 0, detail: n === 0 ? 'solo (no subagents)' : `${n} unexpected subagent(s)` };
    }
    case 'output_contains': {
      const ok = t.finalOutput.includes(check.value);
      return { pass: ok, detail: ok ? `output contains "${check.value}"` : `output missing "${check.value}"` };
    }
    case 'output_matches': {
      const ok = new RegExp(check.regex, check.flags ?? 'i').test(t.finalOutput);
      return { pass: ok, detail: ok ? `output matches /${check.regex}/` : `output does not match /${check.regex}/` };
    }
    default:
      throw new Error(`[score] unknown hard-gate check type: ${check.type}`);
  }
}

/**
 * Score one transcript against a case rubric's hard gates (gate 1 only).
 * Infra outcomes short-circuit: a timed-out / non-exiting run is never a
 * behavioral FAIL.
 * @returns {{verdict:string, gates:Array<{id,pass,detail}>}}
 */
export function scoreHardGates(rubric, t) {
  if (t.timedOut) return { verdict: VERDICT.TIMEOUT, gates: [] };
  if (!t.exitOk) return { verdict: VERDICT.TIMEOUT, gates: [], note: 'process did not exit cleanly with output' };

  const gates = (rubric.hardGates ?? []).map((g) => {
    const { pass, detail } = evalCheck(g.check, t);
    return { id: g.id, pass, detail };
  });
  const verdict = gates.every((g) => g.pass) ? VERDICT.PASS : VERDICT.FAIL;
  return { verdict, gates };
}
