// Shared by pick-dispatch.mjs (CLI, used from the /orchestrate skill on Codex) and
// hooks/route-spawn.mjs (Claude Code PreToolUse hook on every sub-agent spawn).
//
// Transport: keep an inherited API key or native HTTPS proxy (including a
// container's scoped OneCLI route). A plain host process with neither uses the
// already-approved default OneCLI agent for this one fixed-endpoint request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODEL = 'jev-1.13.0'; // pinned: thresholds are only meaningful against the model they were set on
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const ONECLI_TRANSPORT = 'ORCHESTRATE_ONECLI_TRANSPORT';
const MAX_TRANSPORT_OUTPUT = 1024 * 1024;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const here = path.dirname(fileURLToPath(import.meta.url));

function remainingMs(deadline) {
  return Math.max(1, deadline - Date.now());
}

function hasInheritedTransport(env) {
  if (env[ONECLI_TRANSPORT] === '1' || Boolean(env.TYPESAFE_API_KEY)) return true;
  const nativeProxy = env.NODE_USE_ENV_PROXY === '1'
    || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(env.NODE_OPTIONS ?? '');
  return nativeProxy && Boolean(env.HTTPS_PROXY || env.https_proxy);
}

function isContainerRuntime(env, existsSync) {
  // NanoClaw src/container-runner.ts:6620-6629 injects this on every container spawn.
  return Boolean(env.NANOCLAW_ASSISTANT_NAME)
    || ['/.dockerenv', '/run/.containerenv'].some((marker) => existsSync(marker));
}

function validateRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid TypeSafe request');
  if (body.model !== MODEL || typeof body.state?.task_brief !== 'string' || !body.questions?.dispatch) {
    throw new Error('invalid TypeSafe request');
  }
}

async function directRequest(body, deadline, { env = process.env, fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (env.TYPESAFE_API_KEY) headers.Authorization = `Bearer ${env.TYPESAFE_API_KEY}`;
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(remainingMs(deadline)),
    body: JSON.stringify(body),
  });
  if (!res || typeof res.ok !== 'boolean' || !Number.isInteger(res.status)) {
    throw new Error('invalid TypeSafe response');
  }
  if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}`);
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('invalid TypeSafe response');
  }
}

function killProcessGroup(child) {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function releaseChild(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch { /* best-effort handle release */ }
  }
  try { child.unref?.(); } catch { /* best-effort handle release */ }
}

function parseOnecliEnvelope(stdout) {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    let value;
    try {
      value = JSON.parse(line);
    } catch { continue; }
    if (value?.orchestrateOnecli !== 1) continue;
    if (typeof value.ok !== 'boolean' || !Number.isInteger(value.status)
      || value.status < 100 || value.status > 599 || typeof value.body !== 'string') break;
    if (!value.ok) throw new Error(`TypeSafe HTTP ${value.status}`);
    try {
      const parsed = JSON.parse(value.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) break;
      return parsed;
    } catch { break; }
  }
  throw new Error('invalid OneCLI transport response');
}

function onecliRequest(body, deadline, { env = process.env, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl('onecli', [
        'run', '--', process.execPath, fileURLToPath(import.meta.url), '--onecli-request',
      ], {
        detached: process.platform !== 'win32',
        env: { ...env, [ONECLI_TRANSPORT]: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new Error('OneCLI transport unavailable'));
      return;
    }

    let stdout = '';
    let outputTooLarge = false;
    let timedOut = false;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
      releaseChild(child);
      finish(new Error('TypeSafe request timed out'));
    }, remainingMs(deadline));

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      if (outputTooLarge) return;
      stdout += chunk;
      if (stdout.length > MAX_TRANSPORT_OUTPUT) {
        outputTooLarge = true;
        stdout = '';
        killProcessGroup(child);
        releaseChild(child);
        finish(new Error('invalid OneCLI transport response'));
      }
    });
    // Intentionally drain and discard diagnostics: they may describe proxy state.
    child.stderr?.resume();
    child.on('error', () => finish(new Error('OneCLI transport unavailable')));
    child.on('close', (code) => {
      if (timedOut) return finish(new Error('TypeSafe request timed out'));
      if (outputTooLarge) return finish(new Error('invalid OneCLI transport response'));
      if (code !== 0) return finish(new Error('OneCLI transport failed'));
      try { finish(null, parseOnecliEnvelope(stdout)); }
      catch (err) { finish(err); }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ body, deadline }));
  });
}

/** Deliver one fixed-endpoint TypeSafe request without exposing gateway state. */
export async function requestSystemOne(body, {
  timeoutMs = 8000,
  deadline = Date.now() + timeoutMs,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  existsSync = fs.existsSync,
} = {}) {
  validateRequestBody(body);
  if (hasInheritedTransport(env)) return directRequest(body, deadline, { env, fetchImpl });
  // A fleet container must never borrow the host's default OneCLI identity when
  // its scoped route is missing. It fails open to an unavailable pick instead.
  if (isContainerRuntime(env, existsSync)) throw new Error('OneCLI host transport unavailable in container');
  return onecliRequest(body, deadline, { env, spawnImpl });
}

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
export async function pick(task, runtime, {
  timeoutMs = 8000,
  rubric = loadRubric(),
  requestImpl = requestSystemOne,
} = {}) {
  const out = { rubric: rubric.version, mode: rubric.mode, runtime, decision: 'unavailable', pick: null };
  const started = Date.now();
  const deadline = started + timeoutMs;
  try {
    if (!task) throw new Error('empty task brief');
    const criteria = Object.fromEntries(Object.entries(rubric.options).map(([k, o]) => [k, o.criteria]));
    const response = await requestImpl({
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
    }, { deadline, timeoutMs });
    const a = response.answers?.dispatch;
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

async function runOnecliHelper() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (!Number.isInteger(input?.deadline) || input.deadline < 1) throw new Error();
    validateRequestBody(input.body);
    const headers = { 'Content-Type': 'application/json' };
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(remainingMs(input.deadline)),
      body: JSON.stringify(input.body),
    });
    const body = res.ok ? await res.text() : '';
    process.stdout.write(JSON.stringify({ orchestrateOnecli: 1, ok: res.ok, status: res.status, body }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ orchestrateOnecli: 1, ok: false, status: 0, body: '' }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && process.argv[2] === '--onecli-request') {
  await runOnecliHelper();
}
