#!/usr/bin/env node
/**
 * The frontier-worker model/effort policy: one hand-edited source file, and the
 * renderers that turn it into every derived artifact.
 *
 * WHY THIS EXISTS. The policy used to be retyped in ~15 places across two repos
 * — agent frontmatter, a generated Codex role TOML, four copies of the worker
 * transport, a parity gate asserting the literal model ids, and NanoClaw's
 * vendored constants. Flipping it for an experiment meant editing all of them
 * and then updating the gates that pinned the old strings. Now the gates assert
 * `generated == source` instead of asserting literals, so a flip is: edit
 * plugins/workflow/worker-policy.json, run sync-agent-skills.mjs, commit.
 *
 * SCOPE. This governs the WORKER lane only. The cross-model REVIEW lane
 * (skills/shared/cross-model-review.md) pins its own models and efforts on
 * purpose — a reviewer is chosen for independence from the artifact's author,
 * not for the worker tier — so it is deliberately NOT derived from here.
 *
 * This module is side-effect-free on import: `loadWorkerPolicy` reads the JSON
 * lazily, so an installed marketplace cache (which materializes only the
 * plugin's own subtree and therefore has no plugins/workflow/) can still import
 * it. Same contract as codex-agent-toml.mjs, and the reason
 * install-agent-roles.test.mjs's shipped-module import scan stays green.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Repo-relative home of the one hand-edited policy file. */
export const POLICY_PATH = 'plugins/workflow/worker-policy.json';

/** Basename of the generated module that ships beside every frontier-worker.mjs. */
export const GENERATED_POLICY_BASENAME = 'worker-policy.generated.mjs';

/** Every plugin that ships a frontier-worker.mjs also ships the generated policy. */
export const POLICY_CONSUMER_PLUGINS = [
  'plugins/workflow',
  'plugins/workflow-agents',
  'plugins/orchestrate',
  'plugins/orchestrate-agents',
];

/**
 * The autonomous effort vocabulary, per runtime. Mirrors `EFFORTS` in
 * frontier-worker.mjs; duplicated here because validation must reject a typo in
 * the policy file BEFORE it is rendered into the transport that would then
 * reject it at dispatch time with a much worse message.
 */
const EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

export const RUNTIMES = ['claude', 'codex'];

function assert(condition, message) {
  if (!condition) throw new Error(`${POLICY_PATH}: ${message}`);
}

function validateTier(runtime, where, tier) {
  assert(tier && typeof tier === 'object', `${where} must be an object`);
  assert(typeof tier.label === 'string' && tier.label.trim().length > 0, `${where}.label must be a non-empty string`);
  assert(typeof tier.model === 'string' && tier.model.trim().length > 0, `${where}.model must be a non-empty string`);
  assert(Array.isArray(tier.modelAliases), `${where}.modelAliases must be an array (use [] for none)`);
  for (const alias of tier.modelAliases) {
    assert(typeof alias === 'string' && alias.trim().length > 0, `${where}.modelAliases entries must be non-empty strings`);
  }
  assert(
    EFFORTS[runtime].includes(tier.effort),
    `${where}.effort must be one of ${EFFORTS[runtime].join(', ')} (got ${JSON.stringify(tier.effort)})`,
  );
  // `ultra` is reachable only through an explicit, recorded human instruction
  // (frontier-worker.mjs --human-directed-ultra). A policy default of `ultra`
  // would make every dispatch fail that gate, so reject it at the source.
  assert(tier.effort !== 'ultra', `${where}.effort must not be ultra; ultra requires explicit human direction per dispatch`);
}

/** Every model id a tier answers to: the canonical one first, then its aliases. */
export const tierIds = (tier) => [tier.model, ...tier.modelAliases];

/** Parse + validate a policy object. Throws rather than defaulting. */
export function validateWorkerPolicy(policy) {
  assert(policy && typeof policy === 'object', 'must contain a JSON object');
  const seen = new Set();
  for (const runtime of RUNTIMES) {
    const entry = policy[runtime];
    assert(entry && typeof entry === 'object', `missing the \`${runtime}\` entry`);
    validateTier(runtime, runtime, entry);
    validateTier(runtime, `${runtime}.escalation`, entry.escalation);
    // One pass over every id of every tier. This also covers "the default and
    // escalation tiers name the same model", which is why there is no separate
    // check for it: a duplicate id would make defaultEffortFor ambiguous.
    for (const id of [...tierIds(entry), ...tierIds(entry.escalation)]) {
      assert(!seen.has(id), `model id ${id} appears in more than one tier`);
      seen.add(id);
    }
  }
  return policy;
}

/** Read and validate the policy from a repo checkout. */
export function loadWorkerPolicy(repoRoot) {
  const file = path.join(repoRoot, POLICY_PATH);
  if (!fs.existsSync(file)) throw new Error(`missing worker policy: ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${POLICY_PATH}: not valid JSON — ${error.message}`);
  }
  return validateWorkerPolicy(parsed);
}

const js = (value) => JSON.stringify(value);
const set = (ids) => `new Set([${ids.map(js).join(', ')}])`;

/**
 * The one-sentence statement of the policy, used verbatim in the transport's
 * `--help` and available to prose gates.
 */
export function policyHelpSentence(policy) {
  const { claude, codex } = policy;
  return (
    `Default workers: ${claude.label} / ${codex.label} at ${claude.effort} effort. `
    + `${claude.escalation.label} / ${codex.escalation.label} are the escalation via --model and default to `
    + `${claude.escalation.effort} effort, because escalating the model does not escalate the effort. `
    + `Approved worker floor: ${claude.escalation.label} or ${claude.label} on Claude; `
    + `${codex.escalation.label} or ${codex.label} on Codex.`
  );
}

