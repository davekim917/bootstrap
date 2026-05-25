/**
 * Claude adapter — headless `claude -p --output-format stream-json`.
 *
 * stream-json requires `--verbose`. Tool approval is handled by `--allowedTools`
 * (auto-approves the named tools, no interactive prompt — avoids the
 * `--dangerously-skip-permissions` flag). Auth + MCP are ambient via Claude
 * Code (~/.claude). `--add-dir` grants tool access to the fixture dir.
 *
 * This is the parity BASELINE adapter (DESIGN.md baseline policy).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sh, hasBinary } from '../lib.mjs';
import { emptyTranscript, researchToolKind, isSubagentTool } from '../transcript.mjs';

// Default tools auto-approved for eval runs (override via target.env.allowedTools).
// Broad enough for review/QA skills (Read/Grep/Glob + Task subagents + research MCP);
// no Write/Edit by default since review is read-only.
const DEFAULT_ALLOWED = ['Read', 'Grep', 'Glob', 'Bash', 'Task', 'WebFetch', 'WebSearch'];

const adapter = {
  id: 'claude',

  async preflight(target) {
    const missing = [];
    if (!hasBinary('claude')) missing.push('claude CLI not on PATH');
    const creds = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(creds) && !process.env.ANTHROPIC_API_KEY) missing.push('claude auth (~/.claude/.credentials.json or ANTHROPIC_API_KEY)');
    // MCP is ambient via Claude Code config; declared tools are auto-approved at
    // run time via --allowedTools. Declared mcp can't be cheaply verified headless.
    const mcpNote = target.env.mcp?.length ? `mcp(ambient):${target.env.mcp.join(',')}` : 'no mcp';
    return { ok: missing.length === 0, missing, detail: missing.length ? 'env not provisionable' : mcpNote };
  },

  async run(target, { input, fixtureDir, timeoutMs }) {
    const cwd = fixtureDir && fs.existsSync(fixtureDir) ? fixtureDir : os.tmpdir();
    const allowed = (target.env.allowedTools?.length ? target.env.allowedTools : DEFAULT_ALLOWED).join(' ');
    const args = ['-p', input, '--output-format', 'stream-json', '--verbose', '--allowedTools', allowed, '--add-dir', cwd];
    if (target.model) args.push('--model', target.model);
    const t0 = Date.now();
    const { out, code, timedOut } = await sh('claude', args, { timeoutMs, cwd, env: { ...process.env } });
    const transcript = normalize(out);
    transcript.durationMs = Date.now() - t0;
    transcript.exitOk = code === 0 && !!transcript.finalOutput && !timedOut;
    transcript.timedOut = !!timedOut;
    return transcript;
  },
};

/**
 * normalize(stream-json JSONL) → NormalizedTranscript.
 * CALIBRATED against real claude stream-json: events have `type` ∈
 * system|assistant|user|result. `assistant`.message.content[] holds `text` and
 * `tool_use` ({name, input, id}) blocks; tool results return in `user`.message
 * .content[] as `tool_result` ({tool_use_id, is_error}); the final `result`
 * event carries {result: "<final text>"}. Claude parallelizes tool calls as
 * multiple tool_use blocks in ONE assistant message ⇒ parallel detection.
 */
export function normalize(jsonl) {
  const t = emptyTranscript();
  const lines = jsonl.split('\n').map((l) => l.trim()).filter(Boolean);
  const evs = [];
  for (const l of lines) {
    try {
      evs.push(JSON.parse(l));
    } catch {
      /* skip non-JSON */
    }
  }
  // pass 1: tool_result error flags (by tool_use_id)
  const errById = new Map();
  for (const ev of evs) {
    if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type === 'tool_result') errById.set(b.tool_use_id, !!b.is_error);
      }
    }
  }
  const assistantText = [];
  for (const ev of evs) {
    t.events.push({ type: ev.type });
    if (ev.type === 'result' && ev.result != null) {
      t.finalOutput = String(ev.result).trim();
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const taskUsesThisMsg = ev.message.content.filter((b) => b.type === 'tool_use' && isSubagentTool(b.name)).length;
      for (const b of ev.message.content) {
        if (b.type === 'text' && b.text) assistantText.push(b.text);
        else if (b.type === 'tool_use') {
          const ok = !errById.get(b.id);
          t.toolCalls.push({ name: b.name, args: b.input, ok });
          const kind = researchToolKind(b.name);
          if (kind) t.researchCalls.push({ tool: kind, ok });
          if (isSubagentTool(b.name)) {
            t.subagentSpawns.push({ role: b.input?.subagent_type || b.name, parallel: taskUsesThisMsg > 1 });
          }
        }
      }
    }
  }
  if (!t.finalOutput) t.finalOutput = assistantText.join('').trim();
  return t;
}

export default adapter;
