import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  claudeMarketplacePlugins,
  hooksForTool,
  resolveAgents,
  resolveSessionStartText,
  resolveSkills,
  runHookCommand,
} from './plugin-enablement.mjs';

/**
 * COMPOSITION PROOF for the orchestrate plugin.
 *
 * Automatic delegation pressure is off fleet-wide. `/orchestrate` stays as an
 * INVOKE-ONLY skill, which means two things must be true of a session with
 * `bootstrap-orchestrate` ENABLED: it receives no standing directive telling it
 * to load the skill, and no registered hook stops it working directly — reading
 * implementation source, running a check, reaching a conclusion.
 *
 * Those are absence claims, and absence claims are the easy ones to pass
 * vacuously. So these tests do not grep for filenames. They resolve what a
 * session is composed of from the plugin manifests the way the host does, then
 * RUN every hook that composition names, against a transcript that would have
 * tripped the deleted dispatch-first guard at its blocking threshold. Each
 * absence is mutation-checked below: give the plugin a directive, or a blocking
 * PreToolUse hook, and the corresponding assertion must collapse.
 *
 * `wwbd` is the counterexample that keeps the machinery honest — it still ships
 * a standing directive, and its hook is RUN here and asserted to print it.
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

/** The five effort shims the orchestrate plugin ships, in sorted order. */
const WORKER_SHIMS = [
  'worker-high', 'worker-low', 'worker-max', 'worker-medium', 'worker-xhigh',
];

/**
 * Env the deleted guard read for its thresholds. Kept empty so a stray operator
 * override in the ambient environment cannot make an absence assertion pass for
 * the wrong reason.
 */
const CLEAN_ENV = {
  BOOTSTRAP_DISPATCH_FIRST: '',
  BOOTSTRAP_DISPATCH_FIRST_WARN: '',
  BOOTSTRAP_DISPATCH_FIRST_BLOCK: '',
};

let seq = 0;

