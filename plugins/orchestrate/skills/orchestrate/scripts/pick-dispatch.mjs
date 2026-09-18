#!/usr/bin/env node
// Suggest a sub-agent model + effort for a task brief from references/dispatch-rubric.json.
//
//   echo "<task brief>" | node pick-dispatch.mjs --runtime claude|codex [--actual "<model> <effort>"]
//
// Prints one JSON object and always exits 0: a missing key, a network error or a
// bad answer yields decision "unavailable", and the caller carries on exactly as
// it would without this script. Each run is appended to a JSONL log so picks can
// be compared with what was actually dispatched.
//
// Credentials: TYPESAFE_API_KEY if set; otherwise the request goes out with no
// Authorization header, for environments whose egress proxy injects it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'jev-1.13.0'; // pinned: thresholds are only meaningful against the model they were set on
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function logPath() {
  if (process.env.ORCHESTRATE_DISPATCH_LOG) return process.env.ORCHESTRATE_DISPATCH_LOG;
  const home = os.homedir();
  const root = ['.claude', '.codex'].map((d) => path.join(home, d)).find((d) => fs.existsSync(d));
  return path.join(root ?? path.join(home, '.local', 'state'), 'orchestrate', 'dispatch-log.jsonl');
}

async function main() {
  const runtime = arg('runtime') === 'codex' ? 'codex' : 'claude';
  const actual = arg('actual') ?? null;
  const rubric = JSON.parse(fs.readFileSync(path.join(here, '..', 'references', 'dispatch-rubric.json'), 'utf8'));
  const task = fs.readFileSync(0, 'utf8').trim();
  const out = { rubric: rubric.version, mode: rubric.mode, runtime, actual, decision: 'unavailable', pick: null };
  const started = Date.now();
  try {
    if (!task) throw new Error('empty task brief on stdin');
    const criteria = Object.fromEntries(Object.entries(rubric.options).map(([k, o]) => [k, o.criteria]));
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.TYPESAFE_API_KEY) headers.Authorization = `Bearer ${process.env.TYPESAFE_API_KEY}`;
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(8000),
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
      // Caps are enforced here, not trusted to the data: never above the tier's max effort.
      const effort = EFFORTS[Math.min(EFFORTS.indexOf(o.effort), EFFORTS.indexOf(tier.maxEffort))];
      return { option: key, model: tier[runtime], effort };
    };
    out.pick = resolve(a.choice);
    out.confidence = a.confidence;
    out.top2 = ranked.slice(0, 2).map(([k, p]) => ({ ...resolve(k), p: Number(p.toFixed(3)) }));
    out.decision = a.choice !== 'ask' && a.confidence >= rubric.thresholds.route ? 'route' : 'ask';
  } catch (err) {
    out.reason = err instanceof Error ? err.message : String(err);
  }
  out.latencyMs = Date.now() - started;
  process.stdout.write(JSON.stringify(out) + '\n');
  try {
    const p = logPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), task: task.slice(0, 2000), ...out }) + '\n');
  } catch {
    // The log is best-effort; the pick on stdout is the contract.
  }
}

await main();
