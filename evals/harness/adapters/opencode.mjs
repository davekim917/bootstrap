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
 * Read MCP server defs out of ~/.codex/config.toml (the host's single source of
 * truth for exa/context7/deepwiki — and where the exa apiKey lives). Sourcing from
 * there keeps secrets OUT of committed harness source: they flow into an ephemeral
 * per-run opencode.json that is deleted after the run. Minimal targeted TOML reader
 * for `[mcp_servers.<name>]` blocks (url | command + args); not a general parser.
 */
function readCodexMcpServers() {
  let toml = '';
  try {
    toml = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return {};
  }
  const out = {};
  let cur = null;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    const sec = line.match(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/);
    if (sec) {
      cur = sec[1];
      out[cur] = {};
      continue;
    }
    if (line.startsWith('[')) {
      cur = null;
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, valRaw] = kv;
    if (key === 'url' || key === 'command') out[cur][key] = valRaw.replace(/^["']|["']$/g, '');
    else if (key === 'args') {
      try {
        out[cur].args = JSON.parse(valRaw);
      } catch {
        /* leave unset */
      }
    }
  }
  return out;
}

/**
 * Build the opencode `mcp` config object for target.env.mcp, in OpenCode's schema
 * (remote: {type:'remote',url,enabled}; local: {type:'local',command[],enabled}) —
 * the same mapping NanoClaw's mcpServersToOpenCodeConfig produces. Returns null when
 * no MCP is requested; throws if a requested server can't be resolved (→ ENV_ERROR,
 * never a silent half-provisioned env).
 */
export function mcpConfigObject(mcpNames, defs = readCodexMcpServers()) {
  if (!mcpNames?.length) return null;
  const out = {};
  for (const name of mcpNames) {
    const d = defs[name];
    if (d?.url) out[name] = { type: 'remote', url: d.url, enabled: true };
    else if (d?.command) out[name] = { type: 'local', command: [d.command, ...(d.args ?? [])], enabled: true };
    else throw new Error(`mcp server "${name}" not resolvable from ~/.codex/config.toml`);
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
  let sid;
  try {
    const r = sqliteJson(dbPath, 'SELECT session_id FROM part ORDER BY time_created DESC LIMIT 1');
    sid = r[0]?.session_id;
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
  // subagents = child sessions spawned during this run (parallel heuristic: >1 ⇒ parallel)
  try {
    const kids = sqliteJson(dbPath, `SELECT title FROM session WHERE parent_id = '${sid}'`);
    for (const k of kids) t.subagentSpawns.push({ role: k.title || 'subagent', parallel: kids.length > 1 });
  } catch {
    /* no children */
  }
  return t;
}

export default adapter;