/**
 * A transcript of a Sonnet coordinator that has made `count` investigation Reads
 * this turn without dispatching. count=8 makes the next Read the 9th — one past
 * the threshold the removed dispatch-first guard blocked at, so it is the
 * strongest case for "nothing gates direct work".
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

test('/orchestrate resolves as a skill on both the Claude and the Codex side', () => {
  // One directory, two manifests — the `wwbd` shape. There is no generated Codex
  // copy to keep in sync, so what has to hold is that BOTH manifests point at the
  // same tree and each runtime reads the skill through its own declaration. Read
  // each side the way its own runtime does.
  assert.ok(resolveSkills([ORCHESTRATE]).includes('orchestrate'));

  const codexManifest = JSON.parse(
    fs.readFileSync(path.join(ORCHESTRATE, '.codex-plugin', 'plugin.json'), 'utf8'),
  );
  const declared = codexManifest.skills;
  const roots = (Array.isArray(declared) ? declared : [declared]).map((rel) =>
    path.resolve(ORCHESTRATE, rel));
  const found = roots.flatMap((root) =>
    (fs.existsSync(root) ? fs.readdirSync(root) : [])
      .filter((entry) => fs.existsSync(path.join(root, entry, 'SKILL.md'))));
  assert.ok(found.includes('orchestrate'), `Codex side skills: ${found.join(', ')}`);

  const claudeManifest = JSON.parse(
    fs.readFileSync(path.join(ORCHESTRATE, '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  assert.equal(claudeManifest.name, codexManifest.name, 'one plugin name across both manifests');
  assert.equal(claudeManifest.version, codexManifest.version, 'one version across both manifests');
});

test('enabled: the five effort shims are the only sub-agents the plugin adds', () => {
  // The dispatch line in SKILL.md names `bootstrap-orchestrate:worker-<level>`.
  // A level with no definition behind it fails at dispatch time, in the middle of
  // someone's task, so the composed session is asserted to offer all five — and
  // nothing else, because a sixth definition here would be a role.
  assert.deepEqual(resolveAgents([ORCHESTRATE]), WORKER_SHIMS);
  assert.deepEqual(resolveAgents(ENABLED), WORKER_SHIMS);
});

test('disabled: no sub-agent definition survives without the orchestrate plugin', () => {
  // The workflow pair used to ship `worker-frontier`, so disabling orchestrate
  // still left a named worker behind. It does not any more: the roles went with
  // the policy, and the shims belong to the plugin that dispatches to them.
  assert.deepEqual(resolveAgents(DISABLED), []);
});

test('the orchestrate plugin registers no hooks and no standing directive, on either side', () => {
  // Invoke-only, asserted through the manifests rather than the file tree: a
  // hooks field is what a runtime acts on, and an unreferenced hooks file is
  // inert. Both are checked, because a declared-but-missing file and an
  // undeclared-but-present file fail differently.
  for (const [label, manifestPath] of [
    ['Claude', 'plugins/orchestrate/.claude-plugin/plugin.json'],
    ['Codex', 'plugins/orchestrate/.codex-plugin/plugin.json'],
  ]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, manifestPath), 'utf8'));
    assert.equal(manifest.hooks, undefined, `${label} manifest must declare no hooks`);
  }
  assert.ok(!fs.existsSync(path.join(REPO, 'plugins/orchestrate/hooks')), 'plugins/orchestrate/hooks must not exist');
  assert.ok(
    !fs.existsSync(path.join(REPO, 'plugins/orchestrate/always-on.md')),
    'plugins/orchestrate/always-on.md must not exist',
  );

  // And the composed session, resolved as the host would: enabling the plugin
  // adds no SessionStart output at all.
  assert.equal(resolveSessionStartText(ENABLED).trim(), '');
  assert.equal(resolveSessionStartText([ORCHESTRATE]).trim(), '');
});

test('enabled: NO registered hook stops a coordinator from reading source', (t) => {
  // The load-bearing assertion. Absence of the gate is proved by running every
  // hook the ENABLED state actually registers — orchestrate's and the workflow
  // plugin's together — not by a filename being gone.
  const results = runAllHooks(ENABLED, 'Read', readImplementationSource(coordinatorTranscript(8, t)));
  assert.ok(results.length > 0, 'expected the retained safety guards to still be registered');
  assert.equal(blockedOne(results), undefined, JSON.stringify(results));
  for (const result of results) {
    assert.equal(result.exitCode, 0, `${result.plugin} exited ${result.exitCode}: ${result.stderr}`);
  }
});

test('enabled: a coordinator running a check is not gated either', (t) => {
  const transcript = coordinatorTranscript(8, t);
  const payload = {
    ...readImplementationSource(transcript),
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  };
  const results = runAllHooks(ENABLED, 'Bash', payload);
  assert.equal(blockedOne(results), undefined, JSON.stringify(results));
});

test('enabled: the destructive-command guard is untouched and still fires', () => {
  // Removing the dispatch-first guard must not take a safety guard with it.
  const results = runAllHooks(ENABLED, 'Bash', {
    session_id: 'enablement',
    cwd: '/tmp/enablement',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
  });
  assert.ok(blockedOne(results), `expected block-destructive to fire, got ${JSON.stringify(results)}`);
});

test('an invoked team-* skill still loads a contract that mandates delegation', (t) => {
  // What was removed is AUTOMATIC pressure, and now also the named worker ROLE
  // and its model/effort policy. `/team-build` is still an explicit request for
  // the delegated workflow, so invoking it must still delegate — otherwise
  // dropping the role has quietly removed delegation altogether.
  const workflowSkills = resolveSkills(DISABLED);
  assert.ok(workflowSkills.includes('team-build'));

  const contract = path.join(WORKFLOW, 'skills', 'shared', 'workflow-contract.md');
  assert.ok(fs.existsSync(contract), 'team-* skills must still reach their shared contract');
  const text = fs.readFileSync(contract, 'utf8');
  assert.match(text, /Delegate substantive design, implementation/);

  // …and it must delegate to a plain sub-agent, not to a floor of approved
  // models. That floor is what the policy file encoded; a contract naming one
  // again would need a policy behind it that no longer exists.
  assert.doesNotMatch(text, /approved.{0,20}floor/i, 'the worker floor is retired');
  assert.doesNotMatch(text, /worker-frontier/, 'the named worker role is retired');

  // A mutation proof for the absence claims: the exact sentences that were
  // removed must still be detectable if someone puts them back.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enablement-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mutant = path.join(root, 'workflow-contract.md');
  fs.writeFileSync(mutant, `${text}\nNever delegate below the approved worker floor.\n`);
  const mutated = fs.readFileSync(mutant, 'utf8');
  assert.match(mutated, /approved.{0,20}floor/i, 'the floor assertion would pass vacuously');
});

test('enabled: the PreToolUse composition is the workflow plugin\'s safety guards and nothing else', () => {
  // The whole registered chain, tool by tool, with orchestrate enabled. Order is
  // observable — an earlier guard's decision ends the chain — so it is asserted
  // too. Every entry belongs to bootstrap-workflow: the orchestrate plugin
  // contributes no PreToolUse hook at all.
  const EXPECTED = {
    Read: ['guards/block-destructive.ts'],
    Bash: ['guards/block-destructive.ts'],
    Grep: ['guards/block-destructive.ts'],
    Glob: ['guards/block-destructive.ts'],
    WebFetch: ['guards/block-destructive.ts'],
    Write: ['guards/block-destructive.ts', 'guards/file-protection.ts'],
    Edit: ['guards/block-destructive.ts', 'guards/file-protection.ts'],
    MultiEdit: ['guards/block-destructive.ts', 'guards/file-protection.ts'],
    AskUserQuestion: ['guards/block-destructive.ts', 'guards/block-askuser-during-auto.ts'],
    Agent: ['guards/block-destructive.ts'],
  };
  for (const [tool, expected] of Object.entries(EXPECTED)) {
    const hooks = hooksForTool(ENABLED, tool);
    assert.deepEqual(
      hooks.map((hook) => hook.command.split(' ').at(-1)),
      expected,
      `PreToolUse chain for ${tool}`,
    );
    for (const hook of hooks) {
      assert.equal(hook.plugin, 'workflow', `${tool} hook must come from bootstrap-workflow`);
    }
  }
});

/**
 * wwbd still ships a standing directive, and it reaches Codex through ITS OWN
 * plugin's SessionStart hook with `${PLUGIN_ROOT}` bound to that plugin's root —
 * the Codex spelling of what Claude does with `${CLAUDE_PLUGIN_ROOT}`. Resolve
 * it from the Codex marketplace and manifest the way the host does, then RUN it.
 * Parsing the manifest is not enough: a command naming the wrong variable or the
 * wrong file still parses, and the failure only shows up as a session that
 * starts with no directive.
 */
