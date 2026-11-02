// Used by hooks/route-spawn.mjs (Claude Code PreToolUse hook on every sub-agent spawn).
// Nothing here opens a connection: a spawn's model and effort are settled from the
// call and the session's own transcript.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Lower `effort` to `cap` when it is above it; unknown values pass through. */
export function capEffort(effort, cap) {
  const e = EFFORTS.indexOf(effort);
  const c = EFFORTS.indexOf(cap);
  return e > -1 && c > -1 && e > c ? cap : effort;
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

/** A spawn with no role of its own. */
export function isRoleless(type) {
  return !type || type === 'general-purpose';
}

/** A named role — neither roleless nor one of this plugin's effort shims. */
export function isNamedRole(type) {
  return !isRoleless(type) && !(typeof type === 'string' && SHIM.test(type));
}

/** The effort a Claude Agent call asks for: its `effort` field, else the level its shim type names. */
function callEffort(input) {
  if (EFFORTS.includes(input.effort)) return input.effort;
  return typeof input.subagent_type === 'string' ? input.subagent_type.match(SHIM)?.[1] : undefined;
}

/**
 * Claude Agent-tool input → the input to run, given which of the call's explicit
 * fields a human asked for (`pins`, from humanPins).
 *
 * A model the human did not name is dropped, so the spawn inherits its parent's.
 * The effort the call asks for stands; with none, the spawn runs at its native
 * default. With no model named the hook cannot see which model will run, so an
 * agent's own choice takes AGENT_MAX_EFFORT. Effort always leaves as the Agent
 * call's `effort` field: current Claude Code does not apply a shim's `effort`
 * frontmatter, so a shim type alone runs at the default level. A named role
 * (Explore, Plan, any custom or plugin agent) is never rewritten: Claude Code
 * gives a per-call `model` precedence over the role's own `model` frontmatter
 * (including `inherit`), and a role's effective definition can live where a hook
 * cannot see it (managed settings, `--agents`), so any filled model could
 * silently replace the role's installed intent
 * (code.claude.com/docs/en/sub-agents, "Choose a model"). The model-effort caps
 * apply either way. Returns null when nothing changes.
 */
export function rewriteClaudeSpawn(input, pins = {}) {
  const out = { ...input };
  const type = typeof input.subagent_type === 'string' ? input.subagent_type : '';
  const shim = SHIM.test(type);
  if (!isRoleless(type) && !shim) return null;

  if (out.model && !pins.model) delete out.model;
  let effort = callEffort(input);
  const cap = MODEL_MAX_EFFORT[familyOf(out.model)] ?? (pins.effort ? undefined : AGENT_MAX_EFFORT);
  if (effort && cap) effort = capEffort(effort, cap);
  if (effort) {
    out.effort = effort;
    if (shim) out.subagent_type = `bootstrap-orchestrate:worker-${effort}`;
  }

  const changed = ['model', 'effort', 'subagent_type'].some((k) => out[k] !== input[k]);
  return changed ? out : null;
}

/**
 * The model a sub-agent with no model of its own runs on: Claude Code's sub-agent override when one is set, else the
 * model of the session's latest reply in its transcript. Undefined when neither is known.
 */
export function inheritedModel(transcriptPath, env = process.env) {
  if (env.CLAUDE_CODE_SUBAGENT_MODEL) return env.CLAUDE_CODE_SUBAGENT_MODEL;
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return undefined;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"assistant"')) continue;
    try {
      const model = JSON.parse(lines[i])?.message?.model;
      if (typeof model === 'string' && model && !model.startsWith('<')) return model;
    } catch {
      // A torn line is skipped.
    }
  }
  return undefined;
}

/** What the spawning agent and its sub-agent are told when the model the agent asked for was dropped. */
export function droppedModelNotice(requested, running) {
  const runs = running ? `runs on ${running}` : "runs on this session's own model";
  const name = running ? `Name ${running}, not ${requested},` : `Don't name ${requested}`;
  return (
    `Model note: this sub-agent was requested on ${requested}, and that was dropped, so it ${runs}. ` +
    `Only a model a person names in their latest message applies. ${name} in anything that says which model did this work.`
  );
}

const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const MODEL_MAX_EFFORT = { fable: 'high', opus: 'xhigh' };
const AGENT_MAX_EFFORT = 'xhigh';

function familyOf(model) {
  return typeof model === 'string' ? MODEL_FAMILIES.find((f) => model.toLowerCase().includes(f)) : undefined;
}