/**
 * Render the generated module that ships beside each frontier-worker.mjs.
 *
 * The transport imports this rather than having its constants regex-patched:
 * a generated file is trivially diffable and cannot be half-edited, and the
 * hand-authored transport logic stays reviewable without a generator in the way.
 */
export function renderPolicyModule(policy) {
  const lines = [
    '// GENERATED by plugins/workflow-agents/scripts/sync-agent-skills.mjs from',
    `// ${POLICY_PATH}. Do not edit — edit the policy file and regenerate.`,
    '',
    'export const MODELS = {',
  ];
  for (const runtime of RUNTIMES) {
    const entry = policy[runtime];
    const allowed = [...tierIds(entry.escalation), ...tierIds(entry)];
    lines.push(`  ${runtime}: { default: ${js(entry.model)}, allowed: ${set(allowed)} },`);
  }
  lines.push(
    '};',
    '',
    '// The escalation tier. Selecting one of these buys judgment, not reasoning',
    '// depth, so its effort default stays at the escalation effort — the contract',
    '// forbids letting a model escalation silently escalate effort too. Explicit',
    '// --effort still wins.',
    `export const ESCALATION_MODELS = ${set(RUNTIMES.flatMap((r) => tierIds(policy[r].escalation)))};`,
    '',
    '/** Every known worker model id → its tier default effort. */',
    'export const DEFAULT_EFFORT_BY_MODEL = new Map([',
  );
  for (const runtime of RUNTIMES) {
    const entry = policy[runtime];
    for (const id of tierIds(entry)) lines.push(`  [${js(id)}, ${js(entry.effort)}],`);
    for (const id of tierIds(entry.escalation)) lines.push(`  [${js(id)}, ${js(entry.escalation.effort)}],`);
  }
  lines.push(
    ']);',
    '',
    '/**',
    ' * The tier default effort for a model. Callers validate the model against',
    ' * MODELS[runtime].allowed first, so an unknown id here is a generator bug,',
    ' * not user input — throw instead of guessing a default.',
    ' */',
    'export function defaultEffortFor(model) {',
    '  const effort = DEFAULT_EFFORT_BY_MODEL.get(model);',
    '  if (effort === undefined) throw new Error(`No policy effort for model: ${model}`);',
    '  return effort;',
    '}',
    '',
    '/** The policy in one sentence, for --help and for prose drift gates. */',
    `export const POLICY_HELP = ${js(policyHelpSentence(policy))};`,
    '',
  );
  return `${lines.join('\n')}`;
}

/**
 * The Claude agent def's trailing model claim. Codex's twin replaces this whole
 * sentence with its own (codex-agent-toml.mjs retargetRunsOnSentence), which is
 * why only the Claude half is written here.
 */
export const claudeRunsOnSentence = (policy) => `Runs on ${policy.claude.label} at ${policy.claude.effort} effort.`;

/**
 * Rewrite the policy-owned parts of the Claude worker agent def: the `model:`
 * and `effort:` frontmatter scalars, and the "Runs on X at Y effort." sentence
 * that closes `description:`. Everything else in the file is hand-authored.
 *
 * Deliberately narrow. The alternative — generating the whole def — would put a
 * 20-line behavioural instruction block inside a JS template literal, where it
 * stops being reviewable as prose.
 */
export function applyAgentDefPolicy(markdown, policy) {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error('agent def has no frontmatter block');
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) throw new Error('agent def has an unterminated frontmatter block');
  const frontmatter = normalized.slice(4, end);
  const rest = normalized.slice(end);

  const replaceScalar = (text, field, value) => {
    const pattern = new RegExp(`^(${field}:[ \\t]*)(\\S.*?)([ \\t]*)$`, 'm');
    if (!pattern.test(text)) throw new Error(`agent def has no \`${field}:\` frontmatter line`);
    return text.replace(pattern, `$1${value}`);
  };

  let updated = replaceScalar(frontmatter, 'model', policy.claude.model);
  updated = replaceScalar(updated, 'effort', policy.claude.effort);
  const description = /^description:[ \t]*(\S.*?)[ \t]*$/m.exec(updated);
  if (!description) throw new Error('agent def has no `description:` frontmatter line');
  const stripped = description[1].replace(/\s*Runs on [^\n]*\.\s*$/, '');
  updated = replaceScalar(updated, 'description', `${stripped} ${claudeRunsOnSentence(policy)}`);

  return `---\n${updated}${rest}`;
}

/**
 * Every model name and effort word the policy claims, for prose gates.
 *
 * The contract and always-on prose weave "Opus/Sol" and "Fable/Astra" through
 * whole paragraphs as adjectives; carving a generated block out of that would
 * mean rewriting the contract, so the prose stays hand-authored and this is what
 * the gate asserts it still mentions. It proves the prose names the CURRENT
 * roster — not that it contains no sentence contradicting it, which is review's
 * job (same limit as NanoClaw's scripts/dispatch-default-docs.test.ts).
 */
export function policyProseTokens(policy) {
  const short = (label) => label.replace(/^GPT-\d+(\.\d+)?\s+/, '').replace(/\s+\d+(\.\d+)*$/, '');
  return {
    labels: RUNTIMES.flatMap((r) => [policy[r].label, policy[r].escalation.label]),
    shortLabels: RUNTIMES.flatMap((r) => [short(policy[r].label), short(policy[r].escalation.label)]),
    efforts: [...new Set(RUNTIMES.flatMap((r) => [policy[r].effort, policy[r].escalation.effort]))],
    modelIds: RUNTIMES.flatMap((r) => [policy[r].model, policy[r].escalation.model]),
  };
}
