import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  claudeMarketplacePlugins,
  hooksForTool,
  resolveSessionStartText,
  resolveSkills,
  runHookCommand,
} from './plugin-enablement.mjs';

/**
 * BOTH-STATES PROOF for the orchestrate split.
 *
 * The operator wants to A/B test whether always pushing work to subagents hurts
 * quality. That experiment is only valid if DISABLING `bootstrap-orchestrate`
 * actually lets a session work directly — and three separate things had to move
 * together for that to be true: the skill, the standing SessionStart directive,
 * and the `dispatch-first` PreToolUse guard that BLOCKS a coordinator from
 * reading implementation source before dispatching.
 *
 * These tests do not grep for filenames. They resolve what a session is composed
 * of from the plugin manifests, then RUN the hook commands that composition
 * names, against a transcript that is one Read short of a dispatch-first block.
 * The disabled-state assertion is the load-bearing one, so it is checked in the
 * absence direction (no registered hook blocks the Read) and mutation-checked
 * below (re-registering the guard in bootstrap-workflow must make it fail).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = claudeMarketplacePlugins(REPO);
const WORKFLOW = PLUGINS.get('bootstrap-workflow');
const ORCHESTRATE = PLUGINS.get('bootstrap-orchestrate');

const ENABLED = [WORKFLOW, ORCHESTRATE];
const DISABLED = [WORKFLOW];

const TEAM_SKILLS = [
  'team-auto', 'team-build', 'team-debug', 'team-plan', 'team-retro', 'team-review', 'team-ship',
];

/** Env that lets the guard use its shipped thresholds rather than an operator override. */
const CLEAN_ENV = {
  BOOTSTRAP_DISPATCH_FIRST: '',
  BOOTSTRAP_DISPATCH_FIRST_WARN: '',
  BOOTSTRAP_DISPATCH_FIRST_BLOCK: '',
};

let seq = 0;

/**
 * A transcript of a Sonnet coordinator that has made `count` investigation Reads
 * this turn without dispatching. At count=8 the next Read is the 9th, which the
 * shipped guard blocks (dispatch-first-core.test.ts pins that threshold).
 */