function codexSessionStartCommands(pluginName) {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(REPO, '.agents/plugins/marketplace.json'), 'utf8'),
  );
  const entry = (marketplace.plugins ?? []).find((plugin) => plugin.name === pluginName);
  assert.ok(entry, `${pluginName} must be registered in .agents/plugins/marketplace.json`);
  const source = typeof entry.source === 'string' ? entry.source : entry.source?.path;
  const pluginRoot = path.resolve(REPO, source);
  const declared = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
  ).hooks;
  assert.equal(typeof declared, 'string', `${pluginName} Codex manifest must declare a hooks file`);
  const hookManifest = JSON.parse(fs.readFileSync(path.resolve(pluginRoot, declared), 'utf8'));
  return (hookManifest.hooks?.SessionStart ?? [])
    .flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.type === 'command' && typeof hook.command === 'string')
    .map((hook) => hook.command.replaceAll('${PLUGIN_ROOT}', pluginRoot));
}

test('wwbd: the Codex SessionStart hook prints the standing directive when run', () => {
  const commands = codexSessionStartCommands('wwbd');
  assert.ok(commands.length > 0, 'the Codex manifest must register a SessionStart command hook');
  const output = commands
    .map((command) => {
      const result = runHookCommand(command, '{}');
      assert.equal(result.exitCode, 0, `${command} exited ${result.exitCode}: ${result.stderr}`);
      return result.stdout;
    })
    .join('\n')
    .trim();
  const canonical = fs.readFileSync(path.join(REPO, 'plugins/wwbd/always-on.md'), 'utf8').trim();
  assert.ok(canonical.length > 0, 'plugins/wwbd/always-on.md must not be empty');
  assert.equal(output, canonical, 'the Codex session must receive exactly the directive wwbd ships');
});

