/**
 * OpenCode adapter — headless `opencode run --format json`.
 *
 * Two hard-won operational facts (see harness/README.md):
 *   1. A fresh XDG triggers a one-time SQLite migration ("may take a few
 *      minutes") that runs before the model and eats the timeout. We keep a
 *      WARM template (migrated once) and CLONE it per run.
 *   2. `--format json` buffers stdout until clean exit; a timeout-kill loses it.
 *      So we give the run room to exit cleanly (the warm template makes start
 *      instant) and only kill as a last-resort safety.
 *
 * env provisioning from target.env: auth.json, skill/ tree, agent/ defs, and an
 * `mcp` config block (OPENCODE_CONFIG_CONTENT). Empty env (the smoke target)
 * needs only auth.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sh, sqliteJson, sqliteExec, resolveSkillDir, PLUGINS } from '../lib.mjs';
import { emptyTranscript, researchToolKind } from '../transcript.mjs';

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.OPENCODE_EVAL_TEMPLATE || path.join(HARNESS_DIR, '.cache', 'opencode-template');
const NO_PROXY = '127.0.0.1,localhost,opencode.ai';

/** Ensure a warm (migrated) opencode XDG template exists; create once if not. */
async function ensureWarmTemplate(authPath) {
  const db = path.join(CACHE, 'opencode', 'opencode.db');
  if (fs.existsSync(db)) return CACHE;
  fs.mkdirSync(path.join(CACHE, 'opencode'), { recursive: true });
  fs.copyFileSync(authPath, path.join(CACHE, 'opencode', 'auth.json'));
  // Warm it: a trivial run drives the one-time migration to completion. Generous
  // ceiling — migration is the slow part and only happens here, once.
  await sh('opencode', ['run', '-m', 'opencode-go/kimi-k2.6', 'reply with: WARM'], {
    env: { ...process.env, XDG_DATA_HOME: CACHE, XDG_CONFIG_HOME: CACHE, NO_PROXY },
    timeoutMs: 600_000,
  });
  if (!fs.existsSync(db)) throw new Error('opencode template did not migrate (no opencode.db after warm run)');
  return CACHE;
}

/** Clone the warm template into a fresh per-run XDG and provision target.env. */
function provisionXdg(template, target) {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-run-'));
  fs.cpSync(template, xdg, { recursive: true });
  const ocDir = path.join(xdg, 'opencode');
  if (target.env.auth) fs.copyFileSync(target.env.auth, path.join(ocDir, 'auth.json'));
  // The warm template carries its OWN prior sessions (from migration/warm runs);
  // wipe them so the only session after this run is ours. normalizeFromDb keys on
  // the most-recent session, so a leftover template session would be misread as
  // the result. FK cascade (part→message→session) handles children.
  const db = path.join(ocDir, 'opencode.db');
  if (fs.existsSync(db)) {
    sqliteExec(db, 'PRAGMA foreign_keys=ON; DELETE FROM session; DELETE FROM message; DELETE FROM part;');
  }
  // IMPORTANT: do NOT write a `permission` key into opencode.json — an invalid
  // enum there makes `opencode run` hang indefinitely (verified: a run with no
  // config file completes and auto-executes tools via defaults; a run with
  // {"permission":"allow"} hangs to timeout). Only write a config file when we
  // have a real mcp block to inject, and even then no `permission` key.
  const mcp = mcpConfigObject(target.env.mcp);
  if (mcp) fs.writeFileSync(path.join(ocDir, 'opencode.json'), JSON.stringify({ mcp }));
  // skills: copy each declared skill dir (real files) into skill/
  if (target.env.skills?.length) {
    const skillRoot = path.join(ocDir, 'skill');
    fs.mkdirSync(skillRoot, { recursive: true });
    for (const s of target.env.skills) {
      const src = resolveSkillDir(s);
      if (src) fs.cpSync(src, path.join(skillRoot, path.basename(s)), { recursive: true, dereference: true });
    }
  }
  // subagents: copy agent .md defs into agent/
  if (target.env.subagents?.length) {
    const agentRoot = path.join(ocDir, 'agent');
    fs.mkdirSync(agentRoot, { recursive: true });
    for (const a of target.env.subagents) {
      const src = resolveAgentMd(a);
      if (src) fs.copyFileSync(src, path.join(agentRoot, `${a}.md`));
    }
  }
  return xdg;
}

// Skill/agent resolution from the bootstrap plugins tree (faithful to deployment).
// resolveSkillDir + PLUGINS are shared via lib.mjs (the runner uses them too).
function resolveAgentMd(name) {
  const d = path.join(PLUGINS, 'workflow', 'agents', `${name}.md`);
  return fs.existsSync(d) ? d : null;
}