function coordinatorTranscript(count, t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enablement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })];
  for (let i = 0; i < count; i += 1) {
    const id = `toolu_${(seq += 1)}`;
    lines.push(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/src/f${i}.ts` } }],
      },
    }));
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    }));
  }
  const file = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function readImplementationSource(transcriptPath) {
  return {
    session_id: 'enablement',
    cwd: '/tmp/enablement',
    hook_event_name: 'PreToolUse',
    transcript_path: transcriptPath,
    tool_name: 'Read',
    tool_input: { file_path: '/repo/src/next.ts' },
    tool_use_id: 'toolu_current',
  };
}

/** Run every PreToolUse hook a state registers for `toolName`, in order. */
function runAllHooks(pluginRoots, toolName, payload) {
  return hooksForTool(pluginRoots, toolName).map((hook) => ({
    plugin: hook.plugin,
    ...runHookCommand(hook.command, payload, CLEAN_ENV),
  }));
}

function blockedOne(results) {
  return results.find((r) => r.exitCode === 2 || /BLOCKED:|GATED:/.test(`${r.stdout}${r.stderr}`));
}

test('enabled: the orchestrate skill is offered alongside all seven team skills', () => {
  assert.deepEqual(resolveSkills(ENABLED), ['orchestrate', ...TEAM_SKILLS]);
});

test('disabled: every team skill still loads and orchestrate is gone', () => {
  assert.deepEqual(resolveSkills(DISABLED), TEAM_SKILLS);
});

test('enabled: the standing directive tells the session to load orchestrate', () => {
  const text = resolveSessionStartText(ENABLED);
  assert.match(text, /# Orchestrate — retained frontier owner \(always on\)/);
  assert.match(text, /For substantial work, load `orchestrate`/);
});

test('disabled: no standing directive reaches the session at all', () => {
  assert.equal(resolveSessionStartText(DISABLED).trim(), '');
});

test('enabled: a coordinator reading implementation source before dispatching is blocked', (t) => {
  const results = runAllHooks(ENABLED, 'Read', readImplementationSource(coordinatorTranscript(8, t)));
  const blocked = blockedOne(results);
  assert.ok(blocked, `expected a blocking hook, got ${JSON.stringify(results)}`);
  assert.equal(blocked.plugin, 'orchestrate');
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.stderr, /BLOCKED: dispatch-first — 9 investigation calls/);
});

test('enabled: the same coordinator is warned, not blocked, at the gate threshold', (t) => {
  const results = runAllHooks(ENABLED, 'Read', readImplementationSource(coordinatorTranscript(3, t)));
  assert.ok(results.every((r) => r.exitCode === 0), JSON.stringify(results));
  const warned = results.find((r) => /GATED: dispatch-first/.test(r.stdout));
  assert.ok(warned, `expected a dispatch-first warning, got ${JSON.stringify(results)}`);
});

test('disabled: NO registered hook stops that same coordinator from reading source', (t) => {
  // The load-bearing assertion. Absence of the guard is proved by running every
  // hook the disabled state actually registers, not by its filename being gone.
  const payload = readImplementationSource(coordinatorTranscript(8, t));
  const results = runAllHooks(DISABLED, 'Read', payload);
  assert.ok(results.length > 0, 'expected the retained safety guards to still be registered');
  assert.equal(blockedOne(results), undefined, JSON.stringify(results));
  for (const result of results) {
    assert.equal(result.exitCode, 0, `${result.plugin} exited ${result.exitCode}: ${result.stderr}`);
  }
});

test('disabled: a coordinator running a check is not gated either', (t) => {
  const transcript = coordinatorTranscript(8, t);
  const payload = {
    ...readImplementationSource(transcript),
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  };
  const results = runAllHooks(DISABLED, 'Bash', payload);
  assert.equal(blockedOne(results), undefined, JSON.stringify(results));
});

test('disabled: the destructive-command guard is untouched and still fires', () => {
  // Splitting orchestrate out must not take a safety guard with it.
  const results = runAllHooks(DISABLED, 'Bash', {
    session_id: 'enablement',
    cwd: '/tmp/enablement',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
  });
  assert.ok(blockedOne(results), `expected block-destructive to fire, got ${JSON.stringify(results)}`);
});

test('enabled: the guard composition matches the pre-split session exactly', () => {
  // "Enabled ⇒ behaviour unchanged" made concrete. This table is the PreToolUse
  // composition of bootstrap-workflow 5.4.0 at b491d97, the last commit before
  // the split, read off its single workflow-hooks.json. With both plugins
  // enabled the two-plugin composition must reproduce it guard-for-guard and in
  // the same order — that order is observable, since an earlier guard's decision
  // ends the chain.
  const PRE_SPLIT = {
    Read: ['guards/block-destructive.ts', 'guards/dispatch-first.ts'],
    Bash: ['guards/block-destructive.ts', 'guards/dispatch-first.ts'],
    Grep: ['guards/block-destructive.ts', 'guards/dispatch-first.ts'],
    Glob: ['guards/block-destructive.ts', 'guards/dispatch-first.ts'],
    WebFetch: ['guards/block-destructive.ts', 'guards/dispatch-first.ts'],
    Write: ['guards/block-destructive.ts', 'guards/file-protection.ts'],
    Edit: ['guards/block-destructive.ts', 'guards/file-protection.ts'],
    MultiEdit: ['guards/block-destructive.ts', 'guards/file-protection.ts'],
    AskUserQuestion: ['guards/block-destructive.ts', 'guards/block-askuser-during-auto.ts'],
    Agent: ['guards/block-destructive.ts'],
  };
  for (const [tool, expected] of Object.entries(PRE_SPLIT)) {
    const actual = hooksForTool(ENABLED, tool).map((hook) => hook.command.split(' ').at(-1));
    assert.deepEqual(actual, expected, `PreToolUse chain for ${tool}`);
  }

  const directive = resolveSessionStartText(ENABLED).trim();
  const canonical = fs.readFileSync(path.join(ORCHESTRATE, 'always-on.md'), 'utf8').trim();
  assert.equal(directive, canonical);

  const nanoclaw = fs.readFileSync(path.join(REPO, '.nanoclaw-always-on.md'), 'utf8');
  assert.ok(
    nanoclaw.startsWith(canonical),
    'the non-Claude providers\' copy must open with the same directive Claude receives',
  );
});

test('MUTATION: re-registering dispatch-first in bootstrap-workflow breaks the disabled state', (t) => {
  // The disabled-state assertion above shares no failure mode with the thing it
  // checks only if it can actually fail. Put the guard back where it used to
  // live and the "nothing blocks" claim must collapse.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enablement-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mutant = path.join(root, 'workflow');
  fs.cpSync(WORKFLOW, mutant, { recursive: true, dereference: true });
  // Re-vendor the guard into the mutant so the registration resolves, exactly as
  // it would if the split had left it behind.
  fs.cpSync(
    path.join(ORCHESTRATE, 'hooks', 'guards'),
    path.join(mutant, 'hooks', 'guards'),
    { recursive: true, force: true },
  );
  const manifestPath = path.join(mutant, 'hooks', 'workflow-hooks.json');
  const hooks = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  hooks.hooks.PreToolUse.push({
    matcher: 'Bash|Read|Grep|Glob|WebFetch',
    hooks: [{
      type: 'command',
      command: '${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh guards/dispatch-first.ts',
    }],
  });
  fs.writeFileSync(manifestPath, JSON.stringify(hooks, null, 2));

  const results = runAllHooks([mutant], 'Read', readImplementationSource(coordinatorTranscript(8, t)));
  const blocked = blockedOne(results);
  assert.ok(blocked, 'mutation did not reinstate the block — the disabled-state test would pass vacuously');
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.stderr, /BLOCKED: dispatch-first/);
});

test('MUTATION: restoring orchestrate to the workflow skills tree breaks the disabled state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enablement-skill-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mutant = path.join(root, 'workflow');
  fs.cpSync(WORKFLOW, mutant, { recursive: true, dereference: true });
  fs.cpSync(
    path.join(ORCHESTRATE, 'skills', 'orchestrate'),
    path.join(mutant, 'skills', 'orchestrate'),
    { recursive: true },
  );
  assert.ok(
    resolveSkills([mutant]).includes('orchestrate'),
    'mutation did not reinstate the skill — the disabled-state skill test would pass vacuously',
  );
});
