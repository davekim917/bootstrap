// Shared by pick-dispatch.mjs (CLI, used from the /orchestrate skill on Codex) and
// hooks/route-spawn.mjs (Claude Code PreToolUse hook on every sub-agent spawn).
//
// Credentials: TYPESAFE_API_KEY if set; otherwise the request goes out with no
// Authorization header, for environments whose egress proxy injects it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'jev-1.13.0'; // pinned: thresholds are only meaningful against the model they were set on
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const here = path.dirname(fileURLToPath(import.meta.url));

export function loadRubric() {
  return JSON.parse(fs.readFileSync(path.join(here, '..', 'references', 'dispatch-rubric.json'), 'utf8'));
}

/** Lower `effort` to `cap` when it is above it; unknown values pass through. */
export function capEffort(effort, cap) {
  const e = EFFORTS.indexOf(effort);
  const c = EFFORTS.indexOf(cap);
  return e > -1 && c > -1 && e > c ? cap : effort;
}

/** The rubric tier a model name belongs to on this runtime, or undefined. */
export function tierOf(rubric, runtime, model) {
  return Object.values(rubric.tiers).find((t) => t[runtime] === model);
}

/**
 * Classify a task brief against the rubric. Never throws: every failure comes
 * back as { decision: 'unavailable', reason }.
 */
export async function pick(task, runtime, { timeoutMs = 8000, rubric = loadRubric() } = {}) {
  const out = { rubric: rubric.version, mode: rubric.mode, runtime, decision: 'unavailable', pick: null };
  const started = Date.now();
  try {
    if (!task) throw new Error('empty task brief');
    const criteria = Object.fromEntries(Object.entries(rubric.options).map(([k, o]) => [k, o.criteria]));
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.TYPESAFE_API_KEY) headers.Authorization = `Bearer ${process.env.TYPESAFE_API_KEY}`;
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: MODEL,
        state: { task_brief: task.slice(0, 20000) },
        questions: {
          dispatch: {
            type: 'choice',
            instructions:
              'Which option does `task_brief` call for? Judge only from what the brief itself says, not from guesses about how the work will go.',
            criteria,
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}`);
    const a = (await res.json()).answers?.dispatch;
    if (!a?.choice || !rubric.options[a.choice]) throw new Error('no usable answer');
    const ranked = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]);
    const resolve = (key) => {
      const o = rubric.options[key];
      if (!o?.tier) return { option: key };
      const tier = rubric.tiers[o.tier];
      // Caps are enforced here, not trusted to the data.
      return { option: key, model: tier[runtime], effort: capEffort(o.effort, tier.maxEffort) };
    };
    out.pick = resolve(a.choice);
    out.confidence = a.confidence;
    out.top2 = ranked.slice(0, 2).map(([k, p]) => ({ ...resolve(k), p: Number(p.toFixed(3)) }));
    out.decision = a.choice !== 'ask' && a.confidence >= rubric.thresholds.route ? 'route' : 'ask';
  } catch (err) {
    out.reason = err instanceof Error ? err.message : String(err);
  }
  out.latencyMs = Date.now() - started;
  return out;
}

function logPath() {
  if (process.env.ORCHESTRATE_DISPATCH_LOG) return process.env.ORCHESTRATE_DISPATCH_LOG;
  const home = os.homedir();
  const root = ['.claude', '.codex'].map((d) => path.join(home, d)).find((d) => fs.existsSync(d));
  return path.join(root ?? path.join(home, '.local', 'state'), 'orchestrate', 'dispatch-log.jsonl');
}

/** Best-effort append to the dispatch log; never throws. */
export function logDispatch(entry) {
  try {
    const p = logPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // The log is observability, never a reason to fail a dispatch.
  }
}

const SHIM = /^bootstrap-orchestrate:worker-(low|medium|high|xhigh|max)$/;

/**
 * Claude Agent-tool input → the input to run, given a pick (or null).
 *
 * Fills only what the spawn left out: `model` when absent; effort (expressed as
 * a `bootstrap-orchestrate:worker-<effort>` shim type, the only way the Agent
 * tool takes effort) only for a roleless spawn — no subagent_type or
 * `general-purpose`. A role type (Explore, Plan, any custom agent) keeps its
 * role and can only get a model. An explicit shim type keeps its effort. The
 * rubric caps apply to whatever results. Returns null when nothing changes.
 */
export function rewriteClaudeSpawn(input, picked, rubric) {
  const out = { ...input };
  const type = typeof input.subagent_type === 'string' ? input.subagent_type : '';
  const roleless = type === '' || type === 'general-purpose';
  const shim = type.match(SHIM);
  const route = picked?.decision === 'route' && picked.pick?.model ? picked.pick : null;

  if (!out.model && route) out.model = route.model;
  let effort = shim ? shim[1] : roleless && route ? route.effort : undefined;
  const tier = out.model ? tierOf(rubric, 'claude', out.model) : undefined;
  if (effort && tier) effort = capEffort(effort, tier.maxEffort);
  if (effort && (shim || roleless)) out.subagent_type = `bootstrap-orchestrate:worker-${effort}`;

  const changed = out.model !== input.model || out.subagent_type !== input.subagent_type;
  return changed ? out : null;
}