/**
 * MCP server defs for OpenCode provisioning, sourced from `codex mcp list --json` — codex's
 * OWN fully-resolved view of ~/.codex/config.toml. We deliberately do NOT hand-parse TOML:
 * codex parses its own config correctly (multiline arrays, inline tables, every quoting form),
 * and shelling out to its resolved JSON is both more robust and keeps secrets (e.g. the exa
 * apiKey) out of committed source — they flow into an ephemeral per-run opencode.json that is
 * deleted after the run. Returns codex's server array, or [] when codex/the command isn't
 * available (callers treat an unresolvable declared server as ENV_ERROR).
 */
function readCodexMcpServers() {
  try {
    const out = execFileSync('codex', ['mcp', 'list', '--json'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Build the opencode `mcp` config object for target.env.mcp from codex's resolved server list
 * (`codex mcp list --json` shape: {name, transport:{type, command/args/env | url, ...}}), in
 * OpenCode's schema — local: {type:'local',command[],environment?,enabled}; remote:
 * {type:'remote',url,headers?,enabled} (the mapping NanoClaw's mcpServersToOpenCodeConfig
 * produces). Carries env (local) and resolved auth headers (remote) so a credentialed server
 * isn't silently provisioned unauthenticated. Returns null when no MCP is requested; throws if
 * a requested server can't be resolved (→ ENV_ERROR, never a silent half-provisioned env).
 */
export function mcpConfigObject(mcpNames, servers = readCodexMcpServers()) {
  if (!mcpNames?.length) return null;
  const byName = new Map((servers || []).map((s) => [s.name, s]));
  const out = {};
  for (const name of mcpNames) {
    const s = byName.get(name);
    if (!s) throw new Error(`mcp server "${name}" not resolvable from \`codex mcp list\``);
    // A configured-but-disabled server is not usable — surface it as ENV_ERROR rather than
    // provisioning a half-working env that fails at runtime.
    if (s.enabled === false) throw new Error(`mcp server "${name}" is disabled in codex config${s.disabled_reason ? ` (${s.disabled_reason})` : ''}`);
    const t = s.transport || {};
    if (t.type === 'stdio' && t.command) {
      const environment = { ...(t.env || {}) };
      // env_vars = names of parent-process vars to inherit; resolve to values for OpenCode.
      for (const v of t.env_vars || []) if (process.env[v] !== undefined) environment[v] = process.env[v];
      out[name] = { type: 'local', command: [t.command, ...(t.args ?? [])], ...(Object.keys(environment).length ? { environment } : {}), enabled: true };
    } else if (t.url) {
      // streamable_http / http transports
      const headers = { ...(t.http_headers || t.headers || {}) };
      // env_http_headers = header name → env-var name; resolve from this process's env.
      for (const [h, envVar] of Object.entries(t.env_http_headers || {})) if (process.env[envVar] !== undefined) headers[h] = process.env[envVar];
      if (t.bearer_token_env_var && process.env[t.bearer_token_env_var]) {
        headers['Authorization'] = `Bearer ${process.env[t.bearer_token_env_var]}`;
      }
      out[name] = { type: 'remote', url: t.url, ...(Object.keys(headers).length ? { headers } : {}), enabled: true };
    } else throw new Error(`mcp server "${name}" has no mappable transport in \`codex mcp list\``);
  }
  return out;
}

const adapter = {
  id: 'opencode',

  async preflight(target) {
    const missing = [];
    if (!target.env.auth || !fs.existsSync(target.env.auth)) missing.push('auth.json');
    // Verify every declared MCP server resolves from ~/.codex/config.toml now, so an
    // env gap surfaces as ENV_ERROR before we spend a run. Smoke declares none.
    if (target.env.mcp?.length) {
      try {
        mcpConfigObject(target.env.mcp);
      } catch (e) {
        missing.push(String(e.message || e));
      }
    }
    return { ok: missing.length === 0, missing, detail: missing.length ? 'env not provisionable' : 'ok' };
  },

  async run(target, { input, fixtureDir, timeoutMs }) {
    const template = await ensureWarmTemplate(target.env.auth);
    const xdg = provisionXdg(template, target);
    const t0 = Date.now();
    const env = { ...process.env, XDG_DATA_HOME: xdg, XDG_CONFIG_HOME: xdg, NO_PROXY };
    // --dir pins the working dir to the (small) fixture dir. Without it opencode
    // inits a file.watcher + VCS scan on whatever cwd it inherits — e.g. a huge
    // repo — which stalls startup. Default format (NOT --format json: that
    // buffers/hangs headless); stdout is only a fallback, the structured truth
    // is read from opencode.db.
    const cwd = fixtureDir && fs.existsSync(fixtureDir) ? fixtureDir : xdg;
    const args = ['run', '--dir', cwd, '-m', target.model, input];
    const { out, code, timedOut } = await sh('opencode', args, { env, timeoutMs });
    const dbPath = path.join(xdg, 'opencode', 'opencode.db');
    const transcript = normalizeFromDb(dbPath, out);
    transcript.durationMs = Date.now() - t0;
    transcript.exitOk = code === 0 && !!transcript.finalOutput && !timedOut;
    transcript.timedOut = !!timedOut;
    try {
      fs.rmSync(xdg, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    return transcript;
  },
};

/**
 * normalizeFromDb — read the run's session from opencode.db → NormalizedTranscript.
 * opencode persists every message + part (type text|reasoning|step-*|tool) and
 * subagents as child sessions (session.parent_id). This is the structured source
 * of truth (stdout/--format json are unreliable headless). Calibrated against the
 * real part.data schema (type/text/tool/state).
 */
export function normalizeFromDb(dbPath, stdoutFallback) {
  const t = emptyTranscript();
  const fallback = (stdoutFallback || '').trim();
  // Bind to the ROOT session (the lead), not the session of the most-recent part:
  // in swarm/parallel-review runs a child subagent can write last, and keying on the
  // latest part would read finalOutput / tool calls / subagent accounting from the
  // child's conversation instead of the lead's. The lead is the only parent-less
  // session (children carry parent_id); pick the root with the most recent activity.
  let sid;
  try {
    const r = sqliteJson(
      dbPath,
      `SELECT s.id AS id FROM session s WHERE s.parent_id IS NULL OR s.parent_id = '' ` +
        `ORDER BY (SELECT MAX(p.time_created) FROM part p WHERE p.session_id = s.id) DESC LIMIT 1`,
    );
    sid = r[0]?.id;
    // Fallback for older/edge schemas: if no root resolved, use the latest part's session.
    if (!sid) {
      const r2 = sqliteJson(dbPath, 'SELECT session_id FROM part ORDER BY time_created DESC LIMIT 1');
      sid = r2[0]?.session_id;
    }
  } catch {
    t.finalOutput = fallback;
    return t;
  }
  if (!sid) {
    t.finalOutput = fallback;
    return t;
  }
  const rows = sqliteJson(
    dbPath,
    `SELECT p.data AS pdata, m.data AS mdata FROM part p JOIN message m ON p.message_id = m.id WHERE p.session_id = '${sid}' ORDER BY p.time_created`,
  );
  const assistantText = [];
  for (const row of rows) {
    let pd;
    try {
      pd = JSON.parse(row.pdata);
    } catch {
      continue;
    }
    let role;
    try {
      role = JSON.parse(row.mdata).role;
    } catch {
      role = undefined;
    }
    t.events.push({ type: pd.type });
    if (pd.type === 'text' && role === 'assistant') {
      assistantText.push(pd.text || '');
    } else if (pd.type === 'tool') {
      const st = pd.state || {};
      const name = pd.tool || pd.name || st.tool || 'unknown';
      const ok = (st.status || pd.status) ? (st.status || pd.status) === 'completed' : true;
      const tc = { name, args: st.input ?? pd.input, result: st.output ?? pd.output, ok };
      t.toolCalls.push(tc);
      const kind = researchToolKind(name);
      if (kind) t.researchCalls.push({ tool: kind, ok });
    }
  }
  t.finalOutput = assistantText.join('').trim() || fallback;
  // subagents = child sessions spawned during this run. Parallelism is decided by execution-window
  // OVERLAP, not child count: a count-based flag (`kids.length > 1`) can't tell concurrent
  // (task background:true) fan-out from sequential one-then-next dispatch — both yield ≥2 children —
  // which makes the review-swarm `parallel` gate (score.mjs) unfalsifiable: it would pass even on a
  // fully sequential run. Two children whose [min,max] part-time windows intersect ⇒ parallel.
  try {
    const kids = sqliteJson(dbPath, `SELECT id, title FROM session WHERE parent_id = '${sid}'`);
    const parallel = childWindowsOverlap(dbPath, kids.map((k) => k.id));
    for (const k of kids) t.subagentSpawns.push({ role: k.title || 'subagent', parallel });
  } catch {
    /* no children */
  }
  return t;
}

/**
 * True iff any two child sessions' execution windows overlap in time — the signal that separates
 * concurrent (background) fan-out from sequential dispatch. Each window is
 * [MIN(part.time_created), MAX(part.time_created)] for that child; children with no parts are
 * skipped (no window to place). Classic interval sweep: sort by start, overlap iff some window
 * starts before the running max-end. Fewer than 2 placeable windows ⇒ not parallel.
 */
export function childWindowsOverlap(dbPath, childIds) {
  if (!childIds || childIds.length < 2) return false;
  const windows = [];
  for (const id of childIds) {
    const span = sqliteJson(dbPath, `SELECT MIN(time_created) AS lo, MAX(time_created) AS hi FROM part WHERE session_id = '${id}'`)[0];
    if (span && span.lo != null && span.hi != null) windows.push({ lo: Number(span.lo), hi: Number(span.hi) });
  }
  if (windows.length < 2) return false;
  windows.sort((a, b) => a.lo - b.lo);
  let maxHi = windows[0].hi;
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].lo < maxHi) return true; // starts before a prior window ended ⇒ overlap
    maxHi = Math.max(maxHi, windows[i].hi);
  }
  return false;
}

export default adapter;
