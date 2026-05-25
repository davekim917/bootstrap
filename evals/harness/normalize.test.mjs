import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalize as normalizeCodex } from './adapters/codex.mjs';
import { normalize as normalizeClaude } from './adapters/claude.mjs';
import { normalizeFromDb, mcpConfigObject, parseCodexMcpToml } from './adapters/opencode.mjs';
import { isReadTool } from './transcript.mjs';

// ── opencode: MCP config mapping (defs injected; mirrors NanoClaw's converter) ──
test('mcpConfigObject: url→remote, command+args→local, empty→null, unresolvable→throws', () => {
  const defs = {
    exa: { url: 'https://mcp.exa.ai/mcp?exaApiKey=secret' },
    deepwiki: { url: 'https://mcp.deepwiki.com/mcp' },
    context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  };
  assert.equal(mcpConfigObject([], defs), null);
  assert.equal(mcpConfigObject(undefined, defs), null);
  const cfg = mcpConfigObject(['exa', 'context7', 'deepwiki'], defs);
  assert.deepEqual(cfg.exa, { type: 'remote', url: 'https://mcp.exa.ai/mcp?exaApiKey=secret', enabled: true });
  assert.deepEqual(cfg.deepwiki, { type: 'remote', url: 'https://mcp.deepwiki.com/mcp', enabled: true });
  assert.deepEqual(cfg.context7, { type: 'local', command: ['npx', '-y', '@upstash/context7-mcp'], enabled: true });
  assert.throws(() => mcpConfigObject(['nonexistent'], defs), /not resolvable/);
});

test('mcpConfigObject: remote carries headers (literal + bearer resolved); local carries env', () => {
  process.env.TEST_MCP_TOKEN = 'sekret';
  try {
    const defs = {
      rem: { url: 'https://x', headers: { 'X-Api': 'lit' }, bearer_token_env_var: 'TEST_MCP_TOKEN' },
      loc: { command: 'npx', args: ['-y', 'pkg'], env: { FOO: 'bar' } },
    };
    const cfg = mcpConfigObject(['rem', 'loc'], defs);
    assert.deepEqual(cfg.rem, {
      type: 'remote',
      url: 'https://x',
      headers: { 'X-Api': 'lit', Authorization: 'Bearer sekret' },
      enabled: true,
    });
    assert.deepEqual(cfg.loc, { type: 'local', command: ['npx', '-y', 'pkg'], environment: { FOO: 'bar' }, enabled: true });
  } finally {
    delete process.env.TEST_MCP_TOKEN;
  }
});

test('parseCodexMcpToml: quoted keys, single-quoted args, nested env/headers tables', () => {
  const toml = [
    '[mcp_servers."context7"]', // quoted key
    "command = 'npx'", // single-quoted scalar
    "args = ['-y', '@upstash/context7-mcp']", // single-quoted TOML array (invalid JSON)
    '[mcp_servers.context7.env]', // nested env table (must not clear the server)
    'API_KEY = "k123"',
    '[mcp_servers.remote1]',
    'url = "https://r1"',
    '[mcp_servers.remote1.http_headers]',
    'X-Tenant = "acme"',
    '[other_section]', // unrelated section closes context
    'foo = "bar"',
  ].join('\n');
  const d = parseCodexMcpToml(toml);
  assert.deepEqual(d.context7.args, ['-y', '@upstash/context7-mcp']);
  assert.equal(d.context7.command, 'npx');
  assert.deepEqual(d.context7.env, { API_KEY: 'k123' });
  assert.equal(d.remote1.url, 'https://r1');
  assert.deepEqual(d.remote1.headers, { 'X-Tenant': 'acme' });
});

// ── codex: JSONL item events (shape from real `codex exec --json` capture) ──
test('codex normalize: command_execution → toolCall, agent_message → finalOutput', () => {
  const jsonl = [
    '{"type":"thread.started","msg":null}',
    '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/bash -lc \'cat smoke.txt\'","aggregated_output":"CONFIG_TOKEN=SMOKE\\n","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"SMOKE"}}',
    '{"type":"turn.completed"}',
  ].join('\n');
  const t = normalizeCodex(jsonl, '');
  assert.equal(t.toolCalls.length, 1);
  assert.equal(t.toolCalls[0].ok, true);
  assert.ok(isReadTool(t.toolCalls[0].name), 'codex shell read should classify as read');
  assert.equal(t.finalOutput, 'SMOKE');
});