const HARNESS_BLOCK = /<(task-notification|system|system-reminder|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g;
const ENVELOPE = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
const THREAD_CONTEXT = /<thread_context\b[^>]*>[\s\S]*?<\/thread_context>/g;
const QUOTED_MESSAGE = /<quoted_message\b[^>]*>[\s\S]*?<\/quoted_message>/g;
const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&amp;': '&' };

/**
 * Bodies of the runner envelopes in `text` that people sent to the agent, outside thread context it was not addressed
 * in, as the person wrote them: a quoted reply's original (often the agent's own text) is dropped and the runner's XML
 * escaping is undone.
 */
function addressedEnvelopes(text) {
  return [...text.replace(THREAD_CONTEXT, '').matchAll(ENVELOPE)]
    .filter(([, attrs]) => !/\bsender_id="system"|\bsender_is_bot="true"|\bfrom="unknown:agent:/.test(attrs))
    .map(([, , body]) => body.replace(QUOTED_MESSAGE, '').replace(/&(?:lt|gt|quot|amp);/g, (e) => XML_ENTITIES[e]));
}

/**
 * The human-written user turns of a Claude Code transcript, oldest first.
 * Skips tool results, skill loads (isMeta), sidechains, harness notices, and
 * turns left empty by that. On the host every remaining record is one turn.
 * In a NanoClaw session people only ever reach the agent as `<message>`
 * envelopes, so each envelope addressed to the agent is its own turn and
 * nothing else is: thread context the agent was not addressed in, system,
 * agent and bot senders, tasks and runner notices yield none. An unreadable transcript
 * has no turns.
 */
export function humanTurns(transcriptPath, { container = 'NANOCLAW_ASSISTANT_NAME' in process.env } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== 'user' || rec.isMeta || rec.isSidechain) continue;
    const content = rec.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (blocks.some((b) => b?.type === 'tool_result')) continue;
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .replace(HARNESS_BLOCK, '');
    const human = container ? addressedEnvelopes(text) : [text];
    for (const turn of human) if (turn.trim()) out.push(turn.trim());
  }
  return out;
}

const FAMILY = MODEL_FAMILIES.join('|');
const LEVEL = EFFORTS.join('|');
// The skill's two documented invocations; leading chat mentions (`@bot`) are allowed before the slash form, and the
// model token may carry a version (`claude-opus-5`).
const TOKEN_END = `(?=\\s|$|[.,;:!?)\\]]+(?:\\s|$))`;
const MODEL_TOKEN = `(?:claude-)?(${FAMILY})(?:-\\d+(?:\\.\\d+)*)*${TOKEN_END}`;
const EFFORT_TOKEN = `(${LEVEL})${TOKEN_END}`;
const SLASH_INVOCATION = new RegExp(`(?:^|\\n)[ \\t]*(?:@\\S+\\s+)*/orchestrate\\s+(?:${MODEL_TOKEN}\\s*)?(?:${EFFORT_TOKEN})?`, 'g');
const PROSE_INVOCATION = new RegExp(`\\buse\\s+an?\\s+${MODEL_TOKEN}\\s+sub-?agent(?:\\s+at\\s+${EFFORT_TOKEN})?`, 'g');
const NEGATED = /\b(?:not|never|cannot)\b|n't\b/;
const CLAUSE_BREAK = /[.!?;:\n\u2014]|,\s*(?:but|and|so|then|yet)\b/;
// Chat markup may wrap a mention: quotes, backticks, Slack bold/italic/strike, an ellipsis or a dash.
const MARKUP = `\\s"'\`*_~\u2026\u2014/,`;
const MODEL_MENTION = new RegExp(
  `(?<![a-z0-9-])(?:claude-)?(${FAMILY})(?:-\\d+(?:\\.\\d+)*)*(?:'s)?(?=[${MARKUP}]|$|[.,;:!?)\\]]+(?:[${MARKUP}]|$))`,
  'g',
);

/** The model families `t` names. */
function namedFamilies(t) {
  return new Set([...t.matchAll(MODEL_MENTION)].map((m) => m[1]));
}

/**
 * Which of a spawn's explicit fields (model, effort) a human chose in
 * `text`, the human's latest turn, so an earlier turn's choice does not carry
 * over. When the turn holds one of the skill's invocations, the latest one
 * alone decides both fields, except that one naming no model ("/orchestrate
 * have fable review it") takes the model from its task text by the plain-words
 * rule. Outside an invocation the model is pinned when the turn names the
 * family the spawn asks for ("I'd like fable to take a look"), one of several
 * included ("compare Opus and Sonnet"), since an unpinned model is dropped and
 * the comparison would run on one. Whether a mention is a request at all ("not opus", "a haiku") is the
 * coordinator's reading: the hook parses no wording beyond the invocations.
 * Effort is never read from plain wording ("failed at high effort").
 */
export function humanPins(input, text) {
  const t = text.toLowerCase().replace(/\u2019/g, "'").replace(/<command-name>\s*\/(?:bootstrap-orchestrate:)?(\S+?)\s*<\/command-name>[\s\S]*?<command-args>/g, '\n/$1 ');
  const family = familyOf(input.model);
  const effort = callEffort(input);
  const prose = [...t.matchAll(PROSE_INVOCATION)];
  const latest = [...t.matchAll(SLASH_INVOCATION), ...prose].sort((a, b) => b.index - a.index)[0];
  if (!latest) return { model: Boolean(family) && namedFamilies(t).has(family), effort: false };
  const negated = prose.includes(latest) && NEGATED.test(t.slice(0, latest.index).split(CLAUSE_BREAK).at(-1));
  if (negated) return { model: false, effort: false };
  const chosen = latest[1] ? new Set([latest[1]]) : namedFamilies(t.slice(latest.index + latest[0].length));
  return {
    model: Boolean(family) && chosen.has(family),
    effort: Boolean(effort) && latest?.[2] === effort,
  };
}