test('no .nanoclaw-always-on.md anywhere: nothing host-specific lives in this repo', () => {
  // The host-specific marker was a side door: it fed Codex a directive the Codex
  // plugin never declared, so disabling that plugin left the directive live.
  const strays = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') walk(path.join(dir, entry.name));
      } else if (entry.name === '.nanoclaw-always-on.md') {
        strays.push(path.relative(REPO, path.join(dir, entry.name)));
      }
    }
  };
  walk(REPO);
  assert.deepEqual(strays, []);
});

/** A writable copy of the orchestrate plugin, for the mutation tests below. */
function orchestrateMutant(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `enablement-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mutant = path.join(root, 'orchestrate');
  fs.cpSync(ORCHESTRATE, mutant, { recursive: true, dereference: true });
  return mutant;
}

function setManifestHooks(mutant, hooksRelativePath, hooks) {
  const manifestPath = path.join(mutant, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.hooks = hooksRelativePath;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const hookManifestPath = path.join(mutant, hooksRelativePath);
  fs.mkdirSync(path.dirname(hookManifestPath), { recursive: true });
  fs.writeFileSync(hookManifestPath, JSON.stringify(hooks, null, 2));
}

test('MUTATION: giving orchestrate a SessionStart directive breaks the no-directive claim', (t) => {
  // The "no standing directive" assertion shares no failure mode with the thing
  // it checks only if it can actually fail. Put the directive back exactly as it
  // was shipped — an always-on.md plus the hook that cats it — and the composed
  // session must carry it again.
  const mutant = orchestrateMutant(t, 'directive-mutant');
  fs.writeFileSync(path.join(mutant, 'always-on.md'), '# Orchestrate\n\nLoad orchestrate.\n');
  setManifestHooks(mutant, 'hooks/orchestrate-hooks.json', {
    hooks: {
      SessionStart: [{
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'cat "${CLAUDE_PLUGIN_ROOT}/always-on.md"' }],
      }],
    },
  });
  assert.match(
    resolveSessionStartText([mutant]),
    /Load orchestrate\./,
    'mutation did not reinstate the directive — the no-directive test would pass vacuously',
  );
});

test('MUTATION: registering a blocking PreToolUse hook breaks the nothing-gates claim', (t) => {
  // Same argument for the gate. A hook that blocks a Read must be observable
  // through the same resolve-then-run path the absence assertion uses.
  const mutant = orchestrateMutant(t, 'gate-mutant');
  setManifestHooks(mutant, 'hooks/orchestrate-hooks.json', {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash|Read|Grep|Glob|WebFetch',
        hooks: [{
          type: 'command',
          command: 'echo "BLOCKED: dispatch-first" >&2; exit 2',
        }],
      }],
    },
  });
  const results = runAllHooks([mutant], 'Read', readImplementationSource(coordinatorTranscript(8, t)));
  const blocked = blockedOne(results);
  assert.ok(blocked, 'mutation did not reinstate a block — the nothing-gates test would pass vacuously');
  assert.equal(blocked.exitCode, 2);
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
