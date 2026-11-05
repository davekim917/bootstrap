// Used by hooks/revive-guard.mjs (Claude Code PreToolUse hook on SendMessage).
// Reads only this session's own sub-agent transcripts; opens no connection.
import fs from 'node:fs';
import path from 'node:path';

// Claude Code caches a sub-agent's prompt for one hour. Past that, the next
// message re-writes the helper's whole history at the cache-write price.
const CACHE_WINDOW_MS = 60 * 60 * 1000;
const TAIL_START_BYTES = 256 * 1024;
const TAIL_MAX_BYTES = 64 * 1024 * 1024;
const AGENT_ID = /^(?:agent-)?([A-Za-z0-9_-]+)$/;

/**
 * The transcript of the session's own sub-agent that a SendMessage `to` names, by agent id or by name
 * (the newest helper spawned under it), or undefined: a peer session, an unknown name, or no session.
 * Claude Code keeps a session's sub-agents at <session>/subagents/agent-<id>.jsonl beside <session>.jsonl,
 * each with an agent-<id>.meta.json that carries the `name` it was spawned with.
 */
export function helperTranscript(transcriptPath, to) {
  if (typeof transcriptPath !== 'string' || typeof to !== 'string') return undefined;
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  const id = AGENT_ID.exec(to)?.[1];
  if (id && fs.existsSync(path.join(dir, `agent-${id}.jsonl`))) return path.join(dir, `agent-${id}.jsonl`);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  let newest;
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue;
    const metaPath = path.join(dir, entry);
    try {
      if (JSON.parse(fs.readFileSync(metaPath, 'utf8'))?.name !== to) continue;
      const mtime = fs.statSync(metaPath).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { mtime, file: metaPath.replace(/\.meta\.json$/, '.jsonl') };
    } catch {
      // An unreadable meta names no one.
    }
  }
  return newest && fs.existsSync(newest.file) ? newest.file : undefined;
}

/** The names a person may use for a helper: its agent id and the name it was spawned with. */
export function helperAliases(file) {
  const id = path.basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
  try {
    const name = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))?.name;
    return typeof name === 'string' && name ? [id, name] : [id];
  } catch {
    return [id];
  }
}

/** The last user or assistant record of a transcript, read from its end; undefined when that record is torn. */
function lastTurnRecord(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    for (let want = TAIL_START_BYTES; ; want *= 2) {
      const len = Math.min(want, size, TAIL_MAX_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (len < size) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"type":"user"') && !lines[i].includes('"type":"assistant"')) continue;
        let rec;
        try {
          rec = JSON.parse(lines[i]);
        } catch {
          return undefined;
        }
        if (rec?.type === 'user' || rec?.type === 'assistant') return rec;
      }
      if (len >= size || len >= TAIL_MAX_BYTES) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Why a message to this helper would be a costly revive, or undefined when it is not: the helper's last record is
 * a final answer (`end_turn`) written more than the cache window ago. Anything else (a tool call, an incoming
 * message, a reply cut off mid-stream, a torn line) is not evidence the helper finished, so it is not stale.
 */
export function staleHelper(file, now = Date.now()) {
  const last = lastTurnRecord(file);
  if (last?.type !== 'assistant' || last.message?.stop_reason !== 'end_turn') return undefined;
  const idle = now - Date.parse(last.timestamp);
  if (!(idle > CACHE_WINDOW_MS)) return undefined;
  const u = last.message?.usage ?? {};
  return {
    idleMinutes: Math.round(idle / 60_000),
    contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  };
}

/** What the agent is told when its message to a stale helper is refused. */
export function staleHelperNotice(to, { idleMinutes, contextTokens }) {
  const size = contextTokens ? ` (~${Math.round(contextTokens / 1000)}k tokens)` : '';
  return (
    `Not sent: ${to} finished ${idleMinutes} minutes ago, past the one-hour prompt cache, so this message would ` +
    `re-write its whole history${size} at the cache-write price. Spawn a fresh one-shot helper with a ` +
    `self-contained brief instead: the task, what ${to} found, and the paths or artifacts it produced. If your ` +
    `workflow records owner handoffs, record this one. A person who names ${to} in their latest message can ` +
    `still have it resumed.`
  );
}
