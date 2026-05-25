/**
 * Codex adapter — headless `codex exec --json`.
 *
 * Headless quirks (mirrors of opencode's): codex `exec` blocks reading stdin
 * unless it's closed (lib.sh uses stdio stdin:'ignore'), and refuses to run
 * outside a trusted git dir without `--skip-git-repo-check`. Auth + MCP
 * (exa/context7/deepwiki) are ambient via `~/.codex/config.toml`.
 *
 * Output: `--json` emits JSONL events to stdout (streams, unlike opencode's
 * buffered json); `-o <file>` writes the final assistant message. We normalize
 * the JSONL stream and use the -o file as the authoritative finalOutput.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sh } from '../lib.mjs';
import { emptyTranscript, researchToolKind, isSubagentTool } from '../transcript.mjs';

const adapter = {
  id: 'codex',

  async preflight(target) {
    const missing = [];
    const { out, err } = await sh('codex', ['login', 'status'], { timeoutMs: 20000 });
    // Accept either status form across codex versions — "Logged in using ChatGPT" or
    // "Authenticated: Yes" — and fail closed on the negatives ("Not logged in",
    // "Authenticated: No"), so neither the substring-of-negative nor a format change misreads.
    const blob = out + err;
    const positive = /\blogged in\b/i.test(blob) || /\bauthenticated:\s*yes\b/i.test(blob);
    const negative = /\bnot logged in\b/i.test(blob) || /\bauthenticated:\s*no\b/i.test(blob);
    if (!positive || negative) missing.push('codex login (run `codex login`)');
    // MCP is ambient via ~/.codex/config.toml; verify each declared server against codex's
    // OWN resolved list (`codex mcp list --json`) rather than grepping the TOML — codex parses
    // its own config (every quoting/table form), and an exact name match avoids substring
    // false-positives (`exa` ⊄ `exact`).
    if (target.env.mcp?.length) {
      let names = [];
      try {
        const out = execFileSync('codex', ['mcp', 'list', '--json'], {
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const arr = JSON.parse(out);
        // Only ENABLED servers count as available — a configured-but-disabled server would
        // otherwise pass preflight and fail at runtime, misattributed as a model/run issue.
        names = Array.isArray(arr) ? arr.filter((s) => s.enabled !== false).map((s) => s.name) : [];
      } catch {
        /* codex unavailable → all declared servers report missing below */
      }
      for (const m of target.env.mcp) if (!names.includes(m)) missing.push(`mcp:${m} (not enabled in \`codex mcp list\`)`);
    }
    return { ok: missing.length === 0, missing, detail: missing.length ? 'env not provisionable' : 'ok' };
  },

  async run(target, { input, fixtureDir, timeoutMs }) {
    const lastFile = path.join(os.tmpdir(), `codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const cwd = fixtureDir && fs.existsSync(fixtureDir) ? fixtureDir : os.tmpdir();
    const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', cwd, '-o', lastFile];
    if (target.model) args.push('-m', target.model);
    args.push(input);
    const t0 = Date.now();
    const { out, code, timedOut } = await sh('codex', args, { timeoutMs, env: { ...process.env } });
    let last = '';
    try {
      last = fs.readFileSync(lastFile, 'utf8').trim();
    } catch {
      /* fall back to stream */
    }
    const transcript = normalize(out, last);
    transcript.durationMs = Date.now() - t0;
    transcript.exitOk = code === 0 && !!transcript.finalOutput && !timedOut;
    transcript.timedOut = !!timedOut;
    try {
      fs.rmSync(lastFile, { force: true });
    } catch {
      /* ignore */
    }
    return transcript;
  },
};

/**
 * normalize(JSONL stdout, finalMessageFromOFile) → NormalizedTranscript.
 * CALIBRATED against real codex events: each line is {type, item?}. Payload is
 * in `item` (.msg is null). Relevant item.type values:
 *   command_execution → codex's shell tool (e.g. `cat file`): name=command,
 *                       result=aggregated_output, ok=exit_code===0
 *   mcp_tool_call     → an MCP tool (exa/context7/deepwiki/…): research/ classify
 *   agent_message     → assistant text (final output)
 *   collab_tool_call  → codex NATIVE in-session delegation (verified via probe):
 *                       tool="spawn_agent" carries the subagent `prompt` +
 *                       `receiver_thread_ids`; tool="wait" is the join. This is
 *                       codex's real subagent primitive — distinct from the
 *                       `spawn_task` container-MCP we translated AWAY from.
 *                       Parallel batch = ≥2 spawn_agent calls emitted back-to-back
 *                       before any non-spawn event (the wait that follows confirms
 *                       a fan-out/join). Note: a child agent's own tool calls run
 *                       in its OWN thread and do NOT surface in this parent stream.
 * We process item.completed (final state) to avoid double-counting started/completed.
 */
export function normalize(jsonl, lastMessage) {
  const t = emptyTranscript();
  const assistantText = [];
  // Parallel-run tracking: a contiguous run of ≥2 spawn_agent calls is a parallel
  // fan-out. Any other completed item ends the run.
  let spawnRun = 0;
  const flushSpawnRun = () => {
    if (spawnRun >= 2) {
      for (let k = t.subagentSpawns.length - spawnRun; k < t.subagentSpawns.length; k++) t.subagentSpawns[k].parallel = true;
    }
    spawnRun = 0;
  };
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const item = ev.item;
    t.events.push({ type: ev.type, itemType: item?.type });
    if (ev.type !== 'item.completed' || !item) continue;
    const isSpawn = item.type === 'collab_tool_call' && item.tool === 'spawn_agent';
    if (!isSpawn) flushSpawnRun();
    switch (item.type) {
      case 'command_execution': {
        const name = (item.command || 'command_execution').replace(/^\/bin\/bash\s+-lc\s+/, '').trim();
        // exit_code is authoritative when present (codex sets status:"failed" + a non-zero
        // exit_code on a failed command — verified against `codex exec --json`); fall back to
        // status only when no exit_code is reported.
        const ok = item.exit_code != null ? item.exit_code === 0 : item.status !== 'failed';
        t.toolCalls.push({ name, args: { command: item.command }, result: item.aggregated_output, ok });
        break;
      }
      case 'mcp_tool_call': {
        const name = item.tool || item.name || `${item.server || 'mcp'}.${item.method || ''}`;
        const ok = item.status ? item.status === 'completed' : true;
        t.toolCalls.push({ name, args: item.arguments ?? item.input, result: item.result ?? item.output, ok });
        const kind = researchToolKind(name);
        if (kind) t.researchCalls.push({ tool: kind, ok });
        if (isSubagentTool(name)) t.subagentSpawns.push({ role: name, parallel: false });
        break;
      }
      case 'collab_tool_call': {
        // spawn_agent = native delegation; wait/other = join points (not counted).
        if (item.tool === 'spawn_agent') {
          const role = String(item.prompt || 'agent').replace(/\s+/g, ' ').trim().slice(0, 80);
          t.subagentSpawns.push({ role, parallel: false });
          spawnRun++;
        }
        break;
      }
      case 'agent_message':
        if (item.text) assistantText.push(item.text);
        break;
      default:
        // other subagent-shaped item types (forward-compat with codex collab variants)
        if (item.type && isSubagentTool(item.type)) {
          t.subagentSpawns.push({ role: item.title || item.type, parallel: false });
        }
    }
  }
  flushSpawnRun();
  t.finalOutput = (lastMessage || '').trim() || assistantText.join('').trim();
  return t;
}

export default adapter;
