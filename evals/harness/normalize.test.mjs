import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalize as normalizeCodex } from './adapters/codex.mjs';
import { normalize as normalizeClaude } from './adapters/claude.mjs';
import { normalizeFromDb, mcpConfigObject } from './adapters/opencode.mjs';
import { isReadTool } from './transcript.mjs';

// ── opencode: MCP config mapping from `codex mcp list --json` shape (servers injected) ──
test('mcpConfigObject: stdio→local, streamable_http→remote, empty→null, unresolvable→throws', () => {
  const servers = [
    { name: 'exa', transport: { type: 'streamable_http', url: 'https://mcp.exa.ai/mcp?exaApiKey=secret' } },
    { name: 'deepwiki', transport: { type: 'streamable_http', url: 'https://mcp.deepwiki.com/mcp' } },
    { name: 'context7', transport: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
  ];
  assert.equal(mcpConfigObject([], servers), null);
  assert.equal(mcpConfigObject(undefined, servers), null);
  const cfg = mcpConfigObject(['exa', 'context7', 'deepwiki'], servers);
  assert.deepEqual(cfg.exa, { type: 'remote', url: 'https://mcp.exa.ai/mcp?exaApiKey=secret', enabled: true });
  assert.deepEqual(cfg.deepwiki, { type: 'remote', url: 'https://mcp.deepwiki.com/mcp', enabled: true });
  assert.deepEqual(cfg.context7, { type: 'local', command: ['npx', '-y', '@upstash/context7-mcp'], enabled: true });
  assert.throws(() => mcpConfigObject(['nonexistent'], servers), /not resolvable/);
});

test('mcpConfigObject: remote resolves bearer + env_http_headers; stdio carries env + env_vars; disabled throws', () => {
  process.env.TEST_MCP_TOKEN = 'sekret';
  process.env.TEST_HDR = 'hval';
  process.env.TEST_EVAR = 'evalue';
  try {
    const servers = [
      {
        name: 'rem',
        transport: {
          type: 'streamable_http',
          url: 'https://x',
          http_headers: { 'X-Api': 'lit' },
          env_http_headers: { 'X-Env': 'TEST_HDR' }, // header name → env var name
          bearer_token_env_var: 'TEST_MCP_TOKEN',
        },
      },
      { name: 'loc', transport: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { FOO: 'bar' }, env_vars: ['TEST_EVAR'] } },
      { name: 'off', enabled: false, disabled_reason: 'turned off', transport: { type: 'stdio', command: 'x' } },
    ];
    const cfg = mcpConfigObject(['rem', 'loc'], servers);
    assert.deepEqual(cfg.rem, {
      type: 'remote',
      url: 'https://x',
      headers: { 'X-Api': 'lit', 'X-Env': 'hval', Authorization: 'Bearer sekret' },
      enabled: true,
    });
    assert.deepEqual(cfg.loc, {
      type: 'local',
      command: ['npx', '-y', 'pkg'],
      environment: { FOO: 'bar', TEST_EVAR: 'evalue' },
      enabled: true,
    });
    assert.throws(() => mcpConfigObject(['off'], servers), /disabled/);
  } finally {
    delete process.env.TEST_MCP_TOKEN;
    delete process.env.TEST_HDR;
    delete process.env.TEST_EVAR;
  }
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

test('codex normalize: failed command (status:failed, non-zero exit) ⇒ ok:false', () => {
  // Real shape captured from `codex exec --json` on a failing command: the item completes but
  // status flips to "failed" with a non-zero exit_code. Drift guard: even a hypothetical future
  // codex emitting status:"completed" alongside a non-zero exit must stay ok:false (exit wins).
  const jsonl = [
    '{"type":"item.completed","item":{"type":"command_execution","command":"ls /nope","aggregated_output":"No such file","exit_code":2,"status":"failed"}}',
    '{"type":"item.completed","item":{"type":"command_execution","command":"false","exit_code":1,"status":"completed"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
  ].join('\n');
  const t = normalizeCodex(jsonl, '');
  assert.equal(t.toolCalls.length, 2);
  assert.equal(t.toolCalls[0].ok, false, 'status:failed + exit 2 ⇒ ok:false');
  assert.equal(t.toolCalls[1].ok, false, 'non-zero exit is authoritative even if status:completed');
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

// parallelism is decided by child execution-window OVERLAP, not child count — so a sequential
// fan-out (≥2 children, disjoint windows) is NOT falsely marked parallel (would make the
// review-swarm `parallel` gate unfalsifiable).
test('opencode normalizeFromDb: overlapping child windows ⇒ parallel; disjoint ⇒ sequential', () => {
  const run = (childParts) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-par-'));
    const db = path.join(dir, 'opencode.db');
    const sql = [
      'CREATE TABLE session(id TEXT, parent_id TEXT, title TEXT);',
      'CREATE TABLE message(id TEXT, session_id TEXT, data TEXT, time_created INTEGER);',
      'CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);',
      "INSERT INTO session VALUES('s1',NULL,'root');",
      "INSERT INTO session VALUES('c1','s1','reviewer A');",
      "INSERT INTO session VALUES('c2','s1','reviewer B');",
      `INSERT INTO message VALUES('m1','s1','{"role":"assistant"}',1);`,
      `INSERT INTO part VALUES('p0','m1','s1',1,'{"type":"text","text":"done"}');`,
      ...childParts,
    ].join('\n');
    execFileSync('sqlite3', [db], { input: sql });
    const t = normalizeFromDb(db, '');
    fs.rmSync(dir, { recursive: true, force: true });
    return t;
  };
  // overlap: c1 window [100,300], c2 [200,400] — c2 starts before c1 ends
  const par = run([
    `INSERT INTO part VALUES('a1','mx','c1',100,'{"type":"text","text":"x"}');`,
    `INSERT INTO part VALUES('a2','mx','c1',300,'{"type":"text","text":"x"}');`,
    `INSERT INTO part VALUES('b1','mx','c2',200,'{"type":"text","text":"x"}');`,
    `INSERT INTO part VALUES('b2','mx','c2',400,'{"type":"text","text":"x"}');`,
  ]);
  assert.equal(par.subagentSpawns.length, 2);
  assert.ok(par.subagentSpawns.every((s) => s.parallel), 'overlapping child windows ⇒ parallel');
  // sequential: c1 [100,200], c2 [300,400] — disjoint, c2 starts after c1 ends
  const seq = run([
    `INSERT INTO part VALUES('a1','mx','c1',100,'{"type":"text","text":"x"}');`,
    `INSERT INTO part VALUES('a2','mx','c1',200,'{"type":"text","text":"x"}');`,
    `INSERT INTO part VALUES('b1','mx','c2',300,'{"type":"text","text":"x"}');`,
    `INSERT INTO part VALUES('b2','mx','c2',400,'{"type":"text","text":"x"}');`,
  ]);
  assert.equal(seq.subagentSpawns.length, 2);
  assert.ok(seq.subagentSpawns.every((s) => !s.parallel), 'disjoint child windows ⇒ NOT parallel');
});
