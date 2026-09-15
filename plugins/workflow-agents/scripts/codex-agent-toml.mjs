#!/usr/bin/env node
/**
 * Render a Claude agent def (`plugins/workflow/agents/<name>.md`) as the Codex
 * named-role TOML Codex reads from `~/.codex/agents/<name>.toml`.
 *
 * Shape and field set match NanoClaw's `formatCodexAgentToml`
 * (nanoclaw `src/claude-agent-md.ts:159-177`), so the same role renders
 * identically whichever manager wrote it. The ONE deliberate difference is the
 * ownership marker on line 1: it names this plugin, so the two managers can
 * recognise their own output and neither overwrites the other's file.
 *
 * Dropped frontmatter, none of which has a Codex equivalent:
 *   model:   Claude vocabulary — replaced by the caller's `codexModel`
 *   effort:  Codex named roles have no per-role effort field. Effort comes from
 *            `[agents].default_subagent_reasoning_effort` and a native spawn's
 *            `reasoning_effort` overrides it per task; pinning it here would
 *            take that override away.
 *   tools / color / proactive: Claude-only.
 */
import { OWNERSHIP_MARKER } from './ownership.mjs';

/**
 * The one worker role, authored once as a Claude agent def and converted here
 * into the Codex named-role TOML. Only the model differs per provider: model
 * tier is provider-specific vocabulary; everything else is the same worker.
 * This constant lives in this side-effect-free module so parity-lint and
 * check-plugin-boundaries can read it without importing (and therefore running)
 * the sync script.
 *
 * The Codex model is deliberately NOT a constant here any more: it is
 * `codex.model` in plugins/workflow/worker-policy.json, reached through
 * `loadWorkerPolicy` in worker-policy.mjs. Callers pass it in as `codexModel`.
 */
export const WORKER_AGENT = 'worker-frontier';

/** TOML basic string (double-quoted, single line). */
export function tomlBasicString(value) {
  if (value.includes('\n')) throw new Error('Use tomlMultilineString for multi-line values');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * TOML multi-line basic string. Escapes backslashes first, then splits any
 * inner run of three quotes so it cannot be read as the closing delimiter.
 */
export function tomlMultilineString(value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"');
  return `"""\n${escaped}\n"""`;
}

/**
 * Swap the Claude-model claim that ends the description ("Runs on Opus 5 at
 * high effort.") for the Codex model the role actually runs, and say where its
 * effort comes from. Mirrors nanoclaw `src/claude-agent-md.ts:189-192`.
 */
export function retargetRunsOnSentence(description, model, effort) {
  const stripped = description.replace(/\s*Runs on [^\n]*\.\s*$/, '');
  return `${stripped} Runs on ${model} with ${effort} reasoning by default; explicit spawn effort overrides the default.`;
}

/** Split a Claude agent def into its frontmatter block and its body. */
export function parseAgentDef(markdown) {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error('agent def has no frontmatter block');
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) throw new Error('agent def has an unterminated frontmatter block');
  return {
    frontmatter: normalized.slice(4, end),
    body: normalized.slice(end + '\n---'.length).replace(/^\n+/, '').trimEnd(),
  };
}

/** One scalar out of a frontmatter block. Throws rather than defaulting. */
export function frontmatterScalar(frontmatter, field) {
  const match = new RegExp(`^${field}:[ \\t]*(\\S.*?)[ \\t]*$`, 'm').exec(frontmatter);
  if (!match) throw new Error(`agent def has no \`${field}:\` frontmatter line`);
  return match[1];
}

export function renderCodexAgentToml(markdown, codexModel, marker = OWNERSHIP_MARKER) {
  const { frontmatter, body } = parseAgentDef(markdown);
  const scalar = (field) => frontmatterScalar(frontmatter, field);
  const description = retargetRunsOnSentence(scalar('description'), codexModel, scalar('effort'));
  return [
    marker,
    '',
    `name = ${tomlBasicString(scalar('name'))}`,
    description.includes('\n')
      ? `description = ${tomlMultilineString(description)}`
      : `description = ${tomlBasicString(description)}`,
    `developer_instructions = ${tomlMultilineString(body)}`,
    `model = ${tomlBasicString(codexModel)}`,
    '',
  ].join('\n');
}