test('codex normalize: -o lastMessage wins for finalOutput; mcp_tool_call classifies research', () => {
  const jsonl = '{"type":"item.completed","item":{"type":"mcp_tool_call","tool":"exa.web_search","status":"completed"}}';
  const t = normalizeCodex(jsonl, 'FINAL');
  assert.equal(t.finalOutput, 'FINAL');
  assert.deepEqual(t.researchCalls, [{ tool: 'exa', ok: true }]);
});

test('codex normalize: collab_tool_call spawn_agent ⇒ native subagents; back-to-back ⇒ parallel', () => {
  // Real shape captured from `codex exec --json` (spawn_agent ×2 then wait ×2).
  const jsonl = [
    '{"type":"item.started","item":{"id":"i0","type":"collab_tool_call","tool":"spawn_agent","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"i0","type":"collab_tool_call","tool":"spawn_agent","prompt":"Review for security issues","status":"completed"}}',
    '{"type":"item.completed","item":{"id":"i1","type":"collab_tool_call","tool":"spawn_agent","prompt":"Review for performance issues","status":"completed"}}',
    '{"type":"item.completed","item":{"id":"i2","type":"collab_tool_call","tool":"wait","status":"completed"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
  ].join('\n');
  const t = normalizeCodex(jsonl, '');
  assert.equal(t.subagentSpawns.length, 2, 'two spawn_agent calls ⇒ two subagents');
  assert.ok(t.subagentSpawns.every((s) => s.parallel), 'back-to-back spawns before wait ⇒ parallel');
  assert.equal(t.subagentSpawns[0].role, 'Review for security issues');
  // wait is a join point, not a tool/subagent
  assert.equal(t.toolCalls.length, 0);
});

test('codex normalize: a single spawn_agent is NOT marked parallel', () => {
  const jsonl = [
    '{"type":"item.completed","item":{"id":"i0","type":"collab_tool_call","tool":"spawn_agent","prompt":"solo","status":"completed"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
  ].join('\n');
  const t = normalizeCodex(jsonl, '');
  assert.equal(t.subagentSpawns.length, 1);
  assert.equal(t.subagentSpawns[0].parallel, false);
});

// ── claude: stream-json events (shape from real `claude -p --output-format stream-json`) ──
test('claude normalize: tool_use → toolCall, result event → finalOutput, is_error → ok:false', () => {
  const jsonl = [
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"x"}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","is_error":false}]}}',
    '{"type":"result","subtype":"success","result":"SMOKE"}',
  ].join('\n');
  const t = normalizeClaude(jsonl);
  assert.equal(t.toolCalls.length, 1);
  assert.equal(t.toolCalls[0].name, 'Read');
  assert.equal(t.toolCalls[0].ok, true);
  assert.equal(t.finalOutput, 'SMOKE');
});

test('claude normalize: two Task tool_use in ONE assistant msg ⇒ parallel subagents', () => {
  const jsonl =
    '{"type":"assistant","message":{"content":[' +
    '{"type":"tool_use","id":"a","name":"Task","input":{"subagent_type":"security-reviewer"}},' +
    '{"type":"tool_use","id":"b","name":"Task","input":{"subagent_type":"perf-reviewer"}}]}}';
  const t = normalizeClaude(jsonl);
  assert.equal(t.subagentSpawns.length, 2);
  assert.ok(t.subagentSpawns.every((s) => s.parallel), 'co-emitted Task calls are parallel');
});

// ── opencode: structured truth read from opencode.db (fixture db) ──
test('opencode normalizeFromDb: tool part → toolCall, text part → finalOutput', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-db-'));
  const db = path.join(dir, 'opencode.db');
  const sql = [
    'CREATE TABLE session(id TEXT, parent_id TEXT, title TEXT);',
    'CREATE TABLE message(id TEXT, session_id TEXT, data TEXT, time_created INTEGER);',
    'CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);',
    "INSERT INTO session VALUES('s1',NULL,'root');",
    `INSERT INTO message VALUES('m1','s1','{"role":"assistant"}',1);`,
    `INSERT INTO part VALUES('p1','m1','s1',1,'{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"x"},"output":"TOK"}}');`,
    `INSERT INTO part VALUES('p2','m1','s1',2,'{"type":"text","text":"answer"}');`,
  ].join('\n');
  execFileSync('sqlite3', [db], { input: sql });
  const t = normalizeFromDb(db, '');
  assert.equal(t.toolCalls.length, 1);
  assert.equal(t.toolCalls[0].name, 'read');
  assert.equal(t.toolCalls[0].ok, true);
  assert.equal(t.finalOutput, 'answer');
  fs.rmSync(dir, { recursive: true, force: true });
});
