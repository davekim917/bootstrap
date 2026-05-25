/**
 * Normalized transcript — the cross-runtime contract.
 *
 * Per DESIGN.md "Normalized transcript", scoring NEVER reads raw adapter output.
 * Every adapter (opencode/codex/claude) emits this one shape; `assertConformant`
 * is the conformance gate (a non-conforming adapter is a hard failure, not a
 * silent bad verdict). The same behavior surfaces differently per runtime
 * (opencode nested agent event, claude `Task` tool call, codex native
 * delegation) — adapters use the classifiers here to map raw → normalized.
 */

/** @typedef {{name:string,args?:object,result?:any,ok:boolean}} ToolCall */
/** @typedef {{role:string,parentId?:string,parallel:boolean}} SubagentSpawn */
/** @typedef {{tool:'exa'|'context7'|'deepwiki',ok:boolean}} ResearchCall */
/**
 * @typedef {Object} NormalizedTranscript
 * @property {string}  finalOutput     final assistant text
 * @property {object[]} events         raw events, lightly tagged ({t,type,raw})
 * @property {ToolCall[]} toolCalls
 * @property {SubagentSpawn[]} subagentSpawns
 * @property {ResearchCall[]} researchCalls
 * @property {number}  durationMs
 * @property {boolean} exitOk          process exited 0 and produced output
 * @property {boolean} timedOut        killed by the run timeout
 */

const REQUIRED_KEYS = [
  'finalOutput',
  'events',
  'toolCalls',
  'subagentSpawns',
  'researchCalls',
  'durationMs',
  'exitOk',
  'timedOut',
];

/** Throw if `t` is not a conformant normalized transcript. Used as the adapter contract gate. */
export function assertConformant(t, adapterId = 'unknown') {
  const fail = (m) => {
    throw new Error(`[transcript] non-conformant transcript from adapter "${adapterId}": ${m}`);
  };
  if (!t || typeof t !== 'object') fail('not an object');
  for (const k of REQUIRED_KEYS) if (!(k in t)) fail(`missing key "${k}"`);
  if (typeof t.finalOutput !== 'string') fail('finalOutput must be a string');
  for (const k of ['events', 'toolCalls', 'subagentSpawns', 'researchCalls']) {
    if (!Array.isArray(t[k])) fail(`${k} must be an array`);
  }
  for (const tc of t.toolCalls) {
    if (typeof tc.name !== 'string' || typeof tc.ok !== 'boolean') fail('toolCall needs {name:string, ok:boolean}');
  }
  for (const s of t.subagentSpawns) {
    if (typeof s.role !== 'string' || typeof s.parallel !== 'boolean') fail('subagentSpawn needs {role:string, parallel:boolean}');
  }
  for (const r of t.researchCalls) {
    if (!['exa', 'context7', 'deepwiki'].includes(r.tool)) fail(`researchCall.tool invalid: ${r.tool}`);
  }
  if (typeof t.exitOk !== 'boolean' || typeof t.timedOut !== 'boolean') fail('exitOk/timedOut must be booleans');
  return t;
}

/** A blank conformant transcript adapters fill in. */
export function emptyTranscript() {
  return {
    finalOutput: '',
    events: [],
    toolCalls: [],
    subagentSpawns: [],
    researchCalls: [],
    durationMs: 0,
    exitOk: false,
    timedOut: false,
  };
}

// ── Cross-runtime tool-name classification ──────────────────────────────────
// Adapters call these so the same behavior normalizes identically regardless of
// each runtime's naming. Keep the patterns conservative and well-commented.

// Matches both dedicated read-tool names (opencode `read`, claude `Read`) AND
// shell read commands (codex runs `cat`/`head`/etc. via command_execution).
// \b boundaries catch "cat" inside "/bin/bash -lc 'cat smoke.txt'" without
// matching substrings like "concatenate" or "opencode".
const READ_RE = /\b(read|cat|head|tail|view|less|sed|grep|nl)\b|file.?read|read.?file/i;
const RESEARCH_PATTERNS = [
  { tool: 'exa', re: /exa|web_search/i },
  { tool: 'context7', re: /context7|resolve-library-id|query-docs/i },
  { tool: 'deepwiki', re: /deepwiki|read_wiki|ask_question/i },
];
// Subagent/delegation across runtimes: opencode `task`, claude `Task`/`Agent`,
// codex native delegation surfaces (`delegate`, `subagent`, `spawn` — NOT
// `spawn_task`, which is nanoclaw's container cross-agent MCP, intentionally
// excluded; see feedback_workflow_codex_native_delegation).
const SUBAGENT_RE = /(^|[._-])(task|agent|delegate|subagent)([._-]|$)/i;

export function isReadTool(name = '') {
  return READ_RE.test(name);
}

/** @returns {'exa'|'context7'|'deepwiki'|null} */
export function researchToolKind(name = '') {
  for (const p of RESEARCH_PATTERNS) if (p.re.test(name)) return p.tool;
  return null;
}

export function isSubagentTool(name = '') {
  return SUBAGENT_RE.test(name) && !/spawn_task/i.test(name);
}
